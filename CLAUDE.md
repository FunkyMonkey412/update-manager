# homelab-updater — Claude Code Reference

## What this project is

A self-hosted web UI for managing Ubuntu/Debian server updates, TrueNAS CE (SCALE) updates, and Docker Compose project updates across a homelab. Operators can manually trigger or schedule `apt-get` upgrades, TrueNAS system updates, and `docker compose pull/up` runs across fleets of servers, with real-time progress, update logs, Discord notifications, and NetBox import.

Designed for internal use on a trusted network — no user auth, no HTTPS (add a reverse proxy for that).

---

## Architecture

```
server.js            Express entry point; mounts all routes; runs DB migrations at startup
db/index.js          SQLite3 setup; Promise wrappers (dbGet/dbAll/dbRun); migration runner
routes/              One file per resource — thin HTTP layer only
services/            Business logic: SSH, Docker, scheduling, NetBox, crypto, notifications
utils/crypto.js      AES-256-GCM encrypt/decrypt; auto-generates key on first boot
public/index.html    Single-page app (Tailwind CDN, dark theme)
public/script.js     ~2100 lines of vanilla JS; tab system, forms, SSE listeners, state
```

### Routes → Services map

| Route file | Calls into |
|---|---|
| routes/servers.js | services/update.js, services/ssh.js |
| routes/docker.js | services/docker.js, services/ssh.js |
| routes/groups.js | services/update.js |
| routes/netbox.js | services/netbox.js, utils/crypto.js |
| routes/credentials.js | utils/crypto.js |
| routes/webhooks.js | services/notifications.js |
| routes/dashboard.js | db directly |
| routes/logs.js | db directly |

### Database tables (SQLite at `data/servers.db`)

- `servers` — individual SSH-managed servers (Debian/Ubuntu or TrueNAS CE, via `os_type` column)
- `server_groups` — groups with auto-update schedule
- `docker_hosts` — SSH-accessible Docker hosts
- `docker_compose_projects` — compose files per host
- `docker_groups` — groups of Docker hosts with schedule
- `credentials` — reusable encrypted credential vault (password, SSH key, or API token); `credential_subtype` column distinguishes API tokens from passwords
- `webhooks` — Discord webhook destinations
- `update_logs` — full audit trail of all updates
- `plugin_settings` — key-value store (currently: NetBox URL + encrypted token)
- `schema_migrations` — tracks applied migrations

### Real-time (SSE)

- Per-update streams: `GET /api/{resource}/:id/update-stream` — one client per update
- Global activity stream: `GET /api/activity-stream` — scheduler broadcasts to all connected browsers
- Frame format: `data: ${JSON.stringify(payload)}\n\n`; 30-second `:heartbeat` keepalives

---

## Tech stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 20 (Alpine Docker image) |
| HTTP | Express 4 |
| Database | SQLite3 (sqlite3 npm package) |
| SSH | node-ssh 13 |
| Scheduling | node-cron 3 |
| File upload | multer |
| Encryption | Node `crypto` — AES-256-GCM |
| Frontend | Vanilla ES6+, Tailwind CSS via CDN |
| Deployment | Docker + Docker Compose |

---

## Conventions

**Encryption:** `utils/crypto.js` — `encrypt(plaintext)` returns `'aes:' + base64(iv+tag+ciphertext)`. Passwords, sudo passwords, SSH key material, and the NetBox token are all encrypted before DB storage. Key lives at `data/encryption.key` or `ENCRYPTION_KEY` env var.

**Migrations:** Add objects to the `MIGRATIONS` array in `db/index.js` with a unique `id`, `name`, and `sql`. The runner splits on `;` and silently ignores `duplicate column` / `already exists` errors for idempotency. Current highest migration id: **9** (`add_credential_subtype`).

**Error responses:** Always `{ error: string }` with a meaningful HTTP status. 502 for upstream failures (SSH unreachable, NetBox timeout).

**Async DB calls:** Always `await dbGet/dbAll/dbRun(sql, params)` — never raw callbacks.

**Sudo:** `makeSudoExec()` in `services/ssh.js` pipes the password via stdin — never interpolates it into shell strings.

**Frontend state:** Global arrays (`servers`, `groups`, `dockerHosts`, etc.) populated on load. After any mutation, re-fetch and re-render the affected list. No reactive framework.

**Tab system:** `showTab(name)` hides all `.tab-content` divs, shows the target by ID, and updates `.tab-button` `data-active` attributes for styling.

**Docker Compose detection:** v1 (`docker-compose`) vs v2 (`docker compose`) detected per host and cached in `docker_hosts.docker_compose_command`.

**NetBox VMs:** Only VMs tagged `update-manager` and with a primary IP are shown/importable.

---

## Deployment

```bash
docker compose up -d --build   # build and start
docker compose logs -f          # follow logs
```

Persistent data in `./data/` (DB + encryption key), `./ssh-keys/` (uploaded private keys), `./logs/`.

