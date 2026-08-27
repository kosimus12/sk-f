#!/usr/bin/env bash
# Ein-Befehl-Einrichtung fuer einen Mac, der auch ZUGEKLAPPT und GESPERRT
# erreichbar bleiben soll.
#
#   bash setup-mac.sh --hub https://hub.example.de --code skc_enr_xxx
#
# Optionen:
#   --allow-mail-send   Claude darf Mails auch verschicken (Standard: nur Entwuerfe)
#   --apps "A,B,C"      zusaetzliche Programme vorab freigeben
#   --akku-auch         auch im Akkubetrieb wach bleiben (zieht Strom)
#
# Das Skript ruft sudo selbst auf, wo es noetig ist - starte es NICHT mit sudo,
# sonst laufen die Freigabe-Dialoge im falschen Benutzerkontext.
set -uo pipefail

HUB=""; CODE=""; MAIL_SEND=""; EXTRA_APPS=""; AKKU_AUCH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB="$2"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --allow-mail-send) MAIL_SEND="--allow-mail-send"; shift ;;
    --apps) EXTRA_APPS="$2"; shift 2 ;;
    --akku-auch) AKKU_AUCH=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
  esac
done

BLAU=$'\033[1;34m'; GRUEN=$'\033[0;32m'; ROT=$'\033[0;31m'; GELB=$'\033[0;33m'; AUS=$'\033[0m'
schritt() { echo; echo "${BLAU}==> $*${AUS}"; }
ok()      { echo "    ${GRUEN}OK${AUS}    $*"; }
warn()    { echo "    ${GELB}!${AUS}     $*"; }
fehler()  { echo "    ${ROT}FEHLER${AUS} $*"; }

if [[ $EUID -eq 0 ]]; then
  fehler "Bitte OHNE sudo starten. Das Skript fragt selbst nach, wo es root braucht."
  exit 1
fi
if [[ -z "$HUB" || -z "$CODE" ]]; then
  fehler "Aufruf: bash setup-mac.sh --hub https://... --code skc_enr_..."
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
schritt "1/5  Voraussetzungen"

if ! /usr/bin/python3 --version >/dev/null 2>&1; then
  fehler "/usr/bin/python3 fehlt. Einmalig ausfuehren: xcode-select --install"
  exit 1
fi
ok "python3 $(/usr/bin/python3 --version 2>&1 | cut -d' ' -f2)"

if ! curl -sfI --max-time 15 "$HUB/healthz" >/dev/null 2>&1; then
  if ! curl -sf --max-time 15 "$HUB/healthz" >/dev/null 2>&1; then
    fehler "Hub unter $HUB nicht erreichbar."
    echo "          Laeuft der Dienst? Zeigt der DNS-Eintrag auf den Server?"
    echo "          Test:  curl -v $HUB/healthz"
    exit 1
  fi
fi
ok "Hub erreichbar: $HUB"

MODELL="$(sysctl -n hw.model 2>/dev/null || echo unbekannt)"
IST_LAPTOP=0
[[ "$MODELL" == MacBook* ]] && IST_LAPTOP=1
ok "Modell: $MODELL"

# ---------------------------------------------------------------------------
schritt "2/5  Agent installieren"

KEEP_FLAG="--keep-awake-aggressive"     # wirkt auch bei geschlossenem Deckel
sudo bash "$SRC_DIR/macos/install.sh" \
     --hub "$HUB" --code "$CODE" $KEEP_FLAG $MAIL_SEND || {
  fehler "Installation fehlgeschlagen."; exit 1; }

# ---------------------------------------------------------------------------
schritt "3/5  Energieeinstellungen fuer den zugeklappten Betrieb"

# 'sleep 0' allein reicht NICHT: Zuklappen schlaeft trotzdem ein.
# Nur 'disablesleep 1' verhindert auch den Deckel-Schlaf.
sudo pmset -a disablesleep 1
sudo pmset -c sleep 0 disksleep 0 displaysleep 5
sudo pmset -a womp 1 2>/dev/null || true
sudo pmset -a powernap 1 2>/dev/null || true
if [[ $AKKU_AUCH -eq 0 ]]; then
  sudo pmset -b sleep 20 2>/dev/null || true   # ohne Netzteil normal schlafen
fi

DISABLESLEEP="$(pmset -g live 2>/dev/null | awk '/disablesleep/ {print $2; exit}')"
if [[ "$DISABLESLEEP" == "1" ]]; then
  ok "disablesleep=1 — der Mac bleibt auch zugeklappt wach"
else
  fehler "disablesleep konnte nicht gesetzt werden (Wert: ${DISABLESLEEP:-leer})"
  warn  "Ohne diese Einstellung schlaeft der Mac beim Zuklappen ein."
  warn  "Von Hand versuchen:  sudo pmset -a disablesleep 1"
fi
pmset -g custom | sed -n '/AC Power/,/Battery/p' | sed 's/^/    /'

if [[ $IST_LAPTOP -eq 1 ]]; then
  warn "Zugeklappt heisst: Netzteil angeschlossen lassen. Im Akkubetrieb"
  warn "ist der Mac sonst irgendwann leer und damit offline."
fi

# ---------------------------------------------------------------------------
schritt "4/5  macOS-Freigaben"
echo "    Gleich erscheinen Zustimmungsdialoge. Jeden mit ERLAUBEN bestaetigen."
echo "    Das muss jetzt passieren - bei zugeklapptem Mac kann sie spaeter"
echo "    niemand mehr wegklicken."
echo
if [[ -n "$EXTRA_APPS" ]]; then
  bash "$SRC_DIR/macos/grant-permissions.sh" --apps "$EXTRA_APPS"
else
  bash "$SRC_DIR/macos/grant-permissions.sh"
fi

# ---------------------------------------------------------------------------
schritt "5/5  Was jetzt noch von Hand fehlt"

cat <<'TEXT'
    a) JavaScript aus Apple Events - sonst kommt Seitentext leer zurueck
       Safari:  Einstellungen > Erweitert > "Funktionen fuer Webentwickler
                anzeigen", dann Menue Entwickler > "JavaScript aus Apple
                Events erlauben"
       Chrome:  Menue Darstellung > Entwickler > "JavaScript ueber Apple
                Events zulassen"

    b) Festplattenvollzugriff - sonst bleiben Dokumente, Schreibtisch,
       Downloads und die Mail-Ablage fuer den Dienst leer
       Systemeinstellungen > Datenschutz & Sicherheit > Festplattenvollzugriff
       "+", dann Cmd+Shift+G, und diese beiden Pfade eintragen:
           /bin/bash
           /usr/bin/python3

    c) FileVault-Hinweis: Nach einem Neustart oder Stromausfall haengt der
       Mac am Pre-Boot-Anmeldebildschirm, bis jemand einmal das Passwort
       eingibt. Bis dahin ist er nicht erreichbar - unabhaengig von allem,
       was dieses Skript eingestellt hat.
TEXT

echo
echo "${BLAU}==> Gegenprobe vom Hub aus:${AUS}"
echo "    python3 tools/skconnect.py devices"
echo "    python3 tools/skconnect.py permissions <geraete-id>"
echo "    python3 tools/skconnect.py probe <geraete-id>      # zeigt die Schlaf-Werte"
echo
echo "${GRUEN}==> Danach Deckel zuklappen und den Abnahme-Test laufen lassen.${AUS}"
