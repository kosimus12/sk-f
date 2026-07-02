#!/bin/bash
# Claude (Pro Max) — startet Claude Code mit deinem Max-Abo statt Amazon Bedrock.
# Doppelklickbar auf dem Mac-Desktop (.command öffnet automatisch das Terminal).

# Bedrock / Vertex / API-Key / AWS aus der Umgebung entfernen
# -> Claude nutzt dann dein eingeloggtes Pro-/Max-Konto (Abo).
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX
unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_BASE_URL
unset ANTHROPIC_MODEL
unset AWS_BEARER_TOKEN_BEDROCK
unset AWS_PROFILE
unset AWS_REGION
unset AWS_DEFAULT_REGION

cd "$HOME"

if ! command -v claude >/dev/null 2>&1; then
  echo "❌ 'claude' (Claude Code) nicht gefunden. Bitte installieren und erneut versuchen."
  echo "Drücke eine Taste zum Schließen…"; read -r -n 1
  exit 1
fi

echo "🟢 Starte Claude mit deinem Pro-Max-Konto (Bedrock deaktiviert)…"
echo
exec claude