Environment variables in `docker-compose.yml`:
- `TZ` — scheduler timezone (default: `Europe/Amsterdam`)
- `ENCRYPTION_KEY` — optional fixed 64-char hex key; auto-generated otherwise
- `NETBOX_URL` / `NETBOX_TOKEN` — legacy env-var config (superseded by Plugins → NetBox UI)

---

## Features (complete)

- Server CRUD + SSH test + manual update + reboot + status tracking
- **OS type per server** (`os_type` column: `debian` or `truenas_ce`) — selectable in Add/Edit server forms; shown as badge on server cards
- **TrueNAS CE (SCALE) update support** — uses TrueNAS REST API (`/api/v2.0/update/*`), not SSH/midclt; download + apply flow with live progress; sets reboot-required flag after apply; per-server protocol (HTTP/HTTPS) and SSL verification settings
- Server groups with flexible auto-update schedules (hours/days/weeks/months) + auto-reboot
- Docker host CRUD + project discovery + manual update per project/host/group
- Docker groups with auto-update schedules
- Reusable credential vault (password, SSH key, or API token, AES-256-GCM encrypted)
- Update logs with full output capture, pagination, filtering
- Discord webhook notifications (success/failure, per webhook)
- NetBox VM import for servers and Docker hosts (bulk, dedup by IP)
- Plugins → NetBox UI: configure URL + token at runtime without restarting container
- Real-time SSE progress for all update operations
- Global activity stream for scheduled updates visible to all browsers
- Dashboard with stats and recent log entries

---

## Current status

### Done (as of 2026-06-18)

- Full server and Docker management stack
- Credential vault with AES-256-GCM encryption
- Scheduling with node-cron
- Discord webhooks
- NetBox import (servers + Docker hosts)
- **Plugins → NetBox settings page** — users can configure NetBox URL and API token in the UI (stored encrypted in `plugin_settings` table); no container restart needed. Test Connection works with unsaved form values too.
- **TrueNAS CE (SCALE) update support** — `os_type` field on servers; REST API-based update flow (`/update/status` → `/update/download` → `/update/run`); live SSE progress with download %; reboot-required flag set after apply.
- **TrueNAS CE per-server connection settings** — protocol (HTTP/HTTPS) and SSL verification (checkbox) stored in `truenas_protocol` + `truenas_verify_ssl` columns (migration #7); fields appear only when TrueNAS CE OS type is selected; SSL verify field hides when HTTP is chosen.
- **Home Assistant OS update support** — `os_type='home_assistant'`; uses the standard HA REST API; checks and updates both Core and OS in one pass via `update.*` entity states and `update/install` service calls; connection drop handled for Core restart and OS reboot; Reboot button calls `/api/services/hassio/host_reboot`. Per-server settings: `ha_protocol`, `ha_port` (default 8123), `ha_verify_ssl` (migration #8). Token stored encrypted in `password_hash` field. No SSH required.
- **API Token credential type** — credential vault extended with `api_token` subtype (migration #9 adds `credential_subtype TEXT` column); stored as `auth_type='password'` + `credential_subtype='api_token'` to satisfy the existing CHECK constraint; displayed as "API Token" badge in the UI; credential picker on HA server forms filters to API Token credentials only.
- **HA server form UX** — authentication type dropdown is hidden for Home Assistant OS (always bearer token); password field is relabelled "API Token"; hint text directs users to Profile → Security → Long-Lived Access Tokens; credential form field order: Credential Name → Authentication Type → Username → Password/Key.

### TrueNAS CE notes

- Update uses the TrueNAS REST API — **password auth required** (SSH key auth is not used for the update flow)
- Default: HTTPS port 443, SSL verification off (self-signed cert friendly)
- `update.download` stages the image; `update.run` applies it; system reboots automatically
- After `update.run` completes the server card shows "⚠ Reboot recommended" — use the Reboot button to finalise
- Tested against TrueNAS SCALE 25.10.x (Goldeye train)

### Home Assistant OS notes

- Update uses the standard HA REST API at `http(s)://{ip}:{port}/api/`
- Auth: long-lived access token (generate in HA profile → Security → Long-Lived Access Tokens), stored encrypted in `password_hash`
- Default: HTTP, port 8123, SSL verification off
- Update flow: checks Core via `GET /api/states/update.home_assistant_core_update` → installs via `POST /api/services/update/install` → checks OS via `GET /api/states/update.home_assistant_operating_system_update` → installs if available
- Core update restarts the HA container (no system reboot); OS update writes to inactive boot slot then reboots
- Reboot button calls `POST /api/services/hassio/host_reboot`
- **No SSH credentials needed** — username field is hidden in the form (placeholder 'homeassistant' stored in DB)
- Auth type dropdown is hidden in server forms for HA — it always uses bearer token
- Credential picker on HA server forms shows only API Token credentials
- Highest migration id: **9** (`add_credential_subtype`)

### In progress / next

- No immediate open tasks — project is feature-complete for its stated scope
- Potential additions: HTTPS/reverse-proxy docs, rate limiting, SSH key passphrase support, configurable auto-hide timeout for activity panel

---

*Update this "Current status" section at the end of each Claude Code session.*
