#!/usr/bin/env bash
# cleanup-old-agents.sh — Alte/kaputte Agenten-Tools sicher finden und entfernen.
#
# Gedacht fuer "Hermes" und "OpenClaude/Ralf", die auf Mac/Hetzner nicht mehr
# gebraucht werden. WICHTIG: Standardmaessig wird NUR ANALYSIERT (nichts geloescht).
# Erst mit  --remove  werden gefundene Dienste gestoppt/deaktiviert und Pakete
# entfernt — nach Rueckfrage und mit Backup der Konfigs.
#
# Nutzung:
#   bash cleanup-old-agents.sh                 # nur anzeigen, was gefunden wird
#   bash cleanup-old-agents.sh --remove        # gefundenes gezielt entfernen (mit Nachfrage)
#   PATTERNS="hermes ralf openclaude" bash cleanup-old-agents.sh
#
set -uo pipefail

PATTERNS="${PATTERNS:-hermes ralf openclaude open-claude}"
DO_REMOVE=0
[ "${1:-}" = "--remove" ] && DO_REMOVE=1

BACKUP_DIR="$HOME/.claude-hub/cleanup-backup-$(date +%Y%m%d-%H%M%S)"
FOUND=0

hr(){ printf '%s\n' "------------------------------------------------------------"; }
note(){ printf '  %s\n' "$*"; }

echo "🔎 Suche nach alten Agenten-Tools. Muster: $PATTERNS"
echo "   Modus: $([ $DO_REMOVE -eq 1 ] && echo 'ENTFERNEN (nach Nachfrage)' || echo 'nur Analyse')"
hr

# --- 1) Laufende Prozesse ---
echo "▶ Laufende Prozesse:"
for p in $PATTERNS; do
  ps aux 2>/dev/null | grep -i -- "$p" | grep -v grep | grep -v cleanup-old-agents && FOUND=1
done
[ $FOUND -eq 0 ] && note "(keine passenden Prozesse)"
hr

