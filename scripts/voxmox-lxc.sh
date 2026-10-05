#!/usr/bin/env bash
# ==============================================================================
# Voxmox LXC helper for Proxmox VE
# ==============================================================================
# Creates a Debian LXC, installs Voxmox (Alexa + Proxmox control dashboard),
# and enables a systemd service.
#
# One-liner on the Proxmox host (no Origin CLI required) after the GitHub repo
# is public:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/tr0lls3c/voxmox/main/scripts/voxmox-lxc.sh)"
#
# Or from a local clone:
#
#   git clone https://github.com/tr0lls3c/voxmox.git
#   cd voxmox && bash scripts/voxmox-lxc.sh
#
# Non-interactive example:
#
#   CTID=130 HOSTNAME=voxmox BRIDGE=vmbr0 STORAGE=local-lvm \
#   PROXMOX_TOKEN_ID="root@pam!voxmox" \
#   PROXMOX_TOKEN_SECRET="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \
#   bash scripts/voxmox-lxc.sh
# ==============================================================================
set -euo pipefail

APP="Voxmox"
APP_DIR="/opt/voxmox"
APP_USER="voxmox"
APP_PORT="${APP_PORT:-43127}"
GITHUB_REPO="${GITHUB_REPO:-tr0lls3c/voxmox}"
DEFAULT_GIT_URL="${VOXMOX_GIT_URL:-https://github.com/${GITHUB_REPO}.git}"
RAW_BASE="${VOXMOX_RAW_BASE:-https://raw.githubusercontent.com/${GITHUB_REPO}/main}"
NODE_MAJOR="${NODE_MAJOR:-22}"

# Resource defaults
CTID="${CTID:-}"
HOSTNAME="${HOSTNAME:-voxmox}"
DISK_SIZE="${DISK_SIZE:-8}"
CORE_COUNT="${CORE_COUNT:-2}"
RAM_SIZE="${RAM_SIZE:-2048}"
SWAP_SIZE="${SWAP_SIZE:-512}"
BRIDGE="${BRIDGE:-vmbr0}"
STORAGE="${STORAGE:-}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-}"
OSTEMPLATE="${OSTEMPLATE:-}"
UNPRIVILEGED="${UNPRIVILEGED:-1}"
NESTING="${NESTING:-1}"
STATIC_IP="${STATIC_IP:-dhcp}"
GATEWAY="${GATEWAY:-}"
DNS="${DNS:-}"
PASSWORD="${PASSWORD:-}"
SSH_KEYS="${SSH_KEYS:-}"
PROXMOX_HOST_URL="${PROXMOX_HOST_URL:-}"
PROXMOX_TOKEN_ID="${PROXMOX_TOKEN_ID:-}"
PROXMOX_TOKEN_SECRET="${PROXMOX_TOKEN_SECRET:-}"
PROXMOX_MOCK="${PROXMOX_MOCK:-false}"
ALEXA_SKILL_ID="${ALEXA_SKILL_ID:-}"
GIT_BRANCH="${GIT_BRANCH:-main}"
SKIP_BUILD="${SKIP_BUILD:-0}"

YW=$'\033[33m'
BL=$'\033[36m'
GN=$'\033[1;92m'
RD=$'\033[01;31m'
CL=$'\033[m'
BOLD=$'\033[1m'

msg_info() { echo -e "${BOLD}${YW}[INFO]  ${CL}$1"; }
msg_ok() { echo -e "${BOLD}${GN}[OK]    ${CL}$1"; }
msg_error() { echo -e "${BOLD}${RD}[ERROR] ${CL}$1"; }
msg_warn() { echo -e "${BOLD}${YW}[WARN]  ${CL}$1"; }

header() {
  clear
  cat <<"EOF"
#     # ####### #     # #     # ####### #     #
#     # #     #  #   #  ##   ## #     #  #   #
#     # #     #   # #   # # # # #     #   # #
#     # #     #    #    #  #  # #     #    #
 #   #  #     #   # #   #     # #     #   # #
  # #   #     #  #   #  #     # #     #  #   #
   #    ####### #     # #     # ####### #     #

  Proxmox LXC installer
EOF
  echo -e "  ${BL}Alexa skill + dashboard for your Proxmox cluster${CL}\n"
}

