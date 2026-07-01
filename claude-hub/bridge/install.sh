#!/usr/bin/env bash
# install.sh — Einrichtung des Brücken-Agenten ("Claude Hub").
#
# Legt ~/.claude-hub/ an, fragt (oder nimmt via Umgebungsvariablen)
# die Konfiguration ab, schreibt ~/.claude-hub/config.json (chmod 600),
# macht die Skripte ausführbar und zeigt, wie man die Bridge dauerhaft
# laufen lässt sowie den .claude/settings.json-Schnipsel für die Hooks.
#
# Nutzung:
#   bash bridge/install.sh
# oder nicht-interaktiv über Umgebungsvariablen:
#   HUB_URL=... AGENT_TOKEN=... AGENT_NAME=... bash bridge/install.sh

set -euo pipefail

# --- Pfade bestimmen ---------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_JS="${SCRIPT_DIR}/claude-bridge.mjs"
NOTIFY_SH="${SCRIPT_DIR}/hooks/notify.sh"
STOP_SH="${SCRIPT_DIR}/hooks/stop.sh"

HUB_DIR="${HOME}/.claude-hub"
CONFIG_FILE="${HUB_DIR}/config.json"

echo "=============================================="
echo "  Claude Hub – Brücken-Agent Einrichtung"
echo "=============================================="
echo

mkdir -p "${HUB_DIR}"
chmod 700 "${HUB_DIR}" 2>/dev/null || true

# --- Hilfsfunktion: Wert erfragen (env hat Vorrang) --------------------------
# ask VARNAME "Frage" "Default"
ask() {
  local var="$1"; local prompt="$2"; local default="${3:-}"
  local current="${!var:-}"
  if [ -n "${current}" ]; then
    # bereits per Umgebungsvariable gesetzt
    printf '%s' "${current}"
    return 0
  fi
  local answer=""
  if [ -t 0 ]; then
    if [ -n "${default}" ]; then
      read -r -p "${prompt} [${default}]: " answer || true
    else
      read -r -p "${prompt}: " answer || true
    fi
  fi
  if [ -z "${answer}" ]; then answer="${default}"; fi
  printf '%s' "${answer}"
}

# --- Werte abfragen ----------------------------------------------------------
HUB_URL_VAL="$(ask HUB_URL 'Hub-URL (z.B. https://claude-hub.DEINSUB.workers.dev)' '')"
AGENT_TOKEN_VAL="$(ask AGENT_TOKEN 'Agent-Token (AGENT_TOKEN aus setup-secrets)' '')"
AGENT_NAME_VAL="$(ask AGENT_NAME 'Agent-Name (z.B. Mac-Claude)' 'Mac-Claude')"
AGENT_HOST_VAL="$(ask AGENT_HOST 'Agent-Host (z.B. mac)' 'mac')"
AGENT_MODEL_VAL="$(ask AGENT_MODEL 'Modell (z.B. Opus 4.6)' 'Opus 4.6')"
# Hinweis: Der Haupt-Agent (Mac, Opus 4.8) sollte 'main' in den Fähigkeiten
# haben (z.B. main,gmail,calendar). Der Hub routet Telegram-Nachrichten an den
# Agenten mit Fähigkeit 'main'.
CAPABILITIES_VAL="$(ask CAPABILITIES 'Fähigkeiten (Kommaliste; Haupt-Agent inkl. main, z.B. main,gmail,calendar)' '')"
TMUX_TARGET_VAL="$(ask TMUX_TARGET 'tmux-Ziel (optional, z.B. claude:0.0 – leer lassen für Datei-Modus)' '')"
MEMORY_TARGET_VAL="$(ask MEMORY_TARGET 'Gedächtnis-Zieldatei (optional, z.B. Pfad zu einem CLAUDE.md – leer = nur shared-memory.md)' '')"
CLAUDE_CWD_VAL="$(ask CLAUDE_CWD 'Arbeitsverzeichnis für headless Telegram-Antworten (optional)' '')"
# Nur der Haupt-Agent soll Telegram beantworten; andere Agenten auf 0 setzen.
TELEGRAM_HANDLER_VAL="$(ask TELEGRAM_HANDLER 'Telegram headless beantworten? (1 = ja, nur beim main-Agenten; 0 = nein)' '1')"

if [ -z "${HUB_URL_VAL}" ] || [ -z "${AGENT_TOKEN_VAL}" ]; then
  echo
  echo "FEHLER: HUB_URL und AGENT_TOKEN sind Pflicht." >&2
  exit 1
fi

