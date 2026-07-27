-- AI subtitle removal (video inpainting via Replicate).
-- clean_path: storage path of the cleaned clip (subtitles erased). When set,
--             the shot becomes usable in video builds even if has_text=true.
-- inpaint_status: pending | processing | done | error
ALTER TABLE competitor_shots ADD COLUMN IF NOT EXISTS clean_path      TEXT;
ALTER TABLE competitor_shots ADD COLUMN IF NOT EXISTS inpaint_status  TEXT;
ALTER TABLE competitor_shots ADD COLUMN IF NOT EXISTS inpaint_error   TEXT;
