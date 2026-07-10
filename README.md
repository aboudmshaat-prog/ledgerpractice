# LedgerPractice — single-user server app

Your own accounting tool, running on your server, data saved centrally behind
one password. Built with **zero external dependencies** (pure Node.js) so it's
tiny, fast, and trivial to deploy.

## Structure
```
server.js                 the whole backend (Node built-ins only)
public/index.html         the app
ledgerpractice.service    systemd service (keeps it running)
Caddyfile                 reference web-server config (reverse proxy + HTTPS)
.github/workflows/
  deploy.yml              auto-deploy + restart on every push
SETUP_SERVER.md           one-time setup instructions (start here)
```

## How it works
The browser app talks to `/api/data` on the server, which stores everything in
`data/data.json` with automatic timestamped backups. Everything is behind a
single password (`APP_PASSWORD`). Caddy provides HTTPS and forwards to the app.

## Data & safety
- Data: `data/data.json` (+ `data/backups/`). Never committed to git.
- Secrets live only in `/etc/ledgerpractice.env`, never in the repo.
- Prototype for your own use, on test data first; keep backups once real data
  is in.
