#!/usr/bin/env bash
# Richtet den Remote-MCP-Endpunkt fuer Claude Chat und Cowork ein.
#
# Auf dem Hetzner als root ausfuehren, wenn der Hub bereits laeuft:
#
#   sudo bash install-mcp.sh --label chat --ceiling readonly
#   sudo bash install-mcp.sh --label chat --ceiling readonly --devices mac-simon
#
# Das Skript stellt ein ABGESTUFTES Control-Token aus, legt den Dienst an und
# druckt am Ende den Caddy-Block, den du von Hand einfuegst. Das Master-Token
# fasst es nur an, um daraus ein schwaecheres abzuleiten - es landet nirgends
# in der Konfiguration des MCP-Dienstes.
set -euo pipefail

LABEL="chat"
CEILING="readonly"
DEVICES=""
PORT=8788

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)   LABEL="$2"; shift 2 ;;
    --ceiling) CEILING="$2"; shift 2 ;;
    --devices) DEVICES="$2"; shift 2 ;;
    --port)    PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
  esac
done

BLAU=$'\033[1;34m'; GRUEN=$'\033[0;32m'; ROT=$'\033[0;31m'; GELB=$'\033[0;33m'; AUS=$'\033[0m'
schritt() { echo; echo "${BLAU}==> $*${AUS}"; }
ok()      { echo "    ${GRUEN}OK${AUS}    $*"; }
warn()    { echo "    ${GELB}!${AUS}     $*"; }
fehler()  { echo "    ${ROT}FEHLER${AUS} $*"; }

[[ $EUID -eq 0 ]] || { fehler "Bitte mit sudo starten."; exit 1; }
case "$CEILING" in notify|readonly|full) ;; *)
  fehler "--ceiling muss notify, readonly oder full sein."; exit 1 ;;
esac

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR=/opt/skconnector
CONF=/etc/skconnector

# ---------------------------------------------------------------------------
schritt "1/6  Hub pruefen"

[[ -f "$CONF/hub.env" ]] || { fehler "$CONF/hub.env fehlt - laeuft der Hub?"; exit 1; }
MASTER="$(grep -oP '(?<=CONNECTOR_CONTROL_TOKEN=).*' "$CONF/hub.env" | head -1)"
[[ -n "$MASTER" ]] || { fehler "Kein Control-Token in hub.env."; exit 1; }

# Der Hub lauscht je nach Einrichtung auf 127.0.0.1, 0.0.0.0 oder dem
# Docker-Gateway. Die echte Adresse aus ss lesen statt zu raten - sonst
# telefoniert der MCP-Dienst gegen eine Wand.
HUB_LISTEN="$(ss -lntp 2>/dev/null | awk '/:8787 /{print $4; exit}')"
[[ -n "$HUB_LISTEN" ]] || { fehler "Nichts lauscht auf Port 8787."; exit 1; }
HUB_ADDR="${HUB_LISTEN%:*}"
[[ "$HUB_ADDR" == "0.0.0.0" || "$HUB_ADDR" == "*" ]] && HUB_ADDR="127.0.0.1"
HUB_URL="http://${HUB_ADDR}:8787"
ok "Hub lauscht auf $HUB_LISTEN, erreichbar ueber $HUB_URL"

curl -sf --max-time 10 "$HUB_URL/healthz" >/dev/null \
  || { fehler "$HUB_URL/healthz antwortet nicht."; exit 1; }
ok "healthz antwortet"

# ---------------------------------------------------------------------------
schritt "2/6  Reverse-Proxy finden"

CADDY="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i caddy | head -1 || true)"
if [[ -n "$CADDY" ]]; then
  GATEWAY="$(docker inspect "$CADDY" \
    -f '{{range $k,$v := .NetworkSettings.Networks}}{{$v.Gateway}}{{"\n"}}{{end}}' \
    | head -1)"
  ok "Caddy-Container: $CADDY (Gateway $GATEWAY)"
else
  GATEWAY="127.0.0.1"
  warn "Kein Caddy-Container gefunden - binde auf 127.0.0.1."
  warn "Den Reverse-Proxy musst du dann selbst verdrahten."
fi

# ---------------------------------------------------------------------------
schritt "3/6  Abgestuftes Token ausstellen"

DEV_JSON="[]"
if [[ -n "$DEVICES" ]]; then
  DEV_JSON="$(python3 -c "import json,sys; print(json.dumps([d for d in sys.argv[1].split(',') if d]))" "$DEVICES")"