# --- config.json schreiben (chmod 600) --------------------------------------
cat > "${CONFIG_FILE}" <<JSON
{
  "HUB_URL": "${HUB_URL_VAL}",
  "AGENT_TOKEN": "${AGENT_TOKEN_VAL}",
  "AGENT_NAME": "${AGENT_NAME_VAL}",
  "AGENT_HOST": "${AGENT_HOST_VAL}",
  "AGENT_MODEL": "${AGENT_MODEL_VAL}",
  "CAPABILITIES": "${CAPABILITIES_VAL}",
  "TMUX_TARGET": "${TMUX_TARGET_VAL}",
  "MEMORY_TARGET": "${MEMORY_TARGET_VAL}",
  "CLAUDE_CMD": "claude",
  "CLAUDE_CWD": "${CLAUDE_CWD_VAL}",
  "TELEGRAM_HANDLER": "${TELEGRAM_HANDLER_VAL}",
  "CONTROL_PORT": "4599",
  "POLL_MS": "1500",
  "HEARTBEAT_MS": "15000"
}
JSON
chmod 600 "${CONFIG_FILE}"
echo
echo "-> Konfiguration geschrieben: ${CONFIG_FILE} (chmod 600)"

# --- Skripte ausführbar machen ----------------------------------------------
chmod +x "${BRIDGE_JS}" "${NOTIFY_SH}" "${STOP_SH}" 2>/dev/null || true
echo "-> Skripte ausführbar gemacht (bridge + hooks)"

# --- Node-Check --------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR}" -lt 18 ]; then
    echo "WARNUNG: Node ${NODE_MAJOR} gefunden – benötigt wird Node >= 18." >&2
  fi
else
  echo "WARNUNG: 'node' nicht gefunden. Bitte Node.js >= 18 installieren." >&2
fi

# --- OS erkennen für Dienst-Beispiel ----------------------------------------
OS="$(uname -s 2>/dev/null || echo unknown)"

echo
echo "=============================================="
echo "  Bridge dauerhaft laufen lassen"
echo "=============================================="

if [ "${OS}" = "Darwin" ]; then
  PLIST_PATH="${HOME}/Library/LaunchAgents/de.claude-hub.bridge.plist"
  echo
  echo "macOS (launchd). Lege folgende Datei an: ${PLIST_PATH}"
  echo "-----------------------------------------------------------------"
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>de.claude-hub.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node || echo /usr/local/bin/node)</string>
    <string>${BRIDGE_JS}</string>
  </array>
  <key>RunAtLoad</key>  <true/>
  <key>KeepAlive</key>  <true/>
  <key>StandardOutPath</key>  <string>${HUB_DIR}/bridge.out.log</string>
  <key>StandardErrorPath</key> <string>${HUB_DIR}/bridge.err.log</string>
</dict>
</plist>
PLIST
  echo "-----------------------------------------------------------------"
  echo "Danach laden:"
  echo "  launchctl load -w ${PLIST_PATH}"
  echo "  launchctl start de.claude-hub.bridge"
else
  SERVICE_PATH="${HOME}/.config/systemd/user/claude-bridge.service"
  echo
  echo "Linux (systemd --user). Lege folgende Datei an: ${SERVICE_PATH}"
  echo "  (mkdir -p ~/.config/systemd/user)"
  echo "-----------------------------------------------------------------"
  cat <<UNIT
[Unit]
Description=Claude Hub Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$(command -v node || echo /usr/bin/node) ${BRIDGE_JS}
Restart=always
RestartSec=3
StandardOutput=append:${HUB_DIR}/bridge.out.log
StandardError=append:${HUB_DIR}/bridge.err.log

[Install]
WantedBy=default.target
UNIT
  echo "-----------------------------------------------------------------"
  echo "Danach aktivieren:"
  echo "  systemctl --user daemon-reload"
  echo "  systemctl --user enable --now claude-bridge.service"
  echo "  loginctl enable-linger \$USER   # startet den Dienst auch ohne Login (z.B. Hetzner)"
fi

# --- Hooks: .claude/settings.json-Schnipsel ---------------------------------
echo
echo "=============================================="
echo "  Claude-Code-Hooks aktivieren"
echo "=============================================="
echo "Füge diesen Block in deine .claude/settings.json ein"
echo "(Projekt-Ordner: <projekt>/.claude/settings.json oder global ~/.claude/settings.json):"
echo "-----------------------------------------------------------------"
cat <<HOOKS
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          { "type": "command", "command": "${NOTIFY_SH}" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "${STOP_SH}" }
        ]
      }
    ]
  }
}
HOOKS
echo "-----------------------------------------------------------------"

echo
echo "=============================================="
echo "  Fertig!"
echo "=============================================="
echo "Bridge manuell starten (zum Testen):"
echo "  node ${BRIDGE_JS}"
echo
echo "Wenn du tmux nutzt: erst Claude in tmux starten,"
echo "  tmux new -s claude   # dann darin:  claude"
echo "und TMUX_TARGET in ${CONFIG_FILE} auf 'claude:0.0' setzen."
echo