die() {
  msg_error "$1"
  exit 1
}

need_root() {
  [[ $EUID -eq 0 ]] || die "Run this script as root on a Proxmox VE host."
}

need_proxmox() {
  command -v pvesh >/dev/null 2>&1 || die "pvesh not found. This must run on a Proxmox VE host."
  command -v pct >/dev/null 2>&1 || die "pct not found. This must run on a Proxmox VE host."
  command -v pveam >/dev/null 2>&1 || die "pveam not found. This must run on a Proxmox VE host."
}

prompt() {
  # prompt "Question" "default" -> sets REPLY
  local question="$1"
  local default="${2:-}"
  if [[ -n "$default" ]]; then
    read -r -p "$(echo -e "${BOLD}${question}${CL} [${default}]: ")" REPLY
    REPLY="${REPLY:-$default}"
  else
    read -r -p "$(echo -e "${BOLD}${question}${CL}: ")" REPLY
  fi
}

prompt_secret() {
  local question="$1"
  local default="${2:-}"
  if [[ -n "$default" ]]; then
    read -r -s -p "$(echo -e "${BOLD}${question}${CL} [set]: ")" REPLY
    echo
    REPLY="${REPLY:-$default}"
  else
    read -r -s -p "$(echo -e "${BOLD}${question}${CL}: ")" REPLY
    echo
  fi
}

next_ctid() {
  pvesh get /cluster/nextid
}

list_storages() {
  pvesh get /storage --output-format json 2>/dev/null |
    sed -n 's/.*"storage"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    sort -u
}

detect_storage() {
  local preferred
  preferred="$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 {print $1; exit}')"
  if [[ -n "$preferred" ]]; then
    echo "$preferred"
    return
  fi
  list_storages | head -n1
}

detect_template_storage() {
  local preferred
  preferred="$(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 {print $1; exit}')"
  if [[ -n "$preferred" ]]; then
    echo "$preferred"
    return
  fi
  echo "local"
}

detect_host_url() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -n "$ip" ]]; then
    echo "https://${ip}:8006"
  else
    echo "https://192.168.1.1:8006"
  fi
}

