#!/usr/bin/env bash
# Startet den MCP-Server fuer Claude Code (stdio).
#
# Warum ein Wrapper: Im Web-Container von Claude Code ist das System-Python
# ohne das MCP-SDK, und der Container ist bei jeder Sitzung neu. Der Wrapper
# legt beim ersten Start ein venv an und benutzt es danach wieder.
#
# Alles Geschwaetz geht nach stderr - auf stdout darf nur JSON-RPC stehen,
# sonst haelt Claude den Server fuer kaputt.
set -euo pipefail

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${CONNECTOR_VENV:-${HOME:-/tmp}/.cache/skconnector-venv}"

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "Lege venv an: $VENV" >&2
  python3 -m venv "$VENV" >&2
fi

if ! "$VENV/bin/python" -c "import mcp" >/dev/null 2>&1; then
  echo "Installiere das MCP-SDK..." >&2
  "$VENV/bin/pip" install -q -r "$HIER/requirements.txt" >&2
fi

exec "$VENV/bin/python" "$HIER/server.py"
