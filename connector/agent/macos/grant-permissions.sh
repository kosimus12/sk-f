#!/usr/bin/env bash
# macOS-Freigaben fuer den Connector-Agenten erteilen.
#
# WICHTIG: Dieses Skript OHNE sudo und in der grafischen Sitzung des Benutzers
# ausfuehren (Terminal.app auf dem Mac, nicht per SSH). Nur dann zeigt macOS
# die Zustimmungsdialoge an.
#
#   bash grant-permissions.sh
#
# Es macht nichts Heimliches: Es loest genau die Aktionen aus, fuer die macOS
# eine Zustimmung verlangt, damit die Dialoge erscheinen und du sie bewusst
# bestaetigen kannst. Danach meldet es, was funktioniert und was nicht.
#
#   bash grant-permissions.sh --apps "Notizen,Kalender,Musik,Finder"
#
# WICHTIG fuer den gesperrten Zustand: macOS fragt bei JEDEM Programm einmal
# nach Zustimmung. Sitzt spaeter niemand am Mac, kann diesen Dialog niemand
# wegklicken - das Kommando schlaegt dann fehl. Deshalb hier vorab alle
# Programme durchgehen, die Claude spaeter steuern koennen soll.
set -uo pipefail

# Programme, die standardmaessig vorab freigegeben werden.
STANDARD_APPS="Mail,Safari,Google Chrome,System Events,Finder,Notes,Calendar,Contacts,Reminders,Messages,Music,Terminal"
EXTRA_APPS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apps) EXTRA_APPS="$2"; shift 2 ;;
    --only) STANDARD_APPS="$2"; EXTRA_APPS=""; shift 2 ;;
    -h|--help)
      echo "Aufruf: bash grant-permissions.sh [--apps \"App1,App2\"] [--only \"App1,App2\"]"
      exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
  esac
done

if [[ $EUID -eq 0 ]]; then
  echo "Bitte OHNE sudo starten - sonst erscheinen die Dialoge nicht." >&2
  exit 1
fi

BLAU=$'\033[1;34m'; GRUEN=$'\033[0;32m'; ROT=$'\033[0;31m'; GELB=$'\033[0;33m'; AUS=$'\033[0m'
FEHLT=0

schritt() { echo; echo "${BLAU}==> $*${AUS}"; }
ok()      { echo "    ${GRUEN}OK${AUS}    $*"; }
fehlt()   { echo "    ${ROT}FEHLT${AUS} $*"; FEHLT=1; }
hinweis() { echo "    ${GELB}!${AUS}     $*"; }

pruefe_app() {
  local label="$1" script="$2"
  if osascript -e "$script" >/dev/null 2>/tmp/skc-perm.err; then
    ok "$label"
  else
    local err; err="$(tr -d '\n' < /tmp/skc-perm.err | cut -c1-140)"
    if grep -q -- "-1728\|Application isn't running" /tmp/skc-perm.err; then
      hinweis "$label - Programm laeuft nicht. Einmal oeffnen und erneut ausfuehren."
    else
      fehlt "$label - $err"
    fi
  fi
}

cat <<'TEXT'
Dieses Skript fragt gleich mehrere Zustimmungen ab. Bei jedem Dialog:

  "„Terminal“ möchte „Mail“ steuern."      -> Erlauben
  "„Terminal“ möchte „Safari“ steuern."    -> Erlauben
  "„osascript“ möchte ... steuern."        -> Erlauben

Wenn kein Dialog kommt und stattdessen ein Fehler steht, ist die Freigabe
vorher schon einmal abgelehnt worden. Dann von Hand nachtragen unter
Systemeinstellungen > Datenschutz & Sicherheit > Automation.
TEXT

schritt "Programme freigeben"
echo "    Jedes Programm einmal antippen, damit macOS jetzt fragt statt spaeter."
echo
ALLE="$STANDARD_APPS"
[[ -n "$EXTRA_APPS" ]] && ALLE="$ALLE,$EXTRA_APPS"

IFS=',' read -r -a APP_LISTE <<< "$ALLE"
for app in "${APP_LISTE[@]}"; do
  app="$(echo "$app" | sed 's/^ *//; s/ *$//')"
  [[ -z "$app" ]] && continue
  case "$app" in
    Mail)           frage='tell application "Mail" to return (count of accounts) as text' ;;
    "System Events") frage='tell application "System Events" to return (count of processes) as text' ;;
    Safari|"Google Chrome"|"Brave Browser"|"Microsoft Edge"|Arc)
                    frage="tell application \"$app\" to return (count of windows) as text" ;;
    *)              frage="tell application \"$app\" to return name as text" ;;
  esac
  pruefe_app "$app" "$frage"
done

schritt "JavaScript aus Apple Events"
cat <<'TEXT'
    Ohne diese Einstellung kann Claude Seiteninhalte nicht lesen.

    Safari: Einstellungen > Erweitert > "Funktionen für Webentwickler anzeigen",
            dann im Menü "Entwickler" > "JavaScript aus Apple Events erlauben".
    Chrome: Menü "Darstellung"/"View" > "Entwickler" >
            "JavaScript über Apple Events zulassen".
TEXT
if [[ -d "/Applications/Safari.app" ]]; then
  if osascript -e 'tell application "Safari" to do JavaScript "1+1" in front document' \
       >/dev/null 2>&1; then
    ok "Safari fuehrt JavaScript aus"
  else
    hinweis "Safari: noch nicht aktiv (oder kein Fenster offen)"
  fi
fi

schritt "Festplattenvollzugriff"
if [[ -r "$HOME/Library/Mail" ]] && ls "$HOME/Library/Mail" >/dev/null 2>&1; then
  ok "Zugriff auf ~/Library/Mail"
else
  fehlt "~/Library/Mail nicht lesbar"
fi
cat <<'TEXT'
    Fuer den als Dienst laufenden Agenten zusaetzlich eintragen unter
    Systemeinstellungen > Datenschutz & Sicherheit > Festplattenvollzugriff:

        /bin/bash            (über "+" und dann Cmd+Shift+G eingeben)
        /usr/bin/python3

    Ohne das bleiben Dokumente, Schreibtisch und Downloads fuer den Dienst leer.
TEXT

schritt "Mitteilungen"
osascript -e 'display notification "Der Connector kann Mitteilungen zustellen." with title "SK Connector"' \
  >/dev/null 2>&1 && ok "Mitteilung zugestellt" || hinweis "Mitteilung nicht zugestellt"

echo
if [[ $FEHLT -eq 0 ]]; then
  echo "${GRUEN}==> Alles erteilt.${AUS} Gegenprobe vom Hub aus:"
else
  echo "${ROT}==> Es fehlt noch etwas${AUS} (siehe oben). Nach dem Nachtragen erneut ausfuehren."
fi
echo "    skconnect.py permissions <geraete-id>"
rm -f /tmp/skc-perm.err
