# comet-torrserver-bridge-stremio-addon

A Stremio proxy addon that plays Comet's torrent results through TorrServer instead of Stremio's built-in torrent engine.

## Setup

1. Get your Comet config URL: in Stremio go to Settings → Addons → Comet → Configure, copy the `manifest.json` link, and drop the trailing `/manifest.json`. That's your `COMET_BASE_URL`.

2. Run the published image:

   ```bash
   docker run -d \
     --name comet-torrserver-bridge-stremio-addon \
     --restart unless-stopped \
     -p 7100:7100 \
     -e COMET_BASE_URL="http://host.docker.internal:8000/<your-token>" \
     -e TORRSERVER_URL="http://host.docker.internal:8090" \
     ghcr.io/serhiibuhaiov/comet-torrserver-bridge-stremio-addon:latest
   ```

   Image: [`ghcr.io/serhiibuhaiov/comet-torrserver-bridge-stremio-addon`](https://github.com/serhiibuhaiov/comet-torrserver-bridge-stremio-addon/pkgs/container/comet-torrserver-bridge-stremio-addon) — built and pushed automatically by this repo's GitHub Actions workflow on every push to `main`.

   To build locally from source instead:

   ```bash
   docker build -t comet-torrserver-bridge-stremio-addon .
   ```

3. Install in Stremio: add `http://<host>:7100/manifest.json` via "Search or paste link".

## Configuration

| Variable | Default | Description |
|---|---|---|
| `COMET_BASE_URL` | — (required) | Comet's base URL, including its config token, without `/manifest.json` |
| `TORRSERVER_URL` | `http://host.docker.internal:8090` | TorrServer address |
| `MAX_STREAMS` | `8` | Top N Comet results to resolve via TorrServer |
| `COMET_TIMEOUT_MS` | `120000` | Max wait for Comet's search response |
| `COMET_RETRY_MAX_ELAPSED_MS` | `10000` | Empty Comet replies are retried (up to 3×) only if they came back faster than this; a slower empty reply means Comet finished a real search |

## Logs

```bash
docker logs -f comet-torrserver-bridge-stremio-addon
```
