-- =====================================================
-- Competitor creatives: ad spend disclosure.
-- Meta's Ad Library reports an exact spend range / impressions / reach only
-- for political & social-issue ads; for the commercial ads this tool targets
-- these stay empty and the UI shows an estimate from longevity × variants.
-- Stored as text because Meta returns ranges (e.g. "$1K–$5K"), not a scalar.
-- Safe to run multiple times (IF NOT EXISTS).
-- =====================================================

ALTER TABLE competitor_ads ADD COLUMN IF NOT EXISTS spend TEXT;
ALTER TABLE competitor_ads ADD COLUMN IF NOT EXISTS impressions TEXT;
ALTER TABLE competitor_ads ADD COLUMN IF NOT EXISTS reach INTEGER;
