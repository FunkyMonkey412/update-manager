# homelab-updater

Tired of SSH-ing into every box in your homelab just to run `apt upgrade`? homelab-updater is a self-hosted web UI that lets you patch all your servers, TrueNAS boxes, and Home Assistant installs from one place — with scheduling, live progress, and Discord notifications.

No cloud, no account, no nonsense. Runs in Docker on whatever server you've already got.

## What it does

- **Patch servers**: Debian/Ubuntu via SSH, with sudo support. One click per server or run a whole group at once.
- **TrueNAS CE (SCALE)**: Uses the TrueNAS REST API — no SSH hacks needed.
- **Home Assistant OS**: Updates Core and OS in one pass via the standard HA REST API. Just paste a long-lived access token.
- **Docker Compose**: Pull latest images and recreate containers across all your hosts.
- **Scheduling**: Set update groups to run automatically — nightly, weekly, whatever works for you.
- **Credential vault**: Store SSH keys, passwords, and API tokens once, reuse them everywhere. Encrypted at rest.
- **Live progress**: Watch updates happen in real time via a progress modal and activity panel.
- **Discord webhooks**: Get notified when updates succeed or fail.
- **NetBox import**: If you're already using NetBox, pull your server inventory straight in.

## Quick Start

See [INSTALL.md](INSTALL.md) for the full setup guide.

```bash
git clone https://github.com/FunkyMonkey412/homelab-updater.git
cd homelab-updater
docker compose build
docker compose up -d
```

Then open `http://your-server-ip:3000` in your browser.

## Configuration

Three env vars you might actually want to change (set in `docker-compose.yml`):

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the web UI listens on |
| `TZ` | `Europe/Amsterdam` | Timezone for scheduling and logs |
| `ENCRYPTION_KEY` | *(auto-generated)* | Fixed 64-char hex key for credential encryption. Auto-generated and saved to `./data/encryption.key` if not set — back that file up! |

**Credential vault:** Go to the Credentials tab, add a password, SSH key, or API token, give it a name, and select it when adding servers. Change it once, it updates everywhere.

**NetBox (optional):** Go to Plugins → NetBox in the sidebar, paste your URL and a **v1 API token** (read-only is fine — generate one under NetBox → Admin → API Tokens), and hit Save. Then use the Import button on the Servers or Docker Hosts tabs.

## A note on security

This tool is designed for a trusted home network — there's no login screen by default. Keep port 3000 firewalled to your LAN (or throw Nginx in front of it if you want HTTPS). And make sure to back up `./data/` — it holds your database and encryption key.

## Persistent data

| Directory | Contents |
|---|---|
| `./data/` | SQLite database + encryption key |
| `./ssh-keys/` | Uploaded SSH private keys |
| `./logs/` | Application logs |

---

## For the geeks: API reference

If you want to automate things or build on top of homelab-updater, here are all the endpoints.

### Servers
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/servers` | List all servers |
| `POST` | `/api/servers` | Add server |
| `PUT` | `/api/servers/:id` | Edit server |
| `DELETE` | `/api/servers/:id` | Delete server |
| `POST` | `/api/servers/:id/update` | Trigger update |
| `POST` | `/api/servers/:id/reboot` | Reboot server |
| `GET` | `/api/servers/:id/update-stream` | SSE progress stream |
| `POST` | `/api/servers/test-connection` | Test SSH connectivity |

### Server Groups
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/groups` | List all groups |
| `POST` | `/api/groups` | Create group |
| `PUT` | `/api/groups/:id` | Edit group |
| `DELETE` | `/api/groups/:id` | Delete group |
| `POST` | `/api/groups/:id/update` | Update all servers in group |
| `GET` | `/api/groups/:id/update-stream` | SSE progress stream |

### Docker Hosts
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/docker/hosts` | List all Docker hosts |
| `POST` | `/api/docker/hosts` | Add Docker host |
| `PUT` | `/api/docker/hosts/:id` | Edit Docker host |
| `DELETE` | `/api/docker/hosts/:id` | Delete Docker host |
| `POST` | `/api/docker/hosts/:id/update` | Update all projects on host |
| `GET` | `/api/docker/hosts/:id/update-stream` | SSE progress stream |
| `POST` | `/api/docker/hosts/:id/discover` | Scan host for Compose files |

### Docker Projects
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/docker/projects` | List all projects |
| `POST` | `/api/docker/projects` | Add project |
| `PUT` | `/api/docker/projects/:id` | Edit project |
| `DELETE` | `/api/docker/projects/:id` | Delete project |
| `POST` | `/api/docker/projects/:id/update` | Update project |
| `GET` | `/api/docker/projects/:id/update-stream` | SSE progress stream |

### Docker Groups
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/docker/groups` | List all Docker groups |
| `POST` | `/api/docker/groups` | Create Docker group |
| `PUT` | `/api/docker/groups/:id` | Edit Docker group |
| `DELETE` | `/api/docker/groups/:id` | Delete Docker group |
| `POST` | `/api/docker/groups/:id/update` | Update all hosts in group |
| `GET` | `/api/docker/groups/:id/update-stream` | SSE progress stream |

### Credentials
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/credentials` | List credentials (no secrets returned) |
| `POST` | `/api/credentials` | Add credential |
| `DELETE` | `/api/credentials/:id` | Delete credential |

### Other
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/logs` | Update logs (paginated, filterable) |
| `GET` | `/api/dashboard` | Dashboard summary data |
| `GET` | `/api/activity-stream` | SSE stream for scheduled update progress |
| `GET` | `/api/webhooks` | List webhooks |
| `POST` | `/api/webhooks` | Add webhook |
| `DELETE` | `/api/webhooks/:id` | Delete webhook |
