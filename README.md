# Server Update Manager

A web-based tool for managing Ubuntu/Debian and TrueNAS CE (SCALE) server updates and Docker Compose projects with automatic scheduling, a credential vault, and NetBox integration.

## Features

### Server Management
- **Manual Updates**: Trigger updates on-demand for individual servers or entire groups
- **Scheduled Updates**: Configure automatic update intervals per group (hours, days, weeks, months)
- **Multi-OS Support**: Debian/Ubuntu (`apt-get`) and TrueNAS CE / SCALE (REST API) — select per server
- **SSH Authentication**: Password or SSH key, either stored directly or via the credential vault
- **Sudo Support**: Configurable sudo password for systems requiring elevated permissions
- **Reboot Management**: Automatic reboot detection; optional auto-reboot per group after updates
- **Update Logging**: Detailed logs showing exactly which packages were upgraded
- **Connection Testing**: Verify SSH connectivity before adding a server
- **NetBox Import**: Bulk-import servers directly from a NetBox inventory

### TrueNAS CE (SCALE) Updates
- Select **TrueNAS CE (SCALE)** as the OS Type when adding a server
- Updates are applied via the TrueNAS REST API — no SSH commands or `midclt` required
- Live progress during download and installation is shown in the same progress modal
- After the update is applied the server card shows a reboot-required warning; use the Reboot button to activate the new version
- Requires password authentication (HTTP Basic auth to the TrueNAS API)
- **Protocol**: choose HTTP or HTTPS per server (default: HTTPS port 443)
- **SSL verification**: optional — disable for self-signed certificates (default); enable when a valid cert is installed

### Docker Management
- **Docker Compose Updates**: Pull latest images and recreate containers automatically
- **Project Discovery**: Scan a Docker host for `docker-compose.yml` files and register them in one step
- **Project Organisation**: Manage multiple Compose projects per host
- **Group Scheduling**: Schedule automatic updates for all projects across a Docker group
- **Multi-Host Support**: Manage Docker hosts across your entire infrastructure
- **NetBox Import**: Bulk-import Docker hosts directly from a NetBox inventory

### Credential Vault
- **Reusable Credentials**: Store SSH credentials (username + password or SSH key) once and apply them to multiple servers and Docker hosts
- **AES-256-GCM Encryption**: All passwords, SSH keys, and sudo passwords are encrypted at rest
- **Centralised Management**: Update a credential in one place; every server using it picks up the change automatically

### Scheduling & Progress
- **Flexible Intervals**: Per-group schedules with hours/days/weeks/months intervals and a configurable start date
- **Timezone Support**: All times displayed and evaluated in Europe/Amsterdam (configurable via `TZ`)
- **Scheduler Check**: Runs every minute; fires a group update when its interval has elapsed
- **Live Activity Panel**: A real-time panel (bottom-right corner) appears automatically during any scheduled update, showing the current group, host/server, project, and progress counter. Dismissible; auto-hides 10 seconds after completion

### Webhooks
- **Update Notifications**: Send POST webhooks to any URL on update completion
- **Configurable Events**: Triggered for both server and Docker update results (success and failure)

### Logging & History
- **Complete History**: All updates (manual and automatic) are logged with timestamps in Europe/Amsterdam time
- **Detailed Information**: Packages upgraded for server updates; images pulled and containers recreated for Docker updates; full command output for troubleshooting
- **Filterable View**: Filter by entity type (server / docker) and update type (manual / automatic)
- **Expandable Details**: Click "Show Details" for full command output
- **Pagination**: Navigate through historical logs

### User Interface
- **Dark Theme**: Modern UI built with Tailwind CSS
- **Real-time Progress**: Live SSE-based progress feedback during manual and scheduled updates
- **Sidebar Navigation**: Tab-based layout with instant access to all sections
- **Modal Dialogs**: Add and edit all resources via clean modal forms
- **Group Member View**: Groups and Docker Groups tabs show which servers/hosts belong to each group

## Quick Start

See [INSTALL.md](INSTALL.md) for full installation instructions.

```bash
git clone https://github.com/FunkyMonkey412/update-manager.git
cd update-manager
docker compose build
docker compose up -d

# Access at http://your-server-ip:3000
```

## Configuration

### Environment Variables

Set in `docker-compose.yml`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port the app listens on |
| `TZ` | `Europe/Amsterdam` | Timezone for scheduling and log display |
| `NODE_ENV` | `production` | Node environment |
| `ENCRYPTION_KEY` | *(auto-generated)* | 64-char hex AES-256 key. If unset, a key is generated and saved to `./data/encryption.key` |
| `NETBOX_URL` | *(unset)* | *(Legacy)* NetBox base URL. Prefer configuring via **Plugins → NetBox** in the UI |
| `NETBOX_TOKEN` | *(unset)* | *(Legacy)* NetBox API token. Prefer configuring via **Plugins → NetBox** in the UI |

### Credential Vault

The credential vault lets you define SSH credentials once and reuse them across any number of servers or Docker hosts.

1. Go to the **Credentials** tab and click **+ Add Credential**
2. Give it a name, enter the username, and choose password or SSH key
3. When adding or editing a server/Docker host, select the credential from the dropdown instead of entering auth details manually

Stored credentials are encrypted with AES-256-GCM. Updating a credential automatically applies to all servers/hosts that reference it.

### Authentication (direct, without vault)

**Password:** Enter username and password — stored AES-256-GCM encrypted.

**SSH Key:** Upload a private key file (`.pem`, `.key`, `id_rsa`, etc.). Keys are stored in the `ssh-keys` volume. Unencrypted keys only.

