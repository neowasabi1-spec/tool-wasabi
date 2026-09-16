-- Meta Ad Library copy on each creative: destination URL the ad clicks through to.
-- Primary text = body_text, title = headline, description = hook (already on the table).

ALTER TABLE competitor_ads
  ADD COLUMN IF NOT EXISTS landing_url TEXT NOT NULL DEFAULT '';
