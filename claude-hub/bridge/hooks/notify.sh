#!/usr/bin/env bash
# notify.sh — Claude-Code Notification-Hook.
#
# Claude Code ruft Notification-Hooks mit einem JSON auf stdin auf (Feld
# "message"). Dieser Hook liest die message und meldet dem lokalen
# Brücken-Agenten (Kontroll-Endpunkt), dass Claude auf Input wartet.
#
# WICHTIG: Fehlertolerant. Blockiert Claude niemals -> immer exit 0.

set +e

CONTROL_PORT="${CONTROL_PORT:-4599}"
URL="http://127.0.0.1:${CONTROL_PORT}/status"

# stdin einlesen (das JSON von Claude Code)
INPUT="$(cat 2>/dev/null)"

# message extrahieren: zuerst python3, dann grep/sed als Fallback (kein jq nötig)
MESSAGE=""
if command -v python3 >/dev/null 2>&1; then
  MESSAGE="$(printf '%s' "$INPUT" | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get("message", ""))
except Exception:
    print("")
' 2>/dev/null)"
fi

# Fallback ohne python3: simples grep/sed auf "message":"..."
if [ -z "$MESSAGE" ]; then
  MESSAGE="$(printf '%s' "$INPUT" \
    | grep -o '"message"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n1 \
    | sed 's/.*"message"[[:space:]]*:[[:space:]]*"//; s/"$//')"
fi

# Standardtext, falls nichts gefunden wurde
if [ -z "$MESSAGE" ]; then
  MESSAGE="Claude wartet auf eine Eingabe."
fi

# JSON sicher zusammenbauen (Anführungszeichen/Backslashes escapen)
escape_json() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\r\t' '   '
}
Q="$(escape_json "$MESSAGE")"

PAYLOAD="{\"status\":\"needs_input\",\"question\":\"${Q}\",\"title\":\"Wartet auf Input\"}"

# An den lokalen Kontroll-Endpunkt schicken (kurzer Timeout, still)
curl -s --max-time 5 -X POST "$URL" \
  -H 'content-type: application/json' \
  -d "$PAYLOAD" >/dev/null 2>&1

exit 0
