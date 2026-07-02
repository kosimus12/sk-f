#!/bin/bash
# Claude (Pro Max) — nutzt einen EIGENEN Konfig-Ordner ohne die Bedrock-
# Einstellung aus ~/.claude/settings.json, damit dein Max-Abo verwendet wird.
# Doppelklickbar auf dem Mac-Desktop (.command öffnet automatisch das Terminal).

# Eigener Konfig-Ordner -> die Bedrock-settings.json des Standard-Claude greift hier NICHT.
export CLAUDE_CONFIG_DIR="$HOME/.claude-max"
mkdir -p "$CLAUDE_CONFIG_DIR"

# Sicherheitshalber Bedrock/API/AWS aus der Umgebung nehmen.
unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX ANTHROPIC_API_KEY \
      ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL \
      AWS_BEARER_TOKEN_BEDROCK AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION

cd "$HOME"

if ! command -v claude >/dev/null 2>&1; then
  echo "❌ 'claude' (Claude Code) nicht gefunden."; echo "Taste drücken zum Schließen…"; read -r -n 1; exit 1
fi

echo "🟢 Claude (Pro Max) — eigenes Profil, kein Bedrock."
echo "   Beim ERSTEN Start bitte mit deinem Max-Konto anmelden (Auswahl: Claude-Konto/Abo)."
echo
exec claude
