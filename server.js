// Proxy addon: replaces Comet's BitTorrent streams with direct TorrServer HTTP links.

const express = require('express');
const app = express();

// Stremio Web runs on a different origin, so CORS headers are required.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 7100;

// Comet base URL including the config token, without /manifest.json.
// Example: http://host.docker.internal:8000/eyJkZWJyaWRTZXJ2aWNlIjoi...
const COMET_BASE_URL = process.env.COMET_BASE_URL;

// TorrServer address (the server itself, not behind a proxy).
const TORRSERVER_URL = process.env.TORRSERVER_URL || 'http://host.docker.internal:8090';

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

// Top N Comet results to resolve via TorrServer (each needs a network call).
const MAX_STREAMS = envInt('MAX_STREAMS', 8);

// Max wait for Comet's own search response. Comet's search can legitimately
// take up to ~90s on a cold/uncached title (see its own scrape timeouts), so
// this needs comfortable headroom above that rather than a "sensible" short default.
const COMET_TIMEOUT_MS = envInt('COMET_TIMEOUT_MS', 120000);

// An empty Comet reply that took longer than this came from a finished live
// scrape, not a placeholder — retrying would just repeat the whole scrape.
const COMET_RETRY_MAX_ELAPSED_MS = envInt('COMET_RETRY_MAX_ELAPSED_MS', 10000);

// Max wait for TorrServer's file list; falls back to a fileIdx+1 guess on timeout.
const RESOLVE_TIMEOUT_MS = envInt('RESOLVE_TIMEOUT_MS', 8000);
const RESOLVE_POLL_INTERVAL_MS = envInt('RESOLVE_POLL_INTERVAL_MS', 400);

// Cache resolved file lists per infoHash — avoids re-adding the torrent to
// TorrServer on every background prefetch of the next episode.
const RESOLVE_CACHE_TTL_MS = envInt('RESOLVE_CACHE_TTL_MS', 1800000); // 30 min
const fileListCache = new Map(); // infoHash -> { files, expiresAt }
const inFlightResolutions = new Map(); // infoHash -> Promise<files|null>, dedupes concurrent resolves

// Backstop for entries whose infoHash is never looked up again after expiry
// (getCachedFileList only evicts on read) — keeps the cache from growing forever.
setInterval(sweepFileListCache, RESOLVE_CACHE_TTL_MS).unref();

if (!COMET_BASE_URL) {
  console.error('COMET_BASE_URL is not set. See README.');
  process.exit(1);
}

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'org.local.comet.torrserver.bridge',
    version: '1.0.0',
    name: 'Comet via TorrServer',
    description: "Comet results played through TorrServer instead of Stremio's built-in torrent engine",
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: { configurable: false }
  });
});

app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  try {
    const cometUrl = `${COMET_BASE_URL}/stream/${type}/${encodeURIComponent(id)}.json`;

    // Comet may still be searching (placeholder-only), or Jackett may briefly
    // return 0 results — retry a few times instead of forcing a page reload.
    let startedAt = Date.now();
    let rawStreams = await fetchComet(cometUrl);
    for (const delayMs of [1000, 2000, 3000]) {
      const isEmptyOrPlaceholder = rawStreams.every(
        s => !s.infoHash && !(s.url || '').startsWith('magnet:')
      );
      if (!isEmptyOrPlaceholder) break;
      if (Date.now() - startedAt > COMET_RETRY_MAX_ELAPSED_MS) break;
      await new Promise(r => setTimeout(r, delayMs));
      startedAt = Date.now();
      rawStreams = await fetchComet(cometUrl);
    }

    // Debug: raw stream shape from Comet (no url — may carry a debrid token).
    // See: docker logs -f comet-torrserver-bridge
    console.log(`Comet streams [${type}/${id}]:`, JSON.stringify(
      rawStreams.map(s => ({ name: s.name, infoHash: s.infoHash, fileIdx: s.fileIdx, sources: s.sources })),
      null, 2
    ));

    // Sort before truncating, so the top N are the best, not just the first.
    const sorted = sortStreams(rawStreams).slice(0, MAX_STREAMS);

    // Comet's fileIdx follows the .torrent's internal file order, but
    // TorrServer sorts its file list differently — matching by index alone
    // can pick the wrong episode. Resolve the file by name instead; fall
    // back to fileIdx+1 if TorrServer doesn't respond in time.
    // allSettled so one bad candidate doesn't wipe out the rest.
    const settled = await Promise.allSettled(sorted.map(resolveViaTorrServer));
    for (const r of settled) {
      if (r.status === 'rejected') console.error('resolveViaTorrServer failed:', r.reason);
    }
    const streams = settled
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    res.json({ streams });
  } catch (e) {
    console.error(e);
    res.json({ streams: [] });
  }
});

