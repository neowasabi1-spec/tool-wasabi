-- Mark newly scraped creatives as "new" until the competitor is opened.
--
-- The daily Apify scrape keeps adding creatives, and there was no way to tell
-- which ones arrived since the last look. One timestamp per brand is enough:
-- any creative created after it is new.
--
-- Existing brands are stamped with NOW() so nothing already in the library
-- shows up as new — only what the next scrape brings in.

ALTER TABLE competitor_brands
  ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ DEFAULT NOW();

UPDATE competitor_brands SET last_viewed_at = NOW() WHERE last_viewed_at IS NULL;

-- Counting new creatives per brand hits (project_id, brand_id, created_at).
CREATE INDEX IF NOT EXISTS idx_competitor_ads_brand_created
  ON competitor_ads (project_id, brand_id, created_at DESC);
