#!/usr/bin/env bash
# open-claude.sh — Öffnet Claude in einer tmux-Session, die die Hub-Brücke
# fernsteuern kann (Eingaben vom Dashboard/iPhone landen dann in dieser Sitzung).
#
# Nutzung:
#   bash open-claude.sh            # Session "claude" öffnen/wieder anhängen
#   bash open-claude.sh arbeit     # eigene Session "arbeit"
#
# Loslösen (Session läuft weiter): Strg+b, dann d
# Wieder rein:                     bash open-claude.sh   (oder: tmux attach -t claude)

set -e
SESSION="${1:-claude}"

if ! command -v claude >/dev/null 2>&1; then
  echo "❌ 'claude' (Claude Code) nicht gefunden. Bitte zuerst installieren."
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "⚠️  tmux fehlt – starte Claude ohne Fernsteuerung."
  echo "    Für Fernsteuerung installieren:  (Mac) brew install tmux   (Ubuntu) apt install -y tmux"
  exec claude
fi

# TMUX_TARGET für die Brücke merken (config.json), damit Dashboard-Eingaben ankommen.
TARGET="${SESSION}:0.0"
echo "ℹ️  Diese Session ist fernsteuerbar. Setze in ~/.claude-hub/config.json:  \"TMUX_TARGET\": \"${TARGET}\""
echo "    (danach Brücke neu starten). Loslösen: Strg+b, dann d"
echo

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "↩️  Hänge an bestehende Session '$SESSION' an…"
  exec tmux attach -t "$SESSION"
else
  echo "▶️  Starte neue Session '$SESSION' mit Claude…"
  exec tmux new -s "$SESSION" claude
fi
