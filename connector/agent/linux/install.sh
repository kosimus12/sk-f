#!/usr/bin/env bash
# Installiert den Connector-Agent auf einem Linux-Host (z.B. dem Hetzner-Server
# selbst, damit Claude ihn wie jedes andere Geraet ansprechen kann).
#
#   sudo bash install.sh --hub https://hub.example.de --code skc_enr_xxx
set -euo pipefail

HUB=""
CODE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB="$2"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then echo "Bitte mit sudo starten." >&2; exit 1; fi
if [[ -z "$HUB" || -z "$CODE" ]]; then
  echo "Aufruf: sudo bash install.sh --hub https://... --code skc_enr_..." >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBEXEC=/usr/local/libexec/skconnector

install -d -m 0755 "$LIBEXEC"
install -m 0755 "$SRC_DIR/agent.py" "$LIBEXEC/agent.py"
install -d -m 0700 /etc/skconnector

CONNECTOR_STATE=/etc/skconnector/agent.json \
  /usr/bin/python3 "$LIBEXEC/agent.py" register --hub "$HUB" --code "$CODE"

install -m 0644 "$SRC_DIR/linux/skconnector-agent.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now skconnector-agent
systemctl --no-pager --lines=5 status skconnector-agent || true
