# comet-torrserver-bridge

A Stremio proxy addon that plays Comet's torrent results through TorrServer instead of Stremio's built-in torrent engine.

## Setup

1. Get your Comet config URL: in Stremio go to Settings → Addons → Comet → Configure, copy the `manifest.json` link, and drop the trailing `/manifest.json`. That's your `COMET_BASE_URL`.

2. Build and run:

   ```bash
   docker build -t comet-torrserver-bridge .

   docker run -d \
     --name comet-torrserver-bridge \
     --restart unless-stopped \
     -p 7100:7100 \
     -e COMET_BASE_URL="http://host.docker.internal:8000/<your-token>" \
     -e TORRSERVER_URL="http://host.docker.internal:8090" \
     comet-torrserver-bridge
   ```

3. Install in Stremio: add `http://<host>:7100/manifest.json` via "Search or paste link".

## Configuration

| Variable | Default | Description |
|---|---|---|
| `COMET_BASE_URL` | — (required) | Comet's base URL, including its config token, without `/manifest.json` |
| `TORRSERVER_URL` | `http://host.docker.internal:8090` | TorrServer address |
| `MAX_STREAMS` | `8` | Top N Comet results to resolve via TorrServer |

## Logs

```bash
docker logs -f comet-torrserver-bridge
```