# --- 2) Dienste (systemd auf Linux, launchd auf macOS) ---
OS="$(uname -s)"
declare -a SERVICES=()
if [ "$OS" = "Linux" ]; then
  echo "▶ systemd-Dienste (system + user):"
  for p in $PATTERNS; do
    for scope in "" "--user"; do
      systemctl $scope list-unit-files 2>/dev/null | grep -i -- "$p" | while read -r line; do
        note "$scope ${line%% *}"
      done
      hits=$(systemctl $scope list-unit-files 2>/dev/null | grep -i -- "$p")
      [ -n "$hits" ] && SERVICES+=("$scope|$p")
    done
  done
  [ ${#SERVICES[@]} -eq 0 ] && note "(keine passenden systemd-Dienste)"
elif [ "$OS" = "Darwin" ]; then
  echo "▶ launchd-Dienste (LaunchAgents/LaunchDaemons):"
  for dir in "$HOME/Library/LaunchAgents" "/Library/LaunchAgents" "/Library/LaunchDaemons"; do
    for p in $PATTERNS; do
      ls "$dir" 2>/dev/null | grep -i -- "$p" | while read -r f; do note "$dir/$f"; done
    done
  done
  note "(Details oben; Entfernen weiter unten)"
fi
hr

# --- 3) Global installierte Pakete ---
echo "▶ Pakete (npm -g / pipx / pip / brew):"
command -v npm  >/dev/null 2>&1 && for p in $PATTERNS; do npm ls -g --depth=0 2>/dev/null | grep -i -- "$p" && FOUND=1; done
command -v pipx >/dev/null 2>&1 && for p in $PATTERNS; do pipx list 2>/dev/null | grep -i -- "$p" && FOUND=1; done
command -v pip3 >/dev/null 2>&1 && for p in $PATTERNS; do pip3 list 2>/dev/null | grep -i -- "$p" && FOUND=1; done
command -v brew >/dev/null 2>&1 && for p in $PATTERNS; do brew list 2>/dev/null | grep -i -- "$p" && FOUND=1; done
note "(oben gelistete Treffer sind Kandidaten)"
hr

# --- 4) Cron / Dateien in ueblichen Verzeichnissen ---
echo "▶ Cron-Eintraege:"
crontab -l 2>/dev/null | grep -i -E "$(echo "$PATTERNS" | tr ' ' '|')" || note "(keine)"
echo "▶ Verzeichnisse/Dateien:"
for base in "$HOME" "$HOME/.config" "/opt" "/usr/local/bin" "/etc"; do
  for p in $PATTERNS; do
    find "$base" -maxdepth 3 -iname "*$p*" 2>/dev/null | head -n 20
  done
done | sort -u | while read -r f; do note "$f"; done
hr

if [ $DO_REMOVE -eq 0 ]; then
  echo "✅ Analyse fertig. Es wurde NICHTS geaendert."
  echo "   Zum gezielten Entfernen erneut mit  --remove  starten."
  echo "   Prüfe die Liste oben, damit nichts Wichtiges entfernt wird!"
  exit 0
fi

# --- Entfernen (nur mit --remove) ---
echo "⚠️  Du hast --remove gewaehlt. Es werden Dienste gestoppt/deaktiviert und Pakete entfernt."
printf "   Fortfahren? Tippe 'JA' zum Bestaetigen: "
read -r CONFIRM
[ "$CONFIRM" = "JA" ] || { echo "Abgebrochen."; exit 1; }
mkdir -p "$BACKUP_DIR"; echo "Backups nach: $BACKUP_DIR"

# Prozesse beenden
for p in $PATTERNS; do
  pkill -i -f -- "$p" 2>/dev/null && echo "  Prozess(e) mit '$p' beendet"
done

if [ "$OS" = "Linux" ]; then
  for p in $PATTERNS; do
    for scope in "" "--user"; do
      systemctl $scope list-unit-files 2>/dev/null | grep -i -- "$p" | awk '{print $1}' | while read -r unit; do
        [ -z "$unit" ] && continue
        echo "  systemctl $scope stop/disable $unit"
        systemctl $scope stop "$unit" 2>/dev/null
        systemctl $scope disable "$unit" 2>/dev/null
        # Unit-Datei sichern statt loeschen
        f=$(systemctl $scope show "$unit" -p FragmentPath --value 2>/dev/null)
        [ -n "$f" ] && [ -f "$f" ] && cp "$f" "$BACKUP_DIR/" && rm -f "$f" && echo "    gesichert+entfernt: $f"
      done
    done
  done
  systemctl daemon-reload 2>/dev/null; systemctl --user daemon-reload 2>/dev/null
elif [ "$OS" = "Darwin" ]; then
  for dir in "$HOME/Library/LaunchAgents" "/Library/LaunchAgents" "/Library/LaunchDaemons"; do
    for p in $PATTERNS; do
      ls "$dir" 2>/dev/null | grep -i -- "$p" | while read -r f; do
        echo "  launchctl unload $dir/$f"
        launchctl unload "$dir/$f" 2>/dev/null
        cp "$dir/$f" "$BACKUP_DIR/" 2>/dev/null && rm -f "$dir/$f" && echo "    gesichert+entfernt: $dir/$f"
      done
    done
  done
fi

# Pakete deinstallieren
for p in $PATTERNS; do
  command -v npm  >/dev/null 2>&1 && npm ls -g --depth=0 2>/dev/null | grep -i -- "$p" | awk '{print $2}' | cut -d@ -f1 | while read -r pkg; do [ -n "$pkg" ] && echo "  npm -g uninstall $pkg" && npm -g uninstall "$pkg" 2>/dev/null; done
  command -v pipx >/dev/null 2>&1 && pipx list 2>/dev/null | grep -i -- "$p" | awk '{print $2}' | while read -r pkg; do [ -n "$pkg" ] && echo "  pipx uninstall $pkg" && pipx uninstall "$pkg" 2>/dev/null; done
  command -v brew >/dev/null 2>&1 && brew list 2>/dev/null | grep -i -- "$p" | while read -r pkg; do [ -n "$pkg" ] && echo "  brew uninstall $pkg" && brew uninstall "$pkg" 2>/dev/null; done
done

echo "✅ Entfernen abgeschlossen. Backups liegen in: $BACKUP_DIR"
echo "   Bitte kurz prüfen, ob alles Gewünschte weg ist (Skript ohne --remove erneut laufen lassen)."