fi

ANTWORT="$(curl -sf -X POST "$HUB_URL/v1/control-tokens" \
  -H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json' \
  -d "{\"label\":\"$LABEL\",\"ceiling\":\"$CEILING\",\"devices\":$DEV_JSON}")" \
  || { fehler "Token konnte nicht ausgestellt werden. Laeuft eine Hub-Version mit Token-Verwaltung? (git pull, Dienst neu starten)"; exit 1; }

SCOPED="$(python3 -c "import json,sys; print(json.load(sys.stdin)['token'])" <<<"$ANTWORT")"
ok "Token '$LABEL' ausgestellt, Obergrenze '$CEILING'${DEVICES:+, nur $DEVICES}"

install -m 0640 -o root -g skconnector /dev/null "$CONF/mcp.env"
cat > "$CONF/mcp.env" <<ENVEOF
# Abgestuftes Token - NICHT das Master-Token. Obergrenze: $CEILING
CONNECTOR_CONTROL_TOKEN=$SCOPED
CONNECTOR_HUB_URL=$HUB_URL
CONNECTOR_MCP_BIND=$GATEWAY
CONNECTOR_MCP_PORT=$PORT
ENVEOF
chmod 0640 "$CONF/mcp.env"
chown root:skconnector "$CONF/mcp.env"
ok "$CONF/mcp.env geschrieben (0640 root:skconnector)"

# ---------------------------------------------------------------------------
schritt "4/6  Dienst installieren"

cp -r "$SRC_DIR/mcp-server" "$APP_DIR/"
"$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/mcp-server/requirements.txt"
chown -R root:skconnector "$APP_DIR/mcp-server"

cp "$SRC_DIR/hub/deploy/skconnector-mcp.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now skconnector-mcp
sleep 3

if systemctl is-active --quiet skconnector-mcp && ss -lntp | grep -q ":$PORT "; then
  ok "skconnector-mcp laeuft auf $(ss -lntp | awk -v p=":$PORT " '$0 ~ p {print $4; exit}')"
else
  fehler "Dienst kommt nicht hoch:"
  journalctl -u skconnector-mcp -n 25 --no-pager | sed 's/^/    /'
  exit 1
fi

# ---------------------------------------------------------------------------
schritt "5/6  Geheimen Pfad erzeugen"

GEHEIM="$(openssl rand -hex 32)"
HOSTNAME_MCP="mcp.$(hostname -I | awk '{print $1}').sslip.io"
ok "Pfad erzeugt (steht unten im Caddy-Block)"

# ---------------------------------------------------------------------------
schritt "6/6  Was du jetzt von Hand machst"

CADDYFILE="$(docker inspect "${CADDY:-x}" -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"

cat <<TEXT

    Diesen Block an ${CADDYFILE:-deinen Caddyfile} anhaengen:

mcp.HOSTNAME {
    handle_path /$GEHEIM/* {
        reverse_proxy $GATEWAY:$PORT {
            transport http {
                read_timeout 300s
                write_timeout 300s
            }
        }
    }
    handle {
        respond "Not found" 404
    }
}

    Vorschlag fuer HOSTNAME (kein DNS-Eintrag noetig):
        $HOSTNAME_MCP

    Danach neu laden:
        docker exec ${CADDY:-CADDY-CONTAINER} caddy reload --config /etc/caddy/Caddyfile

    Und in Claude eintragen unter Einstellungen > Connectors >
    Custom Connector hinzufuegen:

        Name:  SK Connector
        URL:   https://$HOSTNAME_MCP/$GEHEIM/mcp

TEXT

echo "${GELB}    Diese URL ist ein Passwort.${AUS} Wer sie kennt, hat den Zugriff,"
echo "    den das Token '$LABEL' erlaubt (Obergrenze: $CEILING)."
echo "    Nicht in Chats, nicht in Screenshots, nicht ins Repo."
echo
echo "${BLAU}    Stufe spaeter aendern:${AUS}"
echo "        skconnect.py token-revoke $LABEL"
echo "        skconnect.py token-issue $LABEL --ceiling <notify|readonly|full>"
echo "        sudo nano $CONF/mcp.env   # neues Token eintragen"
echo "        sudo systemctl restart skconnector-mcp"
echo
echo "${GRUEN}==> Dienst laeuft. Es fehlen nur noch Caddy-Block und Connector-Eintrag.${AUS}"
