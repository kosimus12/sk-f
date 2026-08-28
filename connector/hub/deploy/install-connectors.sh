#!/usr/bin/env bash
# Legt pro Geraet einen eigenen Connector an - einzeln an- und abwaehlbar.
#
#   sudo bash install-connectors.sh
#   sudo bash install-connectors.sh --ceiling full --devices mac-simon
#
# Je Geraet entstehen: ein abgestuftes Token (nur dieses Geraet), ein eigener
# Dienst auf eigenem Port, ein eigener geheimer Pfad und eine eigene URL. In
# Claude erscheinen sie als drei Connectors, die sich getrennt schalten lassen.
set -euo pipefail

CEILING="readonly"
DEVICES="mac-simon mac-katya hetzner"
PORT_BASIS=8791
CADDY_ANWENDEN=1
NEUER_PFAD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ceiling)    CEILING="$2"; shift 2 ;;
    --devices)    DEVICES="${2//,/ }"; shift 2 ;;
    --port-basis) PORT_BASIS="$2"; shift 2 ;;
    --kein-caddy) CADDY_ANWENDEN=0; shift ;;
    --neuer-pfad) NEUER_PFAD=1; shift ;;
    -h|--help)    sed -n '2,10p' "$0"; exit 0 ;;
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

HUB_LISTEN="$(ss -lntp 2>/dev/null | awk '/:8787 /{print $4; exit}')"
[[ -n "$HUB_LISTEN" ]] || { fehler "Nichts lauscht auf Port 8787."; exit 1; }
HUB_ADDR="${HUB_LISTEN%:*}"
[[ "$HUB_ADDR" == "0.0.0.0" || "$HUB_ADDR" == "*" ]] && HUB_ADDR="127.0.0.1"
HUB_URL="http://${HUB_ADDR}:8787"
curl -sf --max-time 10 "$HUB_URL/healthz" >/dev/null \
  || { fehler "$HUB_URL/healthz antwortet nicht."; exit 1; }
ok "Hub erreichbar ueber $HUB_URL"

BEKANNT="$(curl -sf --max-time 10 -H "Authorization: Bearer $MASTER" "$HUB_URL/v1/devices" \
  | python3 -c "import json,sys; print(' '.join(d['id'] for d in json.load(sys.stdin)['devices']))")"
for GERAET in $DEVICES; do
  grep -qw "$GERAET" <<<"$BEKANNT" || {
    fehler "Geraet '$GERAET' kennt der Hub nicht. Bekannt: $BEKANNT"; exit 1; }
done
ok "Geraete vorhanden: $DEVICES"

# ---------------------------------------------------------------------------
schritt "2/6  Reverse-Proxy finden"

CADDY="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i caddy | head -1 || true)"
if [[ -n "$CADDY" ]]; then
  GATEWAY="$(docker inspect "$CADDY" \
    -f '{{range $k,$v := .NetworkSettings.Networks}}{{$v.Gateway}}{{"\n"}}{{end}}' | head -1)"
  CADDYFILE="$(docker inspect "$CADDY" \
    -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')"
  ok "Caddy: $CADDY (Gateway $GATEWAY, Datei $CADDYFILE)"
else
  GATEWAY="127.0.0.1"; CADDYFILE=""
  warn "Kein Caddy-Container gefunden - binde auf 127.0.0.1."
fi

OEFFENTLICH="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src") print $(i+1); exit}')"
[[ -n "$OEFFENTLICH" ]] || OEFFENTLICH="$(hostname -I | awk '{print $1}')"
HOSTNAME_MCP="mcp.${OEFFENTLICH}.sslip.io"
ok "Hostname: $HOSTNAME_MCP"

# ---------------------------------------------------------------------------
schritt "3/6  Programmstand aktualisieren"

cp -r "$SRC_DIR/mcp-server" "$APP_DIR/"
chown -R root:skconnector "$APP_DIR/mcp-server"
if [[ ! -x "$APP_DIR/venv-mcp/bin/python" ]]; then
  python3 -m venv "$APP_DIR/venv-mcp"
