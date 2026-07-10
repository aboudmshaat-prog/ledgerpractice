# Run LedgerPractice on your Hetzner server (single user)

This puts the app on your server, saving all data centrally behind one
password, at `https://app.yourdomain.co.uk`. Do the one-time setup once; after
that, changes deploy automatically from GitHub.

Replace `SERVER_IP` and `app.yourdomain.co.uk` with your real values.

---

## One-time server setup

**1. Log in to the server**
```
ssh root@SERVER_IP
```

**2. Install Node.js (v20)**
```
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version
```

**3. Create the app folder and copy the files in**
The GitHub auto-deploy (below) will keep this updated, but for the very first
run put the files there. Easiest: finish the GitHub steps first, run the
workflow once, then come back here. Or copy manually from your computer:
```
mkdir -p /opt/ledgerpractice
# from your computer, in the folder that has server.js and public/:
scp -r server.js public root@SERVER_IP:/opt/ledgerpractice/
```

**4. Create the settings file with your password**
Pick a strong password and a long random secret:
```
nano /etc/ledgerpractice.env
```
Paste (change the password; generate a secret with `openssl rand -hex 32`):
```
APP_PASSWORD=choose-a-strong-password-here
SESSION_SECRET=paste-a-long-random-hex-string
PORT=3000
DATA_DIR=/opt/ledgerpractice/data
COOKIE_SECURE=1
```
Save: Ctrl+O, Enter, Ctrl+X. Lock it down:
```
chmod 600 /etc/ledgerpractice.env
```

**5. Install the background service (keeps the app running & auto-restarts)**
```
cp /opt/ledgerpractice/ledgerpractice.service /etc/systemd/system/ 2>/dev/null || nano /etc/systemd/system/ledgerpractice.service
systemctl daemon-reload
systemctl enable --now ledgerpractice
systemctl status ledgerpractice --no-pager
```
*(If you didn't copy the service file yet, paste the contents of
`ledgerpractice.service` into nano in the command above.)*

**6. Point Caddy at the app**
```
nano /etc/caddy/Caddyfile
```
Replace contents with (your domain):
```
app.yourdomain.co.uk {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
```
Then:
```
systemctl reload caddy
```

**7. Point the subdomain at the server** — in Wix, add an **A record**:
Host `app`, Value `SERVER_IP` (see the earlier deployment guide for the exact
Wix clicks).

**8. Open** `https://app.yourdomain.co.uk` — you should get the password screen.

---

## Turn on automatic deployment (GitHub)

Follow `SETUP_GITHUB_DEPLOY.md` from before, with one difference already built
into this project's `deploy.yml`: after copying files it runs
`systemctl restart ledgerpractice` so the new version goes live. The three
GitHub secrets are the same: `HETZNER_HOST`, `HETZNER_USER`, `HETZNER_SSH_KEY`.

From then on: change the app → push to GitHub → it deploys and restarts itself.

---

## Everyday use

- **Password:** the one in `/etc/ledgerpractice.env`. To change it, edit that
  file and run `systemctl restart ledgerpractice`.
- **Your data:** lives in `/opt/ledgerpractice/data/data.json`, with automatic
  timestamped backups in `/opt/ledgerpractice/data/backups/`.
- **Back it up:** copy the `data` folder somewhere safe periodically, e.g.
  `scp -r root@SERVER_IP:/opt/ledgerpractice/data ./ledgerpractice-backup`.

---

## VAT (your new setting)

When you add a client there is now a **Registered for VAT** tickbox and a VAT
rate (default 20%):

- **Ticked:** sales and standard-rated expenses are split into net + VAT; the
  VAT element collects in a **VAT Control** account on the Balance Sheet.
- **Unticked:** VAT is ignored entirely — amounts post in full.

Accounts that are not standard-rated (e.g. bank charges) are never VAT-split.
As the accountant, review the VAT treatment per client — the tool applies a
single standard rate and does not, by itself, handle flat-rate or partial
exemption.

---

## Reminder

Keep basic hygiene if you store real client data: strong password, HTTPS (Caddy
does this), and regular `data` backups. That's normal housekeeping for your
clients' information.
