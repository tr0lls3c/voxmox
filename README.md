# Voxmox

Alexa skill + web dashboard for managing a Proxmox cluster: node/VM/LXC status, performance stats, and power controls (start, stop, shutdown, reboot, reset).

**Canonical source:** [github.com/tr0lls3c/voxmox](https://github.com/tr0lls3c/voxmox) (keep this repo **public** so your Proxmox host can install/update with plain `git`/`curl` — no Origin CLI on the hypervisor).

## Features

- **Cluster overview** — nodes online, VM/LXC counts, running vs stopped
- **Node & guest stats** — CPU, memory, disk, uptime
- **Power actions** — start, stop, shutdown, reboot, reset for QEMU VMs and LXC containers
- **Performance summary** — busiest node/guest, or per-target usage
- **Demo mode** — works without a live Proxmox host so you can try the skill handler immediately
- **Dashboard** — same backend as Alexa, with an utterance simulator
- **Server management** — add, edit, remove, and switch Proxmox API endpoints from the Setup tab

## Quick start (dev)

```bash
npm install
cp .env.example .env.local
npm run dev
```

The web UI listens on **all interfaces** (`0.0.0.0:43127`). Open it at:

- Local machine: [http://127.0.0.1:43127](http://127.0.0.1:43127)
- Another device on your network: `http://<this-host-ip>:43127`

Without Proxmox credentials, the app serves a sample two-node cluster so the dashboard and Alexa simulator work out of the box.

In the **Setup** tab you can add live Proxmox servers (API URL + API token). Credentials are saved under `/var/lib/voxmox/servers.json` on LXC installs (or `./data/servers.json` in local dev) and are preferred over `.env` values. That path is **outside** the app tree, so `update` and reboots keep your servers.

## Publish to GitHub (one-time)

Create a **public** GitHub repo named `voxmox` under your account, then push this project:

```bash
# On your PC (WSL is fine)
gh auth login
gh repo create voxmox --public --source=. --remote=github --push
# If the folder already has origin pointing elsewhere:
#   git remote add github https://github.com/tr0lls3c/voxmox.git
#   git push -u github main
```

Installer default: `https://github.com/tr0lls3c/voxmox`. Override with `GITHUB_REPO=youruser/voxmox` if needed.

## Deploy on Proxmox (LXC helper)

Run **as root on the Proxmox VE host**. No Origin install needed.

### One-liner (after the GitHub repo exists and is public)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/tr0lls3c/voxmox/main/scripts/voxmox-lxc.sh)"
```

### Or from a clone on the host

```bash
git clone https://github.com/tr0lls3c/voxmox.git
cd voxmox
bash scripts/voxmox-lxc.sh
```

### What it configures

| Item | Default |
| --- | --- |
| CT resources | 2 CPU, 2 GB RAM, 8 GB disk |
| OS | Debian 12 (or 13) standard template |
| App path | `/opt/voxmox` |
| Dashboard port | `43127` (`voxmox-dashboard`, UI + control APIs) |
| Alexa API port | `43128` (`voxmox-api`, `/api/alexa` only) |
| Services | `systemctl status voxmox-dashboard voxmox-api` |

You’ll be prompted for storage, bridge, IP, and Proxmox API URL/token. Leave the GitHub PAT blank for a public repo.

### Non-interactive example

```bash
CTID=130 \
HOSTNAME=voxmox \
BRIDGE=vmbr0 \
STORAGE=local-lvm \
VOXMOX_NONINTERACTIVE=1 \
PROXMOX_HOST_URL="https://192.168.1.10:8006" \
PROXMOX_TOKEN_ID="root@pam!voxmox" \
PROXMOX_TOKEN_SECRET="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \
bash -c "$(curl -fsSL https://raw.githubusercontent.com/tr0lls3c/voxmox/main/scripts/voxmox-lxc.sh)"
```

### After install

```bash
pct enter <CTID>
systemctl status voxmox-dashboard voxmox-api --no-pager

# Same pattern as other Proxmox helper scripts:
update
```

`update` pulls from GitHub, refreshes `/usr/bin/update` itself, skips a full OS upgrade by default (use `update --full` for that), reuses npm deps when `package-lock.json` is unchanged, rebuilds when sources change (`update --force` to always rebuild), refreshes the systemd units, and restarts both services.

If `update` finishes but nothing changes (old banner, no settings path, etc.), your LXC still has a pre-self-update updater. Bootstrap once:

```bash
curl -fsSL https://raw.githubusercontent.com/tr0lls3c/voxmox/main/scripts/lxc/update \
  -o /usr/bin/update && chmod 755 /usr/bin/update && update --force
```

Dashboard (**43127**) and Alexa API (**43128**) bind to **all LXC interfaces**. From another machine on your LAN:

```bash
# From the Proxmox host
pct exec <CTID> -- hostname -I
# Dashboard: http://<LXC-IP>:43127
# Alexa:     http://<LXC-IP>:43128/api/alexa
```

Confirm listeners with `ss -tlnp | grep -E '43127|43128'`.

For public HTTPS, point Cloudflare Tunnel (or similar) at those two ports on separate hostnames — see **Cloudflare Access** below. Skill endpoint:

`https://alexa.YOUR_DOMAIN/api/alexa`

## Connect a real Proxmox cluster

### From the web UI (recommended)

1. Open the dashboard → **Setup**.
2. Click **Add server**, enter a name, Proxmox base URL (`https://your-host:8006`), token ID, and token secret. Do **not** append `/api2/json` — Voxmox always calls `{host}/api2/json/...`.
3. Use **Test connection**, then save. Mark the server active (or click **Use** later).
4. Edit or remove servers anytime from the same tab. Secrets are never returned to the browser after save.

Saved servers live in `/var/lib/voxmox/servers.json` (override with `$VOXMOX_DATA_DIR`). LXC `update` migrates any legacy `/opt/voxmox/data/servers.json`, keeps `.env`, and never deletes the durable data directory.

### From environment variables (fallback)

1. In Proxmox, create an API token (Datacenter → Permissions → API Tokens).
2. If the dashboard shows **403 Sys.Audit** / empty node stats, open **Setup**,
   enter the **user password** for the account that owns the token, and click
   **Repair token access**. Voxmox logs in as that user and grants the token
   `PVEAuditor,PVEVMAdmin` on `/` (falls back to `Administrator` if needed).
   You can also disable Privilege Separation on the token in Proxmox, or run:
   `pveum acl modify / -token 'user@realm!token' -role PVEAuditor` and
   `pveum acl modify / -token 'user@realm!token' -role PVEVMAdmin`
3. Set in `.env.local` (dev) or `/opt/voxmox/.env` (LXC):

```env
PROXMOX_HOST=https://your-proxmox-host:8006
PROXMOX_TOKEN_ID=user@pam!token-name
PROXMOX_TOKEN_SECRET=your-secret
# Optional — enables automatic ACL repair on 403 Sys.Audit
# PROXMOX_AUTH_PASSWORD=your-user-password
```

4. For typical self-signed Proxmox TLS certificates, set
   `PROXMOX_ALLOW_SELF_SIGNED=true` (default) or enable **Allow self-signed**
   on the saved server. Voxmox relaxes TLS per outbound Proxmox request — you do
   **not** need `NODE_TLS_REJECT_UNAUTHORIZED=0`.

Restart after changing env vars (`systemctl restart voxmox-dashboard voxmox-api` in the LXC). Env credentials are used only when no enabled saved server is active.

## Alexa skill setup

1. Create a custom Alexa skill in the [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask).
2. Import the interaction model from `alexa/interaction-model.json` (invocation name: **vox mox**).
   Guest/node names use Alexa’s free-form `AMAZON.SearchQuery` slot, so you do **not** need to edit the skill when you add VMs, LXCs, or nodes. Power actions are separate intents (`StartGuestIntent`, `StopGuestIntent`, etc.) because Alexa forbids mixing a phrase slot with other slots.
3. Expose the **API** port publicly over HTTPS (Cloudflare Tunnel recommended). Keep the dashboard on a separate hostname.
4. Set the skill endpoint to:

```text
https://alexa.YOUR_DOMAIN/api/alexa
```

5. Optionally set `ALEXA_SKILL_ID` to your skill’s application ID.

### Example phrases

- “Alexa, open vox mox”
- “Alexa, ask vox mox for cluster status”
- “Alexa, ask vox mox for node stats”
- “Alexa, ask vox mox for stats for docker host”
- “Alexa, ask vox mox to start pihole”
- “Alexa, ask vox mox to shut down windows lab”
- “Alexa, ask vox mox for performance”

## API surface

| Route | Purpose |
| --- | --- |
| `POST /api/alexa` | Alexa skill endpoint (API mode port) |
| `GET /api/health` | Liveness JSON |
| `POST /api/alexa/simulate` | Dashboard simulator (`{ intent, slots }`) |
| `GET /api/cluster` | Cluster overview JSON |
| `GET /api/cluster/stream` | SSE live overview (shared ~4s cache) |
| `POST /api/power` | Power action (`{ vmid\|name, type?, action }`) |
| `GET /api/servers` | List saved Proxmox servers (secrets redacted) |
| `POST /api/servers` | Add a server |
| `PATCH /api/servers/:id` | Edit a server (omit `tokenSecret` to keep it) |
| `DELETE /api/servers/:id` | Remove a server |
| `POST /api/servers/:id/activate` | Make a server active |
| `POST /api/servers/test` | Test credentials (`serverId` or host/token fields) |

## Cloudflare Access (split hosts)

LXC installs run two processes by default so you can put each behind a different Access policy:

| Host (example) | Origin | Access policy |
| --- | --- | --- |
| `dash.example.com` | `http://<LXC-IP>:43127` | **Allow** (your login) |
| `alexa.example.com` | `http://<LXC-IP>:43128` | **Bypass** (Everyone) — Alexa cannot send Access service-token headers |

Skill URL: `https://alexa.example.com/api/alexa`

Alexa auth remains Voxmox signature verification + `ALEXA_SKILL_ID`. Dashboard unlock (`VOXMOX_DASHBOARD_SECRET`) still applies on the dashboard host after you pass Access.

Combined single-port mode: set `VOXMOX_SPLIT=0` at install time (uses `voxmox.service` with `VOXMOX_SERVICE_MODE=all`).

Local scripts:

```bash
npm run start:dashboard   # :43127 UI + control APIs
npm run start:api         # :43128 /api/alexa only
```

## Security notes

- Run this service on a host that can reach your Proxmox API; do not expose Proxmox itself publicly.
- Set `VOXMOX_DASHBOARD_SECRET` to lock Setup / power / cluster APIs behind an unlock cookie (LXC install/update generates one at `/etc/voxmox/dashboard.secret`). Alexa `/api/alexa` stays signature-verified and does not use this secret.
- Prefer a least-privilege API token over `root@pam`. Repair grants `PVEAuditor,PVEVMAdmin` first (Administrator only as fallback). If you keep Privilege Separation on, ACLs must include the **token** (`user@realm!token`), not only the user.
- Production always verifies Alexa signatures (`ALEXA_SKIP_SIGNATURE_VALIDATION` is ignored) and requires `ALEXA_SKILL_ID`.
- Tokens saved in the Setup UI are written to `/var/lib/voxmox/servers.json` (mode `0600`) on LXC installs. Keep that path off shared/public storage and out of git.
- Set `VOXMOX_SECRETS_KEY` (64-char hex or passphrase) to encrypt `tokenSecret` / `authPassword` at rest in `servers.json`. When unset, a key is derived from `VOXMOX_DASHBOARD_SECRET`; without either, secrets stay plaintext (dev) and production logs a one-time warning on write. Existing plaintext values are encrypted on the next save.
- Self-signed Proxmox TLS is handled per request (`PROXMOX_ALLOW_SELF_SIGNED` / server flag). Do not set global `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- The dashboard power buttons can change guest state — treat the public URL like any privileged control plane.
- Cluster stats stream over SSE while the Cluster tab is visible (soft-poll fallback). Proxmox calls are coalesced with a ~4s server cache + singleflight so Alexa and multiple tabs do not multiply API load.

## Scripts

```bash
npm run dev              # combined :43127
npm run start:dashboard  # UI + control APIs :43127
npm run start:api        # Alexa skill API :43128
npm run build
npm run lint
```
