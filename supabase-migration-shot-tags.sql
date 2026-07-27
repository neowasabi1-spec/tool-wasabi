-- =====================================================
-- Contextual shots: name + caption + content tags so recreated videos can
-- pick footage that MATCHES the scene text (e.g. a scene mentioning "trump"
-- pulls a shot tagged 'trump'). Tags may repeat across shots; the builder
-- uses at most one per matched tag per scene.
-- Safe to run multiple times (IF NOT EXISTS).
-- =====================================================

ALTER TABLE competitor_shots ADD COLUMN IF NOT EXISTS label   TEXT;
ALTER TABLE competitor_shots ADD COLUMN IF NOT EXISTS caption TEXT;
ALTER TABLE competitor_shots ADD COLUMN IF NOT EXISTS tags    TEXT[] DEFAULT '{}';
-- Narrative section derived from the shot's position in the source video:
-- 'hook' (opening), 'body' (middle), 'cta' (closing). Used to group the Shots tab.
ALTER TABLE competitor_shots ADD COLUMN IF NOT EXISTS section TEXT;

-- GIN index for fast tag lookups / filtering.
CREATE INDEX IF NOT EXISTS idx_competitor_shots_tags ON competitor_shots USING GIN (tags);