fi
"$APP_DIR/venv-mcp/bin/pip" install -q --upgrade pip
"$APP_DIR/venv-mcp/bin/pip" install -q -r "$APP_DIR/mcp-server/requirements.txt"
chown -R root:skconnector "$APP_DIR/venv-mcp"
cp "$SRC_DIR/hub/deploy/skconnector-mcp@.service" /etc/systemd/system/
systemctl daemon-reload
ok "mcp-server, venv-mcp und Template-Unit sind aktuell"

# ---------------------------------------------------------------------------
schritt "4/6  Pro Geraet: Token, Dienst, geheimer Pfad"

install -d -m 0750 -o root -g skconnector "$CONF"
INST="$SRC_DIR/hub/deploy/instances.py"

for GERAET in $DEVICES; do
  LABEL="conn-$GERAET"

  # Port und geheimer Pfad kommen aus dem Bestand, nicht aus der Position in
  # der Liste. Sonst bekommt ein Lauf mit --devices einen schon belegten Port,
  # und eine bereits in Claude eingetragene URL wird ohne Not ungueltig.
  PORT="$(python3 "$INST" port "$CONF" "$GERAET" "$PORT_BASIS")"
  GEHEIM="$(python3 "$INST" secret "$CONF" "$GERAET")"
  if [[ -z "$GEHEIM" || "$NEUER_PFAD" == "1" ]]; then
    GEHEIM="$(openssl rand -hex 32)"
    NEU_MARKE="  (neue URL)"
  else
    NEU_MARKE=""
  fi

  curl -s -o /dev/null -X DELETE "$HUB_URL/v1/control-tokens/$LABEL" \
    -H "Authorization: Bearer $MASTER" || true

  ANTWORT="$(curl -s -w $'\n%{http_code}' -X POST "$HUB_URL/v1/control-tokens" \
    -H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json' \
    -d "{\"label\":\"$LABEL\",\"ceiling\":\"$CEILING\",\"devices\":[\"$GERAET\"]}")"
  CODE="$(tail -1 <<<"$ANTWORT")"
  BODY="$(sed '$d' <<<"$ANTWORT")"
  [[ "$CODE" == "200" ]] || { fehler "Token fuer $GERAET (HTTP $CODE): $BODY"; exit 1; }
  SCOPED="$(python3 -c "import json,sys; print(json.load(sys.stdin)['token'])" <<<"$BODY")"

  ENVDATEI="$CONF/mcp-$GERAET.env"
  install -m 0640 -o root -g skconnector /dev/null "$ENVDATEI"
  cat > "$ENVDATEI" <<ENVEOF
# Abgestuftes Token, nur fuer '$GERAET'. Obergrenze: $CEILING
CONNECTOR_CONTROL_TOKEN=$SCOPED
CONNECTOR_HUB_URL=$HUB_URL
CONNECTOR_DEVICE=$GERAET
CONNECTOR_MCP_NAME=$GERAET
CONNECTOR_MCP_BIND=$GATEWAY
CONNECTOR_MCP_PORT=$PORT
# Nur fuer den Installer - der Dienst liest das nicht.
CONNECTOR_SECRET_PATH=$GEHEIM
ENVEOF
  chmod 0640 "$ENVDATEI"; chown root:skconnector "$ENVDATEI"

  systemctl enable "skconnector-mcp@$GERAET" >/dev/null 2>&1
  systemctl restart "skconnector-mcp@$GERAET"
  ok "$GERAET: Port $PORT, Token '$LABEL' (nur dieses Geraet, $CEILING)$NEU_MARKE"
done

sleep 3
for GERAET in $DEVICES; do
  systemctl is-active --quiet "skconnector-mcp@$GERAET" || {
    fehler "skconnector-mcp@$GERAET kommt nicht hoch:"
    journalctl -u "skconnector-mcp@$GERAET" -n 20 --no-pager | sed 's/^/    /'
    exit 1; }
done
ok "Alle Dienste laufen"

