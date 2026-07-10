# Deploying Arix to a VPS

A minimal, production-safe deployment: Docker Compose for Arix itself, Caddy
in front for automatic HTTPS. No K8s, no separate load balancer —
this is meant for a single VPS.

## Requirements

- A VPS with Docker and the Docker Compose plugin installed.
- A domain (or subdomain) pointed at the VPS's IP address (an A/AAAA record).
- Ports 80 and 443 open (Caddy needs both for the ACME HTTP-01 challenge and
  HTTPS itself).

## 1. Get the code and configure `.env`

```bash
git clone <your-fork-or-this-repo-url> arix
cd arix
cp env.example .env
```

Edit `.env` and set at minimum:

- `AUTH_JWT_SECRET` — a long random string (`openssl rand -hex 32`).
- `SETUP_TOKEN` — another independent random value (`openssl rand -hex 32`).
  You will paste it once when creating the first administrator; it is never
  injected into the dashboard container.
- `SETTINGS_ENCRYPTION_KEY` — another independently generated value
  (`openssl rand -hex 32`), used only for AES-encrypted dashboard settings.
- `POSTGRES_PASSWORD` — a strong password for the Postgres container.
- `COOKIE_SECURE=true` — **required** once the dashboard is served over
  HTTPS; the session cookie won't be sent over plain HTTP otherwise (browsers
  reject `Secure` cookies on non-HTTPS origins by design — this isn't
  optional in production).

Everything else (LLM provider, WooCommerce credentials, business profile) is
configured from the dashboard's setup wizard after first boot — see the main
[README](../README.md#quickstart-docker).

To rotate the settings key without losing credentials, move the current value
to `SETTINGS_ENCRYPTION_KEY_PREVIOUS`, put a new independently generated value
in `SETTINGS_ENCRYPTION_KEY`, and restart. Arix re-encrypts stored secrets with
the active key during startup. After a successful start and backup, remove the
previous-key variable and restart once more. Multiple previous keys may be
comma-separated during a staged rotation.

## 2. Start Arix

```bash
docker compose up -d --build
```

This starts Postgres, the server, and the dashboard. The dashboard listens on
`127.0.0.1:3000` via the `docker-compose.yml` port mapping — it is not
reachable from the internet.

## 3. Complete the private bootstrap

**Do not publish the dashboard or configure the public reverse proxy before
the first administrator exists.** From your workstation, open an SSH tunnel:

```bash
ssh -L 3000:127.0.0.1:3000 your-user@your-vps
```

While that session stays open, visit `http://localhost:3000`, paste the
`SETUP_TOKEN` from the VPS `.env`, and create the administrator. The token is
checked with a constant-time comparison and is not stored by the dashboard;
the bootstrap endpoint is permanently disabled as soon as any staff account
exists. Finish or safely skip the remaining wizard steps before continuing.

## 4. Put Caddy in front (automatic HTTPS)

Install Caddy on the host (not in the compose file, so it can also front
other services on the same VPS if you have any):

```bash
# Debian/Ubuntu — see https://caddyserver.com/docs/install for other distros
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

`/etc/caddy/Caddyfile`:

```caddyfile
your-domain.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl reload caddy
```

That's it — Caddy issues and renews a Let's Encrypt certificate automatically
and proxies everything to the dashboard, which in turn proxies `/api/*` to
the server. Visit `https://your-domain.com` and sign in with the administrator
you created through the private tunnel.

## Backups

Two things need backing up: the Postgres database (settings, conversations,
orders cache, staff, the WhatsApp session) and the receipts volume (payment
proof images/PDFs).

```bash
# Database dump
docker compose exec db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup-$(date +%F).sql

# Receipts volume (files, not a database dump)
docker run --rm -v arix_receipts:/data -v "$PWD":/backup alpine \
  tar czf /backup/receipts-$(date +%F).tar.gz -C /data .
```

Restore the database with `docker compose exec -T db psql -U "$POSTGRES_USER" "$POSTGRES_DB" < backup-YYYY-MM-DD.sql`;
untar the receipts archive back into the `receipts` volume the same way, in
reverse.

## Updating

```bash
git pull
docker compose up -d --build
```

Any pending schema migrations run automatically on the server's next boot —
there's no separate migration command to remember.

## WhatsApp session persistence

The WhatsApp pairing (auth keys, session state) is stored in Postgres, not in
a local file — so `docker compose down && docker compose up -d` (or a full
VPS reboot) doesn't require re-scanning the QR code. Only wiping the
`pgdata` volume, or changing `WA_ACCOUNT_ID`, starts a fresh session.
