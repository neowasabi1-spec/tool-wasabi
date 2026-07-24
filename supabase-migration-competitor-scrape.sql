-- Competitor auto-scrape (Apify) support.
-- Adds a stable external id (the Meta Ad Library archive id) so daily runs
-- can de-duplicate and only insert *new* creatives, plus a source tag.

ALTER TABLE competitor_ads
  ADD COLUMN IF NOT EXISTS external_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source      TEXT NOT NULL DEFAULT 'manual';

-- Dedup guard: at most one row per (brand, external_id) when an id is present.
CREATE UNIQUE INDEX IF NOT EXISTS uq_competitor_ads_brand_external
  ON competitor_ads(brand_id, external_id)
  WHERE external_id <> '';

-- Track the last Apify run per brand (optional, for UI/debug).
ALTER TABLE competitor_brands
  ADD COLUMN IF NOT EXISTS last_run_id TEXT NOT NULL DEFAULT '';

-- Allow large video creatives (VSL-style) to be stored permanently.
-- Raise the project-files bucket per-file limit to 500MB and allow all types.
UPDATE storage.buckets
  SET file_size_limit = 524288000, allowed_mime_types = NULL
  WHERE id = 'project-files';
