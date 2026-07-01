#!/usr/bin/env bash
# stop.sh — Claude-Code Stop-Hook.
#
# Wird aufgerufen, wenn Claude seine Antwort abgeschlossen hat. Meldet dem
# lokalen Brücken-Agenten status "done", damit das Dashboard sieht, dass der
# Agent fertig ist.
#
# WICHTIG: Fehlertolerant. Blockiert Claude niemals -> immer exit 0.

set +e

CONTROL_PORT="${CONTROL_PORT:-4599}"
URL="http://127.0.0.1:${CONTROL_PORT}/status"

# stdin verwerfen (Claude Code liefert auch hier JSON, wir brauchen es nicht)
cat >/dev/null 2>&1

PAYLOAD='{"status":"done","title":"Antwort abgeschlossen"}'

curl -s --max-time 5 -X POST "$URL" \
  -H 'content-type: application/json' \
  -d "$PAYLOAD" >/dev/null 2>&1

exit 0
