-- Scene understanding for competitor shots.
-- Tags alone do not tell the builder who is on screen or what they are doing.
-- Safe to run multiple times (IF NOT EXISTS).

ALTER TABLE competitor_shots ADD COLUMN IF NOT EXISTS action TEXT;
ALTER TABLE competitor_shots ADD COLUMN IF NOT EXISTS people_count INTEGER;
ALTER TABLE competitor_shots ADD COLUMN IF NOT EXISTS people TEXT;
ALTER TABLE competitor_shots ADD COLUMN IF NOT EXISTS context TEXT;
ALTER TABLE competitor_shots ADD COLUMN IF NOT EXISTS scene JSONB;
