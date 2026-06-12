# Installation

## Requirements

- Docker Engine 20.10+
- Docker Compose V2

## Install

```bash
git clone https://github.com/FunkyMonkey412/update-manager.git
cd update-manager
docker compose build
docker compose up -d
```

Open `http://your-server-ip:3000` in your browser.

## Configuration

Edit `docker-compose.yml` before starting:

```yaml
ports:
  - "3000:3000"         # change left number to use a different host port

environment:
  - TZ=Europe/Amsterdam # timezone for scheduling and log display
  - PORT=3000

  # Optional: fix the AES-256 encryption key (64 hex chars).
  # If unset, a key is auto-generated and saved to ./data/encryption.key.
  # - ENCRYPTION_KEY=<64 hex chars>

  # Optional: NetBox integration — enables "Import from NetBox" on
  # the Servers and Docker Hosts tabs. Both variables must be set.
  # - NETBOX_URL=https://netbox.example.com
  # - NETBOX_TOKEN=your_api_token_here
```

## Data

All persistent data is stored in bind-mounted directories next to `docker-compose.yml`:

| Directory | Contents |
|-----------|----------|
| `./data/` | SQLite database + encryption key |
| `./ssh-keys/` | Uploaded SSH private keys |
| `./logs/` | Application logs |

**Back these up before updating**, especially `./data/encryption.key` — losing it makes stored credentials unrecoverable.

## First-time setup

1. Open the UI and go to the **Credentials** tab to add reusable SSH credentials (optional but recommended)
2. Add servers under the **Servers** tab, or use **Import from NetBox** if NetBox is configured
3. Add Docker hosts under the **Docker Hosts** tab in the same way
4. Create **Groups** / **Docker Groups** and assign servers/hosts to them
5. Configure a schedule on each group to enable automatic updates

## Update

```bash
git pull
docker compose build
docker compose up -d
```

## Useful commands

```bash
docker compose logs -f       # live application logs
docker compose ps            # container status
docker compose restart       # restart container
docker compose down          # stop and remove container
```
