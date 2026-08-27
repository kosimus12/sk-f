#!/usr/bin/env bash
# End-to-End-Rauchtest: Hub + echter Agent-Prozess + Control-CLI, alles lokal.
# Beweist, dass die Kette Claude -> Hub -> Agent -> Geraet -> zurueck funktioniert.
#
#   cd connector && bash tests/smoke_e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PORT=8899
export CONNECTOR_DB="$WORK/hub.db"
export CONNECTOR_CONTROL_TOKEN="skc_ctl_smoke-$RANDOM"
export CONNECTOR_HUB_URL="http://127.0.0.1:$PORT"
export CONNECTOR_STATE="$WORK/agent.json"

cleanup() {
  # Erst die Prozesse beenden und auf sie warten, dann das Verzeichnis
  # loeschen - sonst laeuft der Hub noch gegen eine verschwundene Datenbank.
  [[ -n "${AGENT_PID:-}" ]] && kill "$AGENT_PID" 2>/dev/null || true
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null || true
  wait "${AGENT_PID:-}" "${HUB_PID:-}" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

cd "$ROOT"

echo "==> Hub starten"
python3 -m uvicorn hub.app:app --host 127.0.0.1 --port "$PORT" \
        --log-level warning > "$WORK/hub.log" 2>&1 &
HUB_PID=$!
for _ in $(seq 1 40); do
  curl -sf "$CONNECTOR_HUB_URL/healthz" >/dev/null && break
  sleep 0.25
done
curl -sf "$CONNECTOR_HUB_URL/healthz" >/dev/null || { echo "Hub startet nicht"; exit 1; }
echo "    Hub laeuft (PID $HUB_PID)"

echo "==> Geraet anlegen"
CODE="$(python3 tools/skconnect.py add smoke-host "Testrechner" linux \
          --mode full --caps shell,fs,notify,probe | grep -o 'skc_enr_[A-Za-z0-9_-]*' | head -1)"
echo "    Enrollment-Code erhalten"

echo "==> Agent registrieren und starten"
python3 agent/agent.py register --hub "$CONNECTOR_HUB_URL" --code "$CODE" >/dev/null
python3 agent/agent.py run > "$WORK/agent.log" 2>&1 &
AGENT_PID=$!
sleep 3

echo "==> Geraeteliste"
python3 tools/skconnect.py devices | sed 's/^/    /'

echo "==> Shell-Kommando durchschleusen"
OUT="$(python3 tools/skconnect.py run smoke-host 'echo hallo-vom-agenten && whoami')"
echo "    Ausgabe: $OUT"
grep -q "hallo-vom-agenten" <<<"$OUT" || { echo "FEHLER: Ausgabe fehlt"; cat "$WORK/agent.log"; exit 1; }

echo "==> Datei schreiben und wieder lesen"
python3 - <<PY
import json, os, urllib.request
hub, token = os.environ["CONNECTOR_HUB_URL"], os.environ["CONNECTOR_CONTROL_TOKEN"]
def call(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(hub + path, data=data, method=method)
    r.add_header("Authorization", "Bearer " + token)
    if data: r.add_header("Content-Type", "application/json")
    return json.loads(urllib.request.urlopen(r, timeout=30).read())

import time
c = call("POST", "/v1/devices/smoke-host/commands", {
    "kind": "fs.write",
    "payload": {"path": "$WORK/probe.txt", "content": "inhalt-123"}})
for _ in range(60):
    time.sleep(0.5)
    s = call("GET", "/v1/commands/" + c["id"])
    if s["status"] in ("done", "error", "timeout"): break
assert s["status"] == "done", s
c = call("POST", "/v1/devices/smoke-host/commands", {
    "kind": "fs.read", "payload": {"path": "$WORK/probe.txt"}})
for _ in range(60):
    time.sleep(0.5)
    s = call("GET", "/v1/commands/" + c["id"])
    if s["status"] in ("done", "error", "timeout"): break
assert s["result"]["content"] == "inhalt-123", s
print("    fs.write + fs.read OK")
PY

echo "==> Probe (Systemfakten)"
python3 tools/skconnect.py probe smoke-host | head -8 | sed 's/^/    /'

echo "==> Deny-Liste greift auch ueber die API"
# Ausgabe erst einsammeln: skconnect beendet sich mit Code != 0, und unter
# 'set -o pipefail' wuerde das eine Pipe nach grep faelschlich scheitern lassen.
DENIED="$(python3 tools/skconnect.py run smoke-host 'rm -rf /' 2>&1 || true)"
if grep -q "abgelehnt" <<<"$DENIED"; then
  echo "    'rm -rf /' wurde abgelehnt"
else
  echo "FEHLER: Deny-Liste hat nicht gegriffen: $DENIED"; exit 1
fi

echo "==> Widerruf klemmt den Agenten ab"
python3 tools/skconnect.py revoke smoke-host >/dev/null
sleep 3
REVOKED="$(python3 tools/skconnect.py run smoke-host 'echo sollte-nicht-gehen' 2>&1 || true)"
if grep -qE "403|widerrufen" <<<"$REVOKED"; then
  echo "    Kommandos nach Widerruf abgelehnt"
else
  echo "FEHLER: Widerruf wirkungslos: $REVOKED"; exit 1
fi

echo "==> Audit-Log"
python3 tools/skconnect.py audit --limit 8 | sed 's/^/    /'

echo
echo "==> Rauchtest bestanden."
