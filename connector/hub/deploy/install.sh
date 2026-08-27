#!/usr/bin/env bash
# Installiert den Connector-Hub auf dem Hetzner-Server (Debian/Ubuntu).
# Aufruf als root:   bash install.sh
set -euo pipefail

APP_DIR=/opt/skconnector
DATA_DIR=/var/lib/skconnector
CONF_DIR=/etc/skconnector
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "==> Systempakete"
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip

echo "==> Dienstbenutzer"
id -u skconnector >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin skconnector
install -d -o skconnector -g skconnector -m 0750 "$DATA_DIR"
install -d -o root -g skconnector -m 0750 "$CONF_DIR"

echo "==> Code nach $APP_DIR"
install -d "$APP_DIR"
cp -r "$SRC_DIR/hub" "$APP_DIR/"
python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install -q --upgrade pip
"$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/hub/requirements.txt"
chown -R root:skconnector "$APP_DIR"

echo "==> Control-Token"
if [[ ! -f "$CONF_DIR/hub.env" ]]; then
  TOKEN="skc_ctl_$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
  printf 'CONNECTOR_CONTROL_TOKEN=%s\n' "$TOKEN" > "$CONF_DIR/hub.env"
  chown root:skconnector "$CONF_DIR/hub.env"
  chmod 0640 "$CONF_DIR/hub.env"
  echo
  echo "    Neues Control-Token (einmalig angezeigt, sicher speichern):"
  echo "    $TOKEN"
  echo
else
  echo "    $CONF_DIR/hub.env existiert bereits - unveraendert gelassen."
fi

echo "==> systemd"
cp "$SRC_DIR/hub/deploy/skconnector-hub.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now skconnector-hub
sleep 2
systemctl --no-pager --lines=5 status skconnector-hub || true

echo
echo "==> Fertig. Naechster Schritt: Caddy als TLS-Terminierung einrichten"
echo "    (siehe hub/deploy/Caddyfile) und den Hostnamen dort eintragen."
echo "    Test:  curl -s https://DEIN-HOST/healthz"
