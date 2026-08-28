#!/usr/bin/env bash
# Bringt den laufenden Hub und die MCP-Dienste auf den Stand des Git-Verzeichnisses.
#
#   cd /opt/src/sk-f && git pull && cd connector
#   sudo bash hub/deploy/update.sh
#
# Warum es das braucht: Der Hub laeuft aus /opt/skconnector/hub, nicht aus dem
# Arbeitsverzeichnis. Ein 'git pull' aendert am laufenden Dienst nichts - neue
# Endpunkte antworten dann mit 404, und man sucht an der falschen Stelle.
set -euo pipefail

BLAU=$'\033[1;34m'; GRUEN=$'\033[0;32m'; ROT=$'\033[0;31m'; GELB=$'\033[0;33m'; AUS=$'\033[0m'
schritt() { echo; echo "${BLAU}==> $*${AUS}"; }
ok()      { echo "    ${GRUEN}OK${AUS}    $*"; }
warn()    { echo "    ${GELB}!${AUS}     $*"; }
fehler()  { echo "    ${ROT}FEHLER${AUS} $*"; }

[[ $EUID -eq 0 ]] || { fehler "Bitte mit sudo starten."; exit 1; }

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR=/opt/skconnector
CONF=/etc/skconnector

HUB_LISTEN="$(ss -lntp 2>/dev/null | awk '/:8787 /{print $4; exit}')"
HUB_ADDR="${HUB_LISTEN%:*}"
[[ -z "$HUB_ADDR" || "$HUB_ADDR" == "0.0.0.0" || "$HUB_ADDR" == "*" ]] && HUB_ADDR="127.0.0.1"
HUB_URL="http://${HUB_ADDR}:8787"

gesund() { curl -sf --max-time 3 "$HUB_URL/healthz" >/dev/null; }
warte_auf_hub() { for _ in $(seq 1 20); do gesund && return 0; sleep 1; done; return 1; }

# ---------------------------------------------------------------------------
schritt "1/4  Stand pruefen"

STAND="$(cd "$SRC_DIR/.." && git log --oneline -1 2>/dev/null || echo unbekannt)"
ok "Arbeitsverzeichnis: $STAND"

# ---------------------------------------------------------------------------
schritt "2/4  Programmstand uebernehmen"

# Kopie des laufenden Stands, damit ein Fehlstart nicht in einer Sackgasse endet.
SICHERUNG="$APP_DIR/hub.bak-$(date +%Y%m%d-%H%M%S)"
cp -r "$APP_DIR/hub" "$SICHERUNG"
ok "Sicherung: $SICHERUNG"

rsync -a --delete --exclude '__pycache__' "$SRC_DIR/hub/" "$APP_DIR/hub/" 2>/dev/null \
  || { rm -rf "$APP_DIR/hub"; cp -r "$SRC_DIR/hub" "$APP_DIR/"; }
[[ -d "$SRC_DIR/mcp-server" ]] && cp -r "$SRC_DIR/mcp-server" "$APP_DIR/"
chown -R root:skconnector "$APP_DIR/hub" "$APP_DIR/mcp-server" 2>/dev/null || true
ok "hub und mcp-server aktualisiert"

"$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/hub/requirements.txt"
if [[ -x "$APP_DIR/venv-mcp/bin/pip" && -f "$APP_DIR/mcp-server/requirements.txt" ]]; then
  "$APP_DIR/venv-mcp/bin/pip" install -q -r "$APP_DIR/mcp-server/requirements.txt"
fi
ok "Abhaengigkeiten geprueft"

# ---------------------------------------------------------------------------
schritt "3/4  Dienste neu starten"

systemctl restart skconnector-hub
if warte_auf_hub; then
  ok "Hub laeuft: $(curl -s --max-time 3 "$HUB_URL/healthz")"
else
  fehler "Hub kommt nicht hoch - spiele die Sicherung zurueck."
  journalctl -u skconnector-hub -n 25 --no-pager | sed 's/^/    /'
  rm -rf "$APP_DIR/hub"
  mv "$SICHERUNG" "$APP_DIR/hub"
  systemctl restart skconnector-hub
  warte_auf_hub && warn "Alter Stand laeuft wieder." || fehler "Auch der alte Stand startet nicht."
  exit 1
fi

for DIENST in $(systemctl list-units --type=service --all --no-legend 'skconnector-mcp@*' \
                | awk '{print $1}'); do
  systemctl restart "$DIENST" && ok "$DIENST neu gestartet"
done

# ---------------------------------------------------------------------------
schritt "4/4  Neue Endpunkte pruefen"

MASTER="$(grep -oP '(?<=CONNECTOR_CONTROL_TOKEN=).*' "$CONF/hub.env" | head -1 || true)"
if [[ -n "$MASTER" ]]; then
  for PFAD in /v1/control-tokens /v1/unlock; do
    CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      -H "Authorization: Bearer $MASTER" "$HUB_URL$PFAD")"
    [[ "$CODE" == "200" ]] && ok "$PFAD antwortet" || warn "$PFAD antwortet mit $CODE"
  done
fi

# Alte Sicherungen aufraeumen, die letzten drei bleiben.
ls -1dt "$APP_DIR"/hub.bak-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
rm -rf "$SICHERUNG"

echo
echo "${GRUEN}==> Aktualisiert.${AUS}"