async function fetchComet(cometUrl) {
  let cometRes;
  try {
    cometRes = await fetch(cometUrl, { signal: AbortSignal.timeout(COMET_TIMEOUT_MS) });
  } catch (e) {
    console.error('Comet request failed:', e.message);
    return [];
  }
  if (!cometRes.ok) {
    console.error('Comet responded', cometRes.status);
    return [];
  }
  const cometData = await cometRes.json();
  return cometData.streams || [];
}

// Comet (unconfigured) doesn't sort by seeders, and seeders/size alone aren't
// reliable (e.g. REMUX often outweighs WEB-DL of a higher resolution). Group
// by resolution first, then sort by seeders, then size as a tiebreaker.
function extractResolution(name) {
  const m = (name || '').match(/(\d{3,4})p/);
  return m ? parseInt(m[1], 10) : 0;
}

function extractSeeders(description) {
  const m = (description || '').match(/\u{1F464}\s*(\d+)/u); // 👤 N
  return m ? parseInt(m[1], 10) : 0;
}

function sortStreams(streams) {
  return [...streams].sort((a, b) => {
    const resDiff = extractResolution(b.name) - extractResolution(a.name);
    if (resDiff !== 0) return resDiff;

    const seedersDiff = extractSeeders(b.description) - extractSeeders(a.description);
    if (seedersDiff !== 0) return seedersDiff;

    const sizeA = (a.behaviorHints && a.behaviorHints.videoSize) || 0;
    const sizeB = (b.behaviorHints && b.behaviorHints.videoSize) || 0;
    return sizeB - sizeA;
  });
}

// Stremio's stream card truncates descriptions past 4 lines. Comet's extra
// codec/HDR line can push it to 5, so merge it into the quality line.
function compactDescription(description) {
  if (!description) return description;
  const lines = description.split('\n');

  while (lines.length > 4) {
    const codecIdx = lines.findIndex(l => l.startsWith('\u{1F4F9}')); // 📹
    if (codecIdx === -1) break;

    if (codecIdx + 1 < lines.length) {
      lines[codecIdx + 1] = `${lines[codecIdx]} | ${lines[codecIdx + 1]}`;
    } else {
      lines[codecIdx - 1] = `${lines[codecIdx - 1]} | ${lines[codecIdx]}`;
    }
    lines.splice(codecIdx, 1);
  }
  return lines.join('\n');
}

async function resolveViaTorrServer(stream) {
  const hints = stream.behaviorHints || {};

  // Comet can also return an already-resolved direct-play link (e.g. a
  // cached debrid hit) instead of a torrent — nothing to resolve here.
  if (!stream.infoHash && stream.url && !stream.url.startsWith('magnet:') && hints.filename) {
    return {
      url: stream.url,
      name: stream.name || 'Comet',
      description: compactDescription(stream.description || stream.title || ''),
      behaviorHints: {
        notWebReady: false,
        bingeGroup: hints.bingeGroup,
        filename: hints.filename,
        videoSize: hints.videoSize
      }
    };
  }

  const link = buildLink(stream);
  if (!link) return null;

  // Comet puts the real filename in behaviorHints.filename, not name/title.
  const realFilename = hints.filename || stream.title || stream.name || 'video';
  const filename = encodeURIComponent(realFilename.replace(/[\\/]/g, '_'));

  const params = new URLSearchParams({ link, play: '' });
  let indexUnverified = false;

  if (stream.fileIdx != null) {
    const rawInfoHash = stream.infoHash || extractInfoHashFromMagnet(link);
    const infoHash = rawInfoHash ? rawInfoHash.toLowerCase() : null;
    const resolvedId = infoHash
      ? await resolveFileIndex(link, infoHash, realFilename, hints.videoSize)
      : null;

    if (resolvedId != null) {
      // Assumes file_stats[].id from TorrServer's own file list is already
      // the index base its /stream?index= param expects.
      params.set('index', String(resolvedId));
    } else {
      // Couldn't resolve via TorrServer in time — fall back to the fileIdx
      // guess (correct only if episodes are stored in order in the .torrent).
      console.warn(
        `resolveFileIndex: could not determine index for "${realFilename}" (hash=${infoHash}), falling back to fileIdx+1`
      );
      params.set('index', String(stream.fileIdx + 1));
      indexUnverified = true;
    }
  }

  const playUrl = `${TORRSERVER_URL}/stream/${filename}?${params.toString()}`;
  const name = stream.name ? `${stream.name} [TS]` : 'TorrServer';

  return {
    url: playUrl,
    name: indexUnverified ? `${name} [unverified]` : name,
    // Comet's description carries quality/size/seeders/indexer (title is empty).
    description: compactDescription(stream.description || stream.title || 'TorrServer stream'),
    behaviorHints: {
      notWebReady: false,
      bingeGroup: hints.bingeGroup,
      filename: hints.filename,
      videoSize: hints.videoSize
    }
  };
}