# Der Block enthaelt IMMER alle eingerichteten Geraete, nicht nur die dieses
# Laufs - sonst faellt beim naechsten '--devices' der Rest aus dem Netz.
BLOCK="$CONF/caddy-connectors.conf"
install -m 0600 -o root -g root /dev/null "$BLOCK"
python3 "$INST" block "$CONF" "$HOSTNAME_MCP" "$GATEWAY" > "$BLOCK"
chmod 0600 "$BLOCK"
ok "Caddy-Block umfasst: $(python3 "$INST" urls "$CONF" "$HOSTNAME_MCP" | cut -f1 | tr '\n' ' ')"

# ---------------------------------------------------------------------------
schritt "5/6  Caddy"

if [[ "$CADDY_ANWENDEN" == "1" && -n "$CADDYFILE" && -f "$CADDYFILE" ]]; then
  # Ersetzt genau den Block mit diesem Hostnamen, laesst alles andere stehen
  # und legt vorher eine Kopie an. Schlaegt der Reload fehl, wird sie
  # zurueckgespielt - der Nachbar-Stack darf davon nichts merken.
  KOPIE="$(python3 "$SRC_DIR/hub/deploy/caddy_block.py" einfuegen "$CADDYFILE" "$BLOCK")"
  if [[ "$KOPIE" == "unveraendert" ]]; then
    ok "Caddyfile war schon aktuell"
  else
    ok "Caddyfile angepasst (Sicherung: $KOPIE)"
    if docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile 2>&1 | sed 's/^/    /'; then
      ok "Caddy neu geladen"
    else
      fehler "Caddy lehnt die Konfiguration ab - spiele die Sicherung zurueck."
      cp "$KOPIE" "$CADDYFILE"
      docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
      exit 1
    fi
  fi
else
  warn "Caddy nicht angefasst. Block liegt in $BLOCK."
fi

# Der alte Sammel-Connector hing am selben Hostnamen und ist damit nicht mehr
# erreichbar. Laufen lassen waere nur eine offene Tuer ohne Klinke.
if systemctl is-active --quiet skconnector-mcp 2>/dev/null; then
  warn "Der alte Sammel-Dienst 'skconnector-mcp' laeuft noch, seine URL geht"
  warn "aber ins Leere. Abschalten:"
  warn "    sudo systemctl disable --now skconnector-mcp"
  warn "    python3 tools/skconnect.py token-revoke chat"
fi

# ---------------------------------------------------------------------------
schritt "6/6  In Claude eintragen"

cat <<TEXT

    Einstellungen > Connectors > Custom Connector hinzufuegen,
    einmal pro Zeile. Jeder laesst sich danach einzeln an- und abschalten.

TEXT
python3 "$INST" urls "$CONF" "$HOSTNAME_MCP" | while IFS=$'\t' read -r GERAET URL; do
  echo "        $GERAET"
  echo "            $URL"
  echo
done

echo "${GELB}    Diese URLs sind Passwoerter.${AUS} Nicht in Chats, nicht in Screenshots,"
echo "    nicht ins Repo. Sie stehen auch in $BLOCK (0600)."
echo
echo "${BLAU}    Stufe eines Geraets aendern, ohne die URL zu verlieren:${AUS}"
echo "        sudo bash hub/deploy/install-connectors.sh --devices <geraet> --ceiling full"
echo
echo "${BLAU}    Nur die URL erneuern (wenn sie irgendwo gelandet ist, wo sie nicht hingehoert):${AUS}"
echo "        sudo bash hub/deploy/install-connectors.sh --devices <geraet> --neuer-pfad"
echo
echo "${BLAU}    Einen Connector wieder loswerden:${AUS}"
echo "        python3 tools/skconnect.py token-revoke conn-<geraet>"
echo "        sudo systemctl disable --now skconnector-mcp@<geraet>"
echo "        sudo rm $CONF/mcp-<geraet>.env"
echo "        sudo bash hub/deploy/install-connectors.sh --devices <ein-verbleibendes-geraet>"
echo
echo "${GRUEN}==> Fertig.${AUS}"
