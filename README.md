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
| Port | `43127` (bound to `0.0.0.0` — all LXC interfaces) |
| Service | `systemctl status voxmox` |

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
systemctl status voxmox --no-pager

# Same pattern as other Proxmox helper scripts:
update
```

`update` pulls from GitHub, refreshes npm deps, rebuilds, and restarts the service.

The dashboard is bound to **all LXC interfaces** on port **43127**. From another machine on your LAN:

```bash
# From the Proxmox host
pct exec <CTID> -- hostname -I
# Then open: http://<LXC-IP>:43127
```

Confirm the listen address inside the CT with `ss -tlnp | grep 43127` (you should see `0.0.0.0:43127`).

Point Alexa at `https://YOUR_PUBLIC_HTTPS_HOST/api/alexa` (tunnel/proxy the CT IP on port 43127).

## Connect a real Proxmox cluster

1. In Proxmox, create an API token (Datacenter → Permissions → API Tokens).
2. Grant the token permission to audit resources and manage VM/LXC power state (for example `VM.Audit`, `VM.PowerMgmt`, and path access under `/vms` and `/nodes`).
3. Set in `.env.local` (dev) or `/opt/voxmox/.env` (LXC):

```env
PROXMOX_HOST=https://your-proxmox-host:8006
PROXMOX_TOKEN_ID=user@pam!token-name
PROXMOX_TOKEN_SECRET=your-secret
```

4. For typical self-signed Proxmox TLS certificates, also set:

```env
NODE_TLS_REJECT_UNAUTHORIZED=0
```

Restart the app after changing env vars (`systemctl restart voxmox` in the LXC).

## Alexa skill setup

1. Create a custom Alexa skill in the [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask).
2. Import the interaction model from `alexa/interaction-model.json` (invocation name: **vox mox**).
   Guest/node names use Alexa’s free-form `AMAZON.SearchQuery` slot, so you do **not** need to edit the skill when you add VMs, LXCs, or nodes. Power actions are separate intents (`StartGuestIntent`, `StopGuestIntent`, etc.) because Alexa forbids mixing a phrase slot with other slots.
3. Expose this app on a public HTTPS URL (Cloudflare Tunnel, Tailscale Funnel, Caddy, nginx, etc.).
4. Set the skill endpoint to:

```text
https://YOUR_PUBLIC_HOST/api/alexa
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
| `POST /api/alexa` | Alexa skill endpoint |
| `POST /api/alexa/simulate` | Dashboard simulator (`{ intent, slots }`) |
| `GET /api/cluster` | Cluster overview JSON |
| `POST /api/power` | Power action (`{ vmid\|name, type?, action }`) |

## Security notes

- Run this service on a host that can reach your Proxmox API; do not expose Proxmox itself publicly.
- Prefer a least-privilege API token over `root@pam`.
- Production requests to `/api/alexa` verify Amazon’s signature headers (skipped automatically in development).
- The dashboard power buttons can change guest state — treat the public URL like any privileged control plane.

## Scripts

```bash
npm run dev    # listens on 0.0.0.0:43127 (all interfaces)
npm run build
npm run start  # listens on 0.0.0.0:43127 (all interfaces)
npm run lint
```