function extractInfoHashFromMagnet(link) {
  const m = /xt=urn:btih:([a-fA-F0-9]{40}|[A-Za-z2-7]{32})/.exec(link);
  return m ? m[1].toLowerCase() : null;
}

// Asks TorrServer for the torrent's real (sorted) file list and matches by
// name — TorrServer's file order doesn't match Comet's fileIdx.
async function resolveFileIndex(link, infoHash, expectedFilename, expectedSize) {
  const cached = getCachedFileList(infoHash);
  if (cached) return findFileId(cached, expectedFilename, expectedSize);

  // Concurrent callers for the same infoHash (e.g. two episodes from the
  // same season-pack torrent) share one in-flight add+poll instead of racing.
  let filesPromise = inFlightResolutions.get(infoHash);
  if (!filesPromise) {
    filesPromise = fetchTorrServerFiles(link, infoHash).finally(() => {
      inFlightResolutions.delete(infoHash);
    });
    inFlightResolutions.set(infoHash, filesPromise);
  }

  const files = await filesPromise;
  return files ? findFileId(files, expectedFilename, expectedSize) : null;
}

async function fetchTorrServerFiles(link, infoHash) {
  const deadline = Date.now() + RESOLVE_TIMEOUT_MS;

  try {
    await torrServerRequest('add', { link, save_to_db: false }, remainingTime(deadline));
  } catch (e) {
    console.warn(`resolveFileIndex: /torrents add failed for ${infoHash}: ${e.message}`);
    return null;
  }

  while (Date.now() < deadline) {
    let info;
    try {
      info = await torrServerRequest('get', { hash: infoHash }, remainingTime(deadline));
    } catch (e) {
      break;
    }

    const files = info && info.file_stats;
    if (Array.isArray(files) && files.length > 0) {
      fileListCache.set(infoHash, { files, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
      return files;
    }

    const wait = Math.min(RESOLVE_POLL_INTERVAL_MS, remainingTime(deadline));
    if (wait <= 0) break;
    await sleep(wait);
  }

  return null;
}

function getCachedFileList(infoHash) {
  const entry = fileListCache.get(infoHash);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    fileListCache.delete(infoHash);
    return null;
  }
  return entry.files;
}

function sweepFileListCache() {
  const now = Date.now();
  for (const [infoHash, entry] of fileListCache) {
    if (entry.expiresAt <= now) fileListCache.delete(infoHash);
  }
}

function findFileId(files, expectedFilename, expectedSize) {
  const expectedBase = basename(expectedFilename).toLowerCase();
  const byName = files.find(f => basename(f.path).toLowerCase() === expectedBase);
  if (byName) return byName.id;

  // Fallback: file size is usually unique among episodes of one release —
  // only trust it when exactly one file matches, to avoid picking the wrong
  // episode when sizes collide.
  if (expectedSize) {
    const bySize = files.filter(f => f.length === expectedSize);
    if (bySize.length === 1) return bySize[0].id;
  }

  return null;
}

function basename(path) {
  const parts = String(path || '').split(/[\\/]/);
  return parts[parts.length - 1];
}

function remainingTime(deadline) {
  return Math.max(0, deadline - Date.now());
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function torrServerRequest(action, body, timeoutMs) {
  const res = await fetch(`${TORRSERVER_URL}/torrents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
    signal: AbortSignal.timeout(Math.max(1, timeoutMs))
  });
  if (!res.ok) throw new Error(`TorrServer ${action} -> HTTP ${res.status}`);
  return res.json();
}

function buildLink(stream) {
  // Comet's "still searching" placeholder also has a url, but it points to
  // Comet's site, not a torrent — only trust it if it's an actual magnet.
  if (stream.url && stream.url.startsWith('magnet:')) return stream.url;
  if (!stream.infoHash) return null;

  // Comet's sources are bare tracker URLs without a "tracker:" prefix.
  const trackers = (stream.sources || [])
    .filter(s => typeof s === 'string')
    .map(s => s.replace(/^tracker:/, ''))
    .filter(s => /^(https?|udp|wss?):\/\//i.test(s))
    .map(s => 'tr=' + encodeURIComponent(s))
    .join('&');

  return `magnet:?xt=urn:btih:${stream.infoHash}${trackers ? '&' + trackers : ''}`;
}

app.listen(PORT, () => console.log(`comet-torrserver-bridge listening on ${PORT}`));
