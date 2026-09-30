#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REEL="$ROOT/reel"
MCP_JSON="$ROOT/.mcp.json"
SAMPLE_SCRIPT="$ROOT/.claude/skills/reel-setup/templates/script-esempio.json"

echo "==> Wasabi Reel — setup mediabuyer (tool-wasabi)"
echo "    Guida completa: reel/MEDIABUYER-SETUP.md"
echo ""

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "❌ Mancante: $1"
    exit 1
  fi
}

need node
need pnpm
need ffmpeg

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Serve Node 20+ (trovato $(node -v))"
  exit 1
fi

echo "==> 1/4 Dipendenze reel (pnpm install)"
cd "$REEL"
pnpm install

echo "==> 2/4 File .env"
if [ ! -f "$REEL/.env" ]; then
  cp "$REEL/.env.example" "$REEL/.env"
  echo "    Creato reel/.env — compila le chiavi sotto."
else
  echo "    reel/.env già presente."
fi

echo "==> 3/4 MCP wasabi-reel"
if [ -f "$MCP_JSON" ]; then
  echo "    OK: $MCP_JSON (envFile → reel/.env)"
  echo "    In Cursor: Settings → MCP → abilita wasabi-reel dal progetto tool-wasabi."
  echo "    In Claude Code: vedi reel/MEDIABUYER-SETUP.md (claude mcp add …)."
else
  echo "    ⚠️  Mancante $MCP_JSON — copia la config MCP dalla guida."
fi

echo "==> 4/4 Typecheck (opzionale ma consigliato)"
pnpm exec tsc --noEmit
if [ -f "$SAMPLE_SCRIPT" ]; then
  pnpm validate-script "$SAMPLE_SCRIPT" || true
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Chiavi da compilare in reel/.env:"
echo "  FAL_KEY                    → fal.ai (video Kling / Seedance)"
echo "  ELEVENLABS_API_KEY         → voiceover"
echo "  ELEVENLABS_VOICE_ID        → voce default"
echo "  GOOGLE_API_KEY             → storyboard Gemini"
echo "  NEXT_PUBLIC_SUPABASE_URL     → stesso tool-wasabi"
echo "  SUPABASE_SERVICE_ROLE_KEY  → import footage + publish"
echo "  REEL_OUTPUT_BASE           → (opz.) default ~/Movies/reel-ai"
echo ""
echo "Prossimi passi:"
echo "  1. Apri un progetto Wasabi → Competitor Library → tab Shots"
echo "  2. Pulisci/split footage → Prepare for Reel Engine → copia projectId"
echo "  3. In Claude/Cursor con MCP wasabi-reel:"
echo "     import → reel-director (4 gate) → reel_publish_to_wasabi"
echo "  4. Video finito in tab «Created videos» dello stesso progetto"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
