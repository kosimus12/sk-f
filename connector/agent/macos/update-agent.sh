#!/usr/bin/env bash
# Bringt den laufenden Agenten auf einem Mac auf den Stand des Git-Verzeichnisses.
#
#   cd /pfad/zu/sk-f && git pull && cd connector
#   sudo bash agent/macos/update-agent.sh
#
# Warum es das braucht: Der Agent laeuft aus /usr/local/libexec/skconnector,
# nicht aus dem Arbeitsverzeichnis. Ein 'git pull' aendert daran nichts -
# Fehler, die im Repo laengst behoben sind, bleiben auf dem Geraet bestehen.
# Genau so ist '~' beim Schreiben monatelang auf /var/root gezeigt.
set -euo pipefail

GRUEN=$'\033[0;32m'; ROT=$'\033[0;31m'; GELB=$'\033[0;33m'; BLAU=$'\033[1;34m'; AUS=$'\033[0m'
ok()     { echo "    ${GRUEN}OK${AUS}    $*"; }
warn()   { echo "    ${GELB}!${AUS}     $*"; }
fehler() { echo "    ${ROT}FEHLER${AUS} $*"; }

[[ $EUID -eq 0 ]] || { fehler "Bitte mit sudo starten."; exit 1; }

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIBEXEC=/usr/local/libexec/skconnector
LABEL=de.skfinanzberatung.connector

[[ -f "$LIBEXEC/agent.py" ]] || { fehler "$LIBEXEC/agent.py fehlt - erst install.sh laufen lassen."; exit 1; }

echo; echo "${BLAU}==> Agent aktualisieren${AUS}"

ALT="$(md5 -q "$LIBEXEC/agent.py" 2>/dev/null || md5sum "$LIBEXEC/agent.py" | cut -d' ' -f1)"
NEU="$(md5 -q "$SRC/agent/agent.py" 2>/dev/null || md5sum "$SRC/agent/agent.py" | cut -d' ' -f1)"
if [[ "$ALT" == "$NEU" ]]; then
  ok "Agent ist bereits aktuell."
  exit 0
fi

SICHERUNG="$LIBEXEC/agent.py.bak-$(date +%Y%m%d-%H%M%S)"
cp "$LIBEXEC/agent.py" "$SICHERUNG"
cp "$SRC/agent/agent.py" "$LIBEXEC/agent.py"
chmod 0755 "$LIBEXEC/agent.py"
chown root:wheel "$LIBEXEC/agent.py"
ok "agent.py ersetzt (Sicherung: $SICHERUNG)"

# Ein Neuladen des Plists braucht bootout/bootstrap; kickstart allein startet
# nur den Prozess neu, was hier aber genau richtig ist - die Datei hat sich
# geaendert, das Plist nicht.
launchctl kickstart -k "system/$LABEL"
sleep 4

if launchctl print "system/$LABEL" >/dev/null 2>&1; then
  ok "Agent laeuft wieder"
else
  fehler "Agent kommt nicht hoch - spiele die Sicherung zurueck."
  cp "$SICHERUNG" "$LIBEXEC/agent.py"
  launchctl kickstart -k "system/$LABEL"
  exit 1
fi

# Die zwei Fehler, die genau daran hingen - als Beleg, dass der neue Stand da ist.
for FUNKTION in user_home parse_sleep_disabled; do
  grep -q "def $FUNKTION" "$LIBEXEC/agent.py" \
    && ok "$FUNKTION vorhanden" \
    || warn "$FUNKTION fehlt - stammt der Quellstand wirklich aus dem Repo?"
done

ls -1t "$LIBEXEC"/agent.py.bak-* 2>/dev/null | tail -n +4 | xargs -r rm -f
echo
echo "${GRUEN}==> Fertig. Zur Probe: '~' beim Schreiben muss jetzt auf /Users/<du> zeigen.${AUS}"
