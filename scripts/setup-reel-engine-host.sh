#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REEL="$ROOT/reel"

echo "==> Wasabi Reel — Claude Cloud ENGINE HOST setup"
echo "    Guida: reel/ENGINE-HOST.md"
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

echo "==> 1/3 Dipendenze reel"
cd "$REEL"
pnpm install

echo "==> 2/3 .env"
if [ ! -f "$REEL/.env" ]; then
  cp "$REEL/.env.example" "$REEL/.env"
  echo "    Creato reel/.env"
else
  echo "    reel/.env già presente"
fi

if ! grep -q '^REEL_ENGINE_SECRET=.\+' "$REEL/.env" 2>/dev/null; then
  SECRET="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p)"
  if grep -q '^REEL_ENGINE_SECRET=' "$REEL/.env" 2>/dev/null; then
    # leave empty placeholder — user fills
    :
  else
    echo "" >>"$REEL/.env"
    echo "REEL_ENGINE_SECRET=$SECRET" >>"$REEL/.env"
    echo "REEL_ENGINE_PORT=8787" >>"$REEL/.env"
    echo "REEL_AUTO_CLAUDE=1" >>"$REEL/.env"
    echo "    Generato REEL_ENGINE_SECRET (salva lo stesso valore su Netlify)"
  fi
fi

echo "==> 3/3 Typecheck"
pnpm exec tsc --noEmit || true

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Poi:"
echo "  1. Compila FAL / ElevenLabs / Google / Supabase in reel/.env"
echo "  2. claude mcp add wasabi-reel (solo su QUESTO host)"
echo "  3. pnpm engine:http   +   pnpm engine:worker"
echo "  4. Su Netlify: REEL_ENGINE_URL + REEL_ENGINE_SECRET"
echo "  5. Mediabuyer: Shots → Create video on engine"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
