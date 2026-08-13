-- Whole-video subtitle removal for competitor creatives.
--
-- Stores a cleaned copy of the FULL ad video (captions removed, original audio
-- kept) next to the original, so the Creative Detail can offer a one-click
-- "remove subtitles from the whole video" alongside the per-shot cleaning.
--
-- clean_status: null | 'pending' | 'processing' | 'done' | 'error'
-- clean_full_path: storage key of the cleaned video (null until done / if unusable)
-- clean_error: last error / note (e.g. "caption not removable")

alter table if exists public.competitor_ads
  add column if not exists clean_full_path text,
  add column if not exists clean_status    text,
  add column if not exists clean_error      text;
