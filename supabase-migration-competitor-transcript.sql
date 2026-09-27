-- Spoken transcript, separate from Meta primary text (body_text), title (headline)
-- and description (hook).

ALTER TABLE public.competitor_ads
  ADD COLUMN IF NOT EXISTS transcript text;

ALTER TABLE public.competitor_ads
  ADD COLUMN IF NOT EXISTS transcript_status text;

ALTER TABLE public.competitor_ads
  ADD COLUMN IF NOT EXISTS transcript_error text;

NOTIFY pgrst, 'reload schema';
