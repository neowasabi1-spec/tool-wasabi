#!/bin/bash
# Deploy su Fly.io - legge .env.local per NEXT_PUBLIC_* (build) e secrets (runtime)

set -e
cd "$(dirname "$0")"

# Carica .env.local se esiste (per build args)
if [ -f .env.local ]; then
  set -a
  source .env.local
  set +a
fi

# Imposta i secrets (runtime) se presenti in .env.local
if [ -n "${GOOGLE_GEMINI_API_KEY:-}" ] && [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Impostazione secrets Fly.io..."
  fly secrets set \
    GOOGLE_GEMINI_API_KEY="$GOOGLE_GEMINI_API_KEY" \
    ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
fi

# Deploy con build args per NEXT_PUBLIC_* (richiesti al build time)
echo "Avvio deploy..."
fly deploy \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}"

echo ""
echo "Deploy completato: https://funnel-swiper-dashboard.fly.dev"