### Server Groups

- Organise servers by environment, function, or location
- Perform batch updates on all servers in a group
- Per-group auto-update schedule: interval, start date/time, optional auto-reboot
- Auto-updates only run at the group level — there is no per-server automatic update

### Docker Groups

- Organise Docker hosts into logical groups
- Schedule automatic updates for all Compose projects across all hosts in the group
- Independent schedule from server groups

### Project Discovery

On any Docker host card, click **Discover Projects** to scan the host's filesystem for `docker-compose.yml` / `compose.yml` files. Configure the root path and max depth, review results, and register discovered projects in one click.

### NetBox Integration

Go to **Plugins → NetBox** in the sidebar and enter your NetBox URL and a v1 API token (read-only is sufficient). Click **Test Connection** to verify, then **Save**. The token is stored encrypted in the database — no container restart required.

Once configured, use the **Import from NetBox** button on the Servers or Docker Hosts tabs to browse your NetBox VM inventory and import them in bulk. VMs must have the `update-manager` tag and a primary IP set in NetBox. Already-imported IPs are shown as greyed out.

> **Legacy:** You can still set `NETBOX_URL` and `NETBOX_TOKEN` environment variables in `docker-compose.yml`. The UI-configured values take precedence.

### Persistent Data

| Directory | Contents |
|---|---|
| `./data/` | SQLite database + encryption key |
| `./ssh-keys/` | Uploaded SSH private keys |
| `./logs/` | Application logs |

Data survives container restarts and image updates.

## Technology Stack

- **Backend**: Node.js + Express.js
- **Database**: SQLite 3
- **SSH**: node-ssh
- **Scheduling**: node-cron
- **Progress Streaming**: Server-Sent Events (SSE)
- **Encryption**: AES-256-GCM (Node.js `crypto`)
- **Frontend**: Vanilla JavaScript + Tailwind CSS
- **Deployment**: Docker + Docker Compose

## API Endpoints

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
| `GET` | `/api/credentials` | List credentials (no secrets) |
| `POST` | `/api/credentials` | Add credential |
| `DELETE` | `/api/credentials/:id` | Delete credential |

### NetBox
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/netbox/vms` | List NetBox VMs (server import) |
| `POST` | `/api/netbox/import` | Bulk-import servers from NetBox |
| `GET` | `/api/netbox/docker-vms` | List NetBox VMs (Docker host import) |
| `POST` | `/api/netbox/docker-import` | Bulk-import Docker hosts from NetBox |
| `GET` | `/api/netbox/config` | Get stored NetBox URL and token status |
| `POST` | `/api/netbox/config` | Save NetBox URL and/or token |
| `POST` | `/api/netbox/test-connection` | Test NetBox connectivity |

### Other
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/logs` | Update logs (paginated, filterable) |
| `GET` | `/api/dashboard` | Dashboard summary data |
| `GET` | `/api/activity-stream` | SSE stream for scheduled update progress |
| `GET` | `/api/webhooks` | List webhooks |
| `POST` | `/api/webhooks` | Add webhook |
| `DELETE` | `/api/webhooks/:id` | Delete webhook |

## Security Notes

- **Firewall**: Restrict access to port 3000 to trusted IPs only
- **Reverse Proxy**: Use Nginx/Apache with SSL in production
- **Encryption Key**: Back up `./data/encryption.key` — losing it means stored credentials cannot be decrypted
- **SSH Keys**: Ensure proper file permissions (`chmod 600`) on uploaded keys
- **NetBox Token**: Configure via **Plugins → NetBox** in the UI — the token is encrypted with AES-256-GCM and stored in the database. If using env vars instead, do not commit them to version control
- **Backups**: Regularly back up the `./data/` directory

## Directory Structure

```
update-manager/
├── server.js              # Express application entry point
├── db/
│   └── index.js           # SQLite setup and migrations
├── routes/
│   ├── servers.js         # Server CRUD + update + SSE
│   ├── groups.js          # Server group CRUD + update + SSE
│   ├── docker.js          # Docker host/project/group routes + discover
│   ├── credentials.js     # Credential vault routes
│   ├── netbox.js          # NetBox import routes
│   ├── webhooks.js        # Webhook routes
│   ├── logs.js            # Update log routes
│   └── dashboard.js       # Dashboard summary route
├── services/
│   ├── ssh.js             # SSH connection helpers
│   ├── update.js          # Server update logic + logUpdate
│   ├── docker.js          # Docker update logic
│   ├── scheduler.js       # node-cron auto-update scheduler
│   ├── activity.js        # Global SSE activity broadcast
│   ├── netbox.js          # NetBox API client
│   └── notifications.js   # Webhook dispatch
├── utils/
│   └── crypto.js          # AES-256-GCM encrypt/decrypt
├── public/
│   ├── index.html         # Single-page UI
│   └── script.js          # Frontend logic
├── data/                  # SQLite database + encryption key (runtime)
├── ssh-keys/              # Uploaded SSH keys (runtime)
├── logs/                  # Application logs (runtime)
├── Dockerfile
├── docker-compose.yml
├── INSTALL.md
└── README.md
```

## Scheduled Updates

The scheduler checks every minute whether any group is due for an update based on:

1. Current time is past the configured start date
2. Enough time has elapsed since the last update (based on the configured interval)
3. The group has an interval and interval unit configured

When a scheduled update fires, the live **Activity Panel** (bottom-right) appears in all connected browsers showing real-time progress. Logs and the dashboard refresh automatically when it completes.

## Credits

Built with assistance from Claude Code AI.

## License

Proprietary - All rights reserved
