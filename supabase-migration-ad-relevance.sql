-- Jev comparability score for scraped competitor ads vs our product.
ALTER TABLE competitor_ads
  ADD COLUMN IF NOT EXISTS relevance_score smallint,
  ADD COLUMN IF NOT EXISTS relevance_label text,
  ADD COLUMN IF NOT EXISTS relevance_why text,
  ADD COLUMN IF NOT EXISTS relevance_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_competitor_ads_relevance
  ON competitor_ads (project_id, relevance_score DESC NULLS LAST);
