-- Content hash so identical creatives with different storage paths collapse.
ALTER TABLE public.competitor_ads
  ADD COLUMN IF NOT EXISTS media_hash TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_competitor_ads_media_hash
  ON public.competitor_ads (project_id, media_hash)
  WHERE media_hash <> '';