script_dir() {
  local source="${BASH_SOURCE[0]}"
  # When piped through curl|bash, BASH_SOURCE is often /dev/fd/* with no siblings.
  if [[ ! -f "$source" ]] || [[ "$source" == /dev/fd/* ]] || [[ "$source" == /proc/self/fd/* ]]; then
    return 1
  fi
  while [[ -L "$source" ]]; do
    local dir
    dir="$(cd -P "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    [[ $source != /* ]] && source="$dir/$source"
  done
  cd -P "$(dirname "$source")" && pwd
}

repo_root_from_script() {
  local dir
  dir="$(script_dir)" || return 1
  # scripts/ -> repo root
  cd "$dir/.." && pwd
}

has_local_helpers() {
  local dir
  dir="$(script_dir)" || return 1
  [[ -f "$dir/lxc/install-voxmox.sh" && -f "$dir/lxc/update" && -f "$dir/lxc/voxmox.service" ]]
}

# Copy a helper file into place from the local checkout, or download from GitHub.
stage_helper_file() {
  local name="$1"
  local dest="$2"
  local dir

  if dir="$(script_dir)" && [[ -f "$dir/lxc/$name" ]]; then
    cp "$dir/lxc/$name" "$dest"
    return
  fi

  msg_info "Downloading scripts/lxc/${name} from GitHub"
  curl -fsSL "${RAW_BASE}/scripts/lxc/${name}" -o "$dest" ||
    die "Failed to download ${RAW_BASE}/scripts/lxc/${name}
Is https://github.com/${GITHUB_REPO} public and pushed?"
}

ensure_template() {
  local storage="$1"
  local template="$2"
  if [[ -f "/var/lib/vz/template/cache/${template}" ]] ||
    pveam list "$storage" 2>/dev/null | grep -q "$template"; then
    msg_ok "Template present: $template"
    return
  fi

  msg_info "Downloading template $template to storage '$storage' (this can take a bit)"
  pveam update >/dev/null
  pveam download "$storage" "$template"
  msg_ok "Template downloaded"
}

pick_debian_template() {
  local storage="$1"
  local found
  pveam update >/dev/null || true
  found="$(
    pveam available -section system 2>/dev/null |
      awk '{print $2}' |
      grep -E 'debian-12-standard_.*_amd64\.tar\.(zst|xz)$' |
      sort -V |
      tail -n1
  )"
  if [[ -z "$found" ]]; then
    found="$(
      pveam available -section system 2>/dev/null |
        awk '{print $2}' |
        grep -E 'debian-13-standard_.*_amd64\.tar\.(zst|xz)$' |
        sort -V |
        tail -n1
    )"
  fi
  [[ -n "$found" ]] || die "Could not find a Debian standard template via pveam."
  echo "$found"
}

collect_settings() {
  header
  msg_info "This will create an unprivileged Debian LXC and install ${APP}."
  echo

  if [[ -z "$CTID" ]]; then
    prompt "LXC ID" "$(next_ctid)"
    CTID="$REPLY"
  fi
  [[ "$CTID" =~ ^[0-9]+$ ]] || die "CTID must be numeric."
  if pct status "$CTID" &>/dev/null; then
    die "CTID ${CTID} already exists."
  fi

  prompt "Hostname" "$HOSTNAME"
  HOSTNAME="$REPLY"

  prompt "Disk size (GB)" "$DISK_SIZE"
  DISK_SIZE="$REPLY"

  prompt "CPU cores" "$CORE_COUNT"
  CORE_COUNT="$REPLY"

  prompt "RAM (MiB)" "$RAM_SIZE"
  RAM_SIZE="$REPLY"

  if [[ -z "$STORAGE" ]]; then
    prompt "Container storage" "$(detect_storage)"
    STORAGE="$REPLY"
  fi

  if [[ -z "$TEMPLATE_STORAGE" ]]; then
    prompt "Template storage" "$(detect_template_storage)"
    TEMPLATE_STORAGE="$REPLY"
  fi

  prompt "Bridge" "$BRIDGE"
  BRIDGE="$REPLY"

  prompt "IP config (dhcp or CIDR like 192.168.1.50/24)" "$STATIC_IP"
  STATIC_IP="$REPLY"
  if [[ "$STATIC_IP" != "dhcp" ]]; then
    prompt "Gateway" "${GATEWAY:-}"
    GATEWAY="$REPLY"
  fi

  if [[ -z "$PASSWORD" ]]; then
    prompt_secret "Root password for the LXC (empty = random)"
    PASSWORD="$REPLY"
  fi
  if [[ -z "$PASSWORD" ]]; then
    PASSWORD="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
    GENERATED_PASSWORD=1
  else
    GENERATED_PASSWORD=0
  fi

  echo
  msg_info "Application source (public GitHub by default — no Origin on the Proxmox host)"
  prompt "Git repository URL" "$DEFAULT_GIT_URL"
  DEFAULT_GIT_URL="$REPLY"
  prompt "Git branch" "$GIT_BRANCH"
  GIT_BRANCH="$REPLY"

  # Optional GitHub PAT only if the repo is private.
  if [[ "$DEFAULT_GIT_URL" == *"github.com"* ]] && [[ "$DEFAULT_GIT_URL" != *"@"* ]]; then
    echo -e "  Leave blank for a ${BOLD}public${CL} repo."
    prompt_secret "GitHub PAT (only if the repo is private)" ""
    if [[ -n "$REPLY" ]]; then
      # https://github.com/org/repo.git -> https://TOKEN@github.com/org/repo.git
      DEFAULT_GIT_URL="$(echo "$DEFAULT_GIT_URL" | sed -E "s#https://#https://${REPLY}@#")"
    fi
  fi

  echo
  msg_info "Proxmox API credentials used by Voxmox inside the LXC"
  if [[ -z "$PROXMOX_HOST_URL" ]]; then
    prompt "Proxmox API URL" "$(detect_host_url)"
    PROXMOX_HOST_URL="$REPLY"
  fi
  prompt "API token ID (user@realm!token)" "${PROXMOX_TOKEN_ID}"
  PROXMOX_TOKEN_ID="$REPLY"
  if [[ -n "$PROXMOX_TOKEN_ID" ]]; then
    prompt_secret "API token secret" "${PROXMOX_TOKEN_SECRET}"
    PROXMOX_TOKEN_SECRET="$REPLY"
  else
    msg_warn "No token provided — Voxmox will start in demo mode until you edit ${APP_DIR}/.env"
    PROXMOX_MOCK="true"
  fi
  prompt "Alexa skill ID (optional)" "${ALEXA_SKILL_ID}"
  ALEXA_SKILL_ID="$REPLY"

  if [[ -z "$OSTEMPLATE" ]]; then
    OSTEMPLATE="$(pick_debian_template "$TEMPLATE_STORAGE")"
  fi
}

create_container() {
  ensure_template "$TEMPLATE_STORAGE" "$OSTEMPLATE"

  local net_config="name=eth0,bridge=${BRIDGE}"
  if [[ "$STATIC_IP" == "dhcp" ]]; then
    net_config+=",ip=dhcp"
  else
    net_config+=",ip=${STATIC_IP}"
    [[ -n "$GATEWAY" ]] && net_config+=",gw=${GATEWAY}"
  fi

  local features="nesting=${NESTING}"
  local -a create_args=(
    "$CTID"
    "${TEMPLATE_STORAGE}:vztmpl/${OSTEMPLATE}"
    --hostname "$HOSTNAME"
    --cores "$CORE_COUNT"
    --memory "$RAM_SIZE"
    --swap "$SWAP_SIZE"
    --rootfs "${STORAGE}:${DISK_SIZE}"
    --net0 "$net_config"
    --unprivileged "$UNPRIVILEGED"
    --features "$features"
    --onboot 1
    --startup "order=99"
    --tags "voxmox;alexa;homelab"
    --password "$PASSWORD"
  )

  if [[ -n "$DNS" ]]; then
    create_args+=(--nameserver "$DNS")
  fi
  if [[ -n "$SSH_KEYS" && -f "$SSH_KEYS" ]]; then
    create_args+=(--ssh-public-keys "$SSH_KEYS")
  fi

  msg_info "Creating LXC ${CTID} (${HOSTNAME})"
  pct create "${create_args[@]}"
  msg_ok "LXC ${CTID} created"

  msg_info "Starting LXC ${CTID}"
  pct start "$CTID"
  # Wait for network / boot
  for _ in $(seq 1 30); do
    if pct exec "$CTID" -- true 2>/dev/null; then
      break
    fi
    sleep 1
  done
  msg_ok "LXC ${CTID} is running"
}

push_local_repo_if_available() {
  local root
  root="$(repo_root_from_script 2>/dev/null || true)"
  if [[ -n "$root" && -f "$root/package.json" && -d "$root/src" ]]; then
    msg_info "Found local Voxmox checkout at $root — copying into the LXC"
    pct exec "$CTID" -- bash -c "rm -rf '${APP_DIR}.incoming' && mkdir -p '${APP_DIR}.incoming'"
    tar -C "$root" \
      --exclude=node_modules \
      --exclude=.next \
      --exclude=.git \
      -cf - . |
      pct exec "$CTID" -- tar -C "${APP_DIR}.incoming" -xf -
    pct exec "$CTID" -- bash -c "rm -rf '${APP_DIR}' && mv '${APP_DIR}.incoming' '${APP_DIR}'"
    msg_ok "Application files copied from local checkout"
    return 0
  fi
  return 1
}

install_inside() {
  msg_info "Installing packages and Voxmox inside CT ${CTID}"

  local tmpdir
  tmpdir="$(mktemp -d)"

  stage_helper_file "install-voxmox.sh" "$tmpdir/install-voxmox.sh"
  stage_helper_file "voxmox.service" "$tmpdir/voxmox.service"
  stage_helper_file "update" "$tmpdir/voxmox-update.sh"

  pct push "$CTID" "$tmpdir/install-voxmox.sh" /tmp/install-voxmox.sh
  pct push "$CTID" "$tmpdir/voxmox.service" /tmp/voxmox.service
  pct push "$CTID" "$tmpdir/voxmox-update.sh" /tmp/voxmox-update.sh
  pct exec "$CTID" -- chmod +x /tmp/install-voxmox.sh /tmp/voxmox-update.sh
  rm -rf "$tmpdir"

  local used_local=0
  if push_local_repo_if_available; then
    used_local=1
  fi

  pct exec "$CTID" -- env \
    APP_DIR="$APP_DIR" \
    APP_USER="$APP_USER" \
    APP_PORT="$APP_PORT" \
    NODE_MAJOR="$NODE_MAJOR" \
    GIT_URL="$DEFAULT_GIT_URL" \
    GIT_BRANCH="$GIT_BRANCH" \
    USE_EXISTING_APP_DIR="$used_local" \
    PROXMOX_HOST_URL="$PROXMOX_HOST_URL" \
    PROXMOX_TOKEN_ID="$PROXMOX_TOKEN_ID" \
    PROXMOX_TOKEN_SECRET="$PROXMOX_TOKEN_SECRET" \
    PROXMOX_MOCK="$PROXMOX_MOCK" \
    ALEXA_SKILL_ID="$ALEXA_SKILL_ID" \
    SKIP_BUILD="$SKIP_BUILD" \
    bash /tmp/install-voxmox.sh

  msg_ok "Voxmox installed inside CT ${CTID}"
}

print_summary() {
  local ip
  ip="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -n "$ip" ]] || ip="<CT-IP>"

  echo
  msg_ok "${APP} LXC is ready"
  echo -e "  ${BOLD}CTID:${CL}      ${CTID}"
  echo -e "  ${BOLD}Hostname:${CL}  ${HOSTNAME}"
  echo -e "  ${BOLD}Dashboard:${CL} http://${ip}:${APP_PORT}"
  echo -e "  ${BOLD}Alexa URL:${CL} http://${ip}:${APP_PORT}/api/alexa"
  echo -e "  ${BOLD}App dir:${CL}   ${APP_DIR}"
  echo -e "  ${BOLD}Service:${CL}   systemctl status voxmox   (inside CT)"
  if [[ "${GENERATED_PASSWORD:-0}" == "1" ]]; then
    echo -e "  ${BOLD}Root PW:${CL}   ${PASSWORD}"
  fi
  echo
  echo -e "  ${YW}Next steps${CL}"
  echo "  1. Open the dashboard and confirm demo or live cluster data."
  echo "  2. Edit ${APP_DIR}/.env inside the CT if you need to change API tokens."
  echo "  3. Expose HTTPS to Alexa (Cloudflare Tunnel / reverse proxy) → /api/alexa"
  echo "  4. Import alexa/interaction-model.json in the Alexa Developer Console."
  echo
  echo -e "  ${BL}Useful commands${CL}"
  echo "  pct enter ${CTID}"
  echo "  pct exec ${CTID} -- systemctl status voxmox --no-pager"
  echo "  pct exec ${CTID} -- journalctl -u voxmox -f"
  echo "  pct exec ${CTID} -- update"
  echo
}

main() {
  need_root
  need_proxmox

  # Allow fully non-interactive runs when CTID and required vars are preset.
  if [[ -n "${CTID}" && "${VOXMOX_NONINTERACTIVE:-0}" == "1" ]]; then
    STORAGE="${STORAGE:-$(detect_storage)}"
    TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-$(detect_template_storage)}"
    OSTEMPLATE="${OSTEMPLATE:-$(pick_debian_template "$TEMPLATE_STORAGE")}"
    PROXMOX_HOST_URL="${PROXMOX_HOST_URL:-$(detect_host_url)}"
    if [[ -z "$PASSWORD" ]]; then
      PASSWORD="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
      GENERATED_PASSWORD=1
    fi
  else
    collect_settings
  fi

  create_container
  install_inside
  print_summary
}

main "$@"
