#!/usr/bin/env bash
# Installiert den Connector-Agent auf einem Mac als LaunchDaemon.
#
#   sudo bash install.sh --hub https://hub.example.de --code skc_enr_xxx [--keep-awake]
#
# --keep-awake  Schlaf-Einstellungen so setzen, dass der Mac am Netzteil
#               erreichbar bleibt, auch wenn der Bildschirm gesperrt ist.
#               Auf einem MacBook nur mit --keep-awake-aggressive auch bei
#               geschlossenem Deckel (kostet Akku, siehe README).
set -euo pipefail

HUB=""
CODE=""
KEEP_AWAKE=0
AGGRESSIVE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB="$2"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --keep-awake) KEEP_AWAKE=1; shift ;;
    --keep-awake-aggressive) KEEP_AWAKE=1; AGGRESSIVE=1; shift ;;
    *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Bitte mit sudo starten." >&2
  exit 1
fi
if [[ -z "$HUB" || -z "$CODE" ]]; then
  echo "Aufruf: sudo bash install.sh --hub https://... --code skc_enr_..." >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBEXEC=/usr/local/libexec/skconnector
LABEL=de.skfinanzberatung.connector
PLIST="/Library/LaunchDaemons/${LABEL}.plist"

echo "==> Python pruefen"
if ! /usr/bin/python3 --version >/dev/null 2>&1; then
  echo "    /usr/bin/python3 fehlt. Einmalig 'xcode-select --install' ausfuehren." >&2
  exit 1
fi

echo "==> Dateien ablegen"
install -d -m 0755 "$LIBEXEC"
install -m 0755 "$SRC_DIR/agent.py" "$LIBEXEC/agent.py"
install -d -m 0700 /etc/skconnector
install -d -m 0755 /var/log/skconnector

echo "==> Beim Hub registrieren"
CONNECTOR_STATE=/etc/skconnector/agent.json \
  /usr/bin/python3 "$LIBEXEC/agent.py" register --hub "$HUB" --code "$CODE"

echo "==> LaunchDaemon einrichten"
if [[ -f "$PLIST" ]]; then
  launchctl bootout system "$PLIST" 2>/dev/null || true
fi
install -m 0644 -o root -g wheel "$SRC_DIR/macos/${LABEL}.plist" "$PLIST"
if [[ $KEEP_AWAKE -eq 0 ]]; then
  # CONNECTOR_KEEP_AWAKE auf 0 setzen, wenn der Nutzer das nicht will.
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:CONNECTOR_KEEP_AWAKE 0" "$PLIST"
fi
launchctl bootstrap system "$PLIST"
launchctl enable "system/${LABEL}"

if [[ $KEEP_AWAKE -eq 1 ]]; then
  echo "==> Energieeinstellungen fuer dauerhafte Erreichbarkeit"
  # Am Netzteil: nicht schlafen, Display darf aus - Agent laeuft weiter.
  pmset -c sleep 0 displaysleep 10 disksleep 0
  # Aufwachen bei Netzwerkzugriff und Power Nap - hilft nach Ruhezustand.
  pmset -a womp 1 2>/dev/null || true
  pmset -a powernap 1 2>/dev/null || true
  if [[ $AGGRESSIVE -eq 1 ]]; then
    # Auch mit geschlossenem Deckel wach bleiben. Nur mit Netzteil sinnvoll.
    pmset -a disablesleep 1
    echo "    disablesleep=1 gesetzt (Ruecknahme: sudo pmset -a disablesleep 0)"
  fi
  pmset -g custom | sed 's/^/    /'
fi

echo
echo "==> Fertig. Status pruefen:"
echo "    sudo launchctl print system/${LABEL} | head -20"
echo "    tail -f /var/log/skconnector/agent.log"
echo
echo "    Hinweis: Fuer 'shell'-Kommandos, die auf Dateien in Dokumente/"
echo "    Schreibtisch/Downloads zugreifen, muss /bin/bash einmalig unter"
echo "    Systemeinstellungen > Datenschutz & Sicherheit > Festplattenvollzugriff"
echo "    freigegeben werden."
