-- =====================================================
-- Phase 1: Winner detection for competitor creatives.
-- Adds the raw Meta Ad Library signals we use to judge whether a
-- competitor video/ad is a "winner" (it has been running a long time
-- and is still active), plus a manual override flag.
-- Safe to run multiple times (IF NOT EXISTS).
-- =====================================================

ALTER TABLE competitor_ads ADD COLUMN IF NOT EXISTS ad_started_at TIMESTAMPTZ;
ALTER TABLE competitor_ads ADD COLUMN IF NOT EXISTS ad_active TEXT NOT NULL DEFAULT '';
ALTER TABLE competitor_ads ADD COLUMN IF NOT EXISTS ad_variants INTEGER NOT NULL DEFAULT 0;
ALTER TABLE competitor_ads ADD COLUMN IF NOT EXISTS is_winner BOOLEAN NOT NULL DEFAULT FALSE;

-- Phase 1: "same script, new video" — the Claude-rewritten script derived from
-- a winning creative's transcript, adapted to the user's own product.
ALTER TABLE competitor_ads ADD COLUMN IF NOT EXISTS rewritten_script TEXT;

-- Fast lookups for "winners first" ordering / filtering.
CREATE INDEX IF NOT EXISTS idx_competitor_ads_started_at ON competitor_ads(ad_started_at);
CREATE INDEX IF NOT EXISTS idx_competitor_ads_is_winner ON competitor_ads(is_winner);
