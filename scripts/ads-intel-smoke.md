# Ads Creative — FULL Jev port — local smoke

## 1. Migrations (DEV Supabase)
Run in order if needed:
1. `supabase-migration-ads-intel.sql` (Wasabi bridge tables)
2. `supabase-migration-jev-full-port.sql` (full Jev schema as `jev_*` + vector)

## 2. Env (`.env.local`)
```
ADS_INTEL_INLINE=1
OPENROUTER_API_KEY=...
JEV_MODEL=typesafe/jev-1.13
JEV_ENDPOINT=https://openrouter.ai/api/alpha/decisions
JUDGE_ENGINE=jev
WRITER_MODEL=anthropic/claude-sonnet-4
VISION_MODEL=google/gemini-2.5-flash
EMBEDDING_MODEL=baai/bge-m3
# assets
FAL_KEY=...   # or existing image stack
# optional Meta
META_ACCESS_TOKEN=...
META_AD_ACCOUNT_ID=act_...
META_APP_ID=...
META_APP_SECRET=...
```

## 3. Run
```
npm run dev
```

## 4. Path (DoD)
1. Brand rules → save  
2. Competitor Library has ads (or Sync My ads)  
3. Ads Creative → Library → select → Analyze  
   - ingest → jev_creatives → extract → analyze (judgments)  
4. Generate → Build corpus + playbook  
5. Generate concepts (DNA/mutations/gate)  
6. Generate asset (native image) → analyze_upload gate  
7. Review outputs (`JFC-` / paths under project-files)

## 5. Direct Jev job API
```
POST /api/projecthub/projects/:id/ads-creative/jev
{ "type": "build_corpus", "wait": true }
{ "type": "build_playbook", "wait": true }
{ "type": "analyze_product", "wait": true }
{ "type": "auto_prompts", "payload": { "opts": { ... } }, "wait": true }
```

## Note
Playwright Ad Library scrape is disabled — use Apify Competitor Library + ingest.

## 6. Outcomes
On Review step: Win / Neutral / Lose on each output, then **Recalibrate weights**.
Or:
```
POST .../ads-creative/jev { "type": "record_outcome", "payload": { "outputId": "...", "label": "win" }, "wait": true }
POST .../ads-creative/jev { "type": "recalibrate_weights", "wait": true }
```
