-- =====================================================================
-- PROJECTHUB INTEGRATION — schema migration (run on Supabase SQL editor)
-- =====================================================================
-- This migration adds all tables required by the projecthub UI port.
-- It REUSES the existing `projects` table (UUID `id`) and only ADDS
-- the columns projecthub needs. All child tables use BIGSERIAL ids and
-- reference projects(id) via UUID.
--
-- Safe to run multiple times — uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- =====================================================================

-- 1) Extend existing projects table with projecthub fields ------------
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS thumbnail_path           TEXT NULL,
  ADD COLUMN IF NOT EXISTS product_brief_sections   TEXT NOT NULL DEFAULT '[]';

-- 2) Project files (uploads metadata) ----------------------------------
CREATE TABLE IF NOT EXISTS project_files (
  id              BIGSERIAL PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_type       TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  original_name   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_files_project_id ON project_files(project_id);

-- 3) Flows ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flows (
  id              BIGSERIAL PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  notes           TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_flows_project_id ON flows(project_id);

-- 4) Funnels ----------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE funnel_type AS ENUM ('Lead Gen','Sales','Webinar','VSL','Other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS funnels (
  id              BIGSERIAL PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  type            funnel_type NOT NULL,
  stages_json     TEXT NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_funnels_project_id ON funnels(project_id);

-- 5) Ads --------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE ad_platform AS ENUM ('Meta','TikTok','Google','YouTube');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ad_format AS ENUM ('Video','Image','Carousel');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ads (
  id              BIGSERIAL PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  platform        ad_platform NOT NULL,
  format          ad_format NOT NULL,
  headline        TEXT NOT NULL,
  primary_text    TEXT NOT NULL,
  cta             TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ads_project_id ON ads(project_id);

-- 6) Funnel Steps -----------------------------------------------------
CREATE TABLE IF NOT EXISTS funnel_steps (
  id                  BIGSERIAL PRIMARY KEY,
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_number         INTEGER NOT NULL,
  page_name           TEXT NOT NULL DEFAULT '',
  step_type           TEXT NOT NULL DEFAULT 'Landing Page',
  template_name       TEXT NOT NULL DEFAULT '',
  url                 TEXT NOT NULL DEFAULT '',
  html_file_path      TEXT NULL,
  html_original_name  TEXT NULL,
  target              TEXT NOT NULL DEFAULT '',
  angle               TEXT NOT NULL DEFAULT '',
  prompt_notes        TEXT NOT NULL DEFAULT '',
  auto_gen            TEXT NOT NULL DEFAULT 'false',
  fidelity_mode       TEXT NOT NULL DEFAULT 'false',
  product             TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'pending',
  result_content      TEXT NULL,
  feedback            TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_funnel_steps_project_id ON funnel_steps(project_id);

-- 7) Step chat history ------------------------------------------------
CREATE TABLE IF NOT EXISTS step_chat_history (
  id              BIGSERIAL PRIMARY KEY,
  step_id         BIGINT NOT NULL REFERENCES funnel_steps(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  message         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_step_chat_history_step_id ON step_chat_history(step_id);

-- 8) Creative templates -----------------------------------------------
CREATE TABLE IF NOT EXISTS creative_templates (
  id              BIGSERIAL PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  source_brand    TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL DEFAULT '',
  file_path       TEXT NOT NULL,
  media_type      TEXT NOT NULL DEFAULT 'image',
  tags            TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_creative_templates_project_id ON creative_templates(project_id);

-- 9) Competitor brands -------------------------------------------------
CREATE TABLE IF NOT EXISTS competitor_brands (
  id                       BIGSERIAL PRIMARY KEY,
  project_id               UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  ads_library_url          TEXT NOT NULL DEFAULT '',
  scrape_count             INTEGER NOT NULL DEFAULT 10,
  frequency                TEXT NOT NULL DEFAULT 'every_7_days',
  brand_type               TEXT NOT NULL DEFAULT 'competitor',
  notes                    TEXT NOT NULL DEFAULT '',
  creative_quality_notes   TEXT NOT NULL DEFAULT '',
  is_active                TEXT NOT NULL DEFAULT 'true',
  last_scraped             TIMESTAMPTZ NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_competitor_brands_project_id ON competitor_brands(project_id);

-- 10) Automation jobs --------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_jobs (
  id                BIGSERIAL PRIMARY KEY,
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  brand_id          BIGINT NULL REFERENCES competitor_brands(id) ON DELETE SET NULL,
  mode              TEXT NOT NULL DEFAULT 'swipe',
  frequency         TEXT NOT NULL DEFAULT 'daily',
  media_type        TEXT NOT NULL DEFAULT 'both',
  ads_count         INTEGER NOT NULL DEFAULT 5,
  iterations_per_ad INTEGER NOT NULL DEFAULT 3,
  status            TEXT NOT NULL DEFAULT 'active',
  last_run          TIMESTAMPTZ NULL,
  next_run          TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_project_id ON automation_jobs(project_id);

-- 11) Creative outputs ------------------------------------------------
CREATE TABLE IF NOT EXISTS creative_outputs (
  id              BIGSERIAL PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id          BIGINT NULL REFERENCES automation_jobs(id) ON DELETE SET NULL,
  type            TEXT NOT NULL DEFAULT 'concept',
  angle           TEXT NOT NULL DEFAULT '',
  concept_notes   TEXT NOT NULL DEFAULT '',
  output_status   TEXT NOT NULL DEFAULT 'pending',
  feedback        TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_creative_outputs_project_id ON creative_outputs(project_id);

-- 12) Competitor ads --------------------------------------------------
CREATE TABLE IF NOT EXISTS competitor_ads (
  id              BIGSERIAL PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  brand_id        BIGINT NOT NULL REFERENCES competitor_brands(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  media_type      TEXT NOT NULL DEFAULT 'image',
  name            TEXT NOT NULL DEFAULT '',
  headline        TEXT NOT NULL DEFAULT '',
  hook            TEXT NOT NULL DEFAULT '',
  body_text       TEXT NOT NULL DEFAULT '',
  is_active       TEXT NOT NULL DEFAULT 'true',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_competitor_ads_project_id ON competitor_ads(project_id);
CREATE INDEX IF NOT EXISTS idx_competitor_ads_brand_id   ON competitor_ads(brand_id);

-- 13) Creative iterations ---------------------------------------------
CREATE TABLE IF NOT EXISTS creative_iterations (
  id                       BIGSERIAL PRIMARY KEY,
  project_id               UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  competitor_ad_id         BIGINT NULL,
  brand_name               TEXT NOT NULL DEFAULT '',
  competitor_headline      TEXT NOT NULL DEFAULT '',
  competitor_hook          TEXT NOT NULL DEFAULT '',
  competitor_body          TEXT NOT NULL DEFAULT '',
  competitor_gradient      TEXT NOT NULL DEFAULT '0',
  iteration_headline       TEXT NOT NULL DEFAULT '',
  iteration_hook           TEXT NOT NULL DEFAULT '',
  iteration_body           TEXT NOT NULL DEFAULT '',
  angle_notes              TEXT NOT NULL DEFAULT '',
  elements_json            TEXT NOT NULL DEFAULT '[]',
  analysis                 TEXT NOT NULL DEFAULT '',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_creative_iterations_project_id ON creative_iterations(project_id);

-- 14) Creative swipes -------------------------------------------------
CREATE TABLE IF NOT EXISTS creative_swipes (
  id                       BIGSERIAL PRIMARY KEY,
  project_id               UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  competitor_ad_id         BIGINT NULL,
  brand_id                 BIGINT NULL,
  brand_name               TEXT NOT NULL DEFAULT '',
  competitor_headline      TEXT NOT NULL DEFAULT '',
  competitor_hook          TEXT NOT NULL DEFAULT '',
  competitor_body          TEXT NOT NULL DEFAULT '',
  competitor_gradient      TEXT NOT NULL DEFAULT '0',
  swipe_headline           TEXT NOT NULL DEFAULT '',
  swipe_hook               TEXT NOT NULL DEFAULT '',
  swipe_body               TEXT NOT NULL DEFAULT '',
  swipe_notes              TEXT NOT NULL DEFAULT '',
  elements_json            TEXT NOT NULL DEFAULT '[]',
  analysis                 TEXT NOT NULL DEFAULT '',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_creative_swipes_project_id ON creative_swipes(project_id);

-- 15) Creative angles -------------------------------------------------
CREATE TABLE IF NOT EXISTS creative_angles (
  id                       BIGSERIAL PRIMARY KEY,
  project_id               UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  angle_name               TEXT NOT NULL DEFAULT '',
  rationale                TEXT NOT NULL DEFAULT '',
  competitor_insights      TEXT NOT NULL DEFAULT '',
  our_ads_insights         TEXT NOT NULL DEFAULT '',
  market_insights          TEXT NOT NULL DEFAULT '',
  ad_style                 TEXT NOT NULL DEFAULT '',
  target                   TEXT NOT NULL DEFAULT '',
  hook_angle               TEXT NOT NULL DEFAULT '',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_creative_angles_project_id ON creative_angles(project_id);

-- 16) Creative generated ----------------------------------------------
CREATE TABLE IF NOT EXISTS creative_generated (
  id                       BIGSERIAL PRIMARY KEY,
  project_id               UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  angle_id                 BIGINT NULL,
  angle_name               TEXT NOT NULL DEFAULT '',
  headline                 TEXT NOT NULL DEFAULT '',
  hook                     TEXT NOT NULL DEFAULT '',
  body                     TEXT NOT NULL DEFAULT '',
  ad_style                 TEXT NOT NULL DEFAULT '',
  target                   TEXT NOT NULL DEFAULT '',
  format                   TEXT NOT NULL DEFAULT 'images',
  gradient_idx             TEXT NOT NULL DEFAULT '0',
  status                   TEXT NOT NULL DEFAULT 'draft',
  generation_notes         TEXT NOT NULL DEFAULT '',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_creative_generated_project_id ON creative_generated(project_id);

-- 17) Funnel monitors -------------------------------------------------
CREATE TABLE IF NOT EXISTS funnel_monitors (
  id                       BIGSERIAL PRIMARY KEY,
  project_id               UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  brand_name               TEXT NOT NULL,
  url                      TEXT NOT NULL,
  frequency                TEXT NOT NULL DEFAULT 'every_15_days',
  status                   TEXT NOT NULL DEFAULT 'active',
  last_checked             TIMESTAMPTZ NULL,
  next_check               TIMESTAMPTZ NULL,
  notes                    TEXT NOT NULL DEFAULT '',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_funnel_monitors_project_id ON funnel_monitors(project_id);

-- 18) Funnel snapshots ------------------------------------------------
CREATE TABLE IF NOT EXISTS funnel_snapshots (
  id                       BIGSERIAL PRIMARY KEY,
  monitor_id               BIGINT NOT NULL REFERENCES funnel_monitors(id) ON DELETE CASCADE,
  project_id               UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  checked_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  page_description         TEXT NOT NULL DEFAULT '',
  cro_elements_json        TEXT NOT NULL DEFAULT '{}',
  changes_json             TEXT NOT NULL DEFAULT '[]',
  ai_analysis              TEXT NOT NULL DEFAULT '',
  screenshot_url           TEXT NOT NULL DEFAULT '',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_funnel_snapshots_monitor_id ON funnel_snapshots(monitor_id);
CREATE INDEX IF NOT EXISTS idx_funnel_snapshots_project_id ON funnel_snapshots(project_id);

-- 19) CRO analyses ----------------------------------------------------
CREATE TABLE IF NOT EXISTS cro_analyses (
  id                       BIGSERIAL PRIMARY KEY,
  project_id               UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url                      TEXT NOT NULL,
  context_notes            TEXT NOT NULL DEFAULT '',
  report_json              TEXT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cro_analyses_project_id ON cro_analyses(project_id);

-- 20) Analytics steps -------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_steps (
  id                       BIGSERIAL PRIMARY KEY,
  project_id               UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_name                TEXT NOT NULL,
  step_type                TEXT NOT NULL DEFAULT 'Landing Page',
  section                  TEXT NOT NULL DEFAULT 'frontend',
  impressions              TEXT NOT NULL DEFAULT '0',
  clicks                   TEXT NOT NULL DEFAULT '0',
  ctr                      TEXT NOT NULL DEFAULT '0',
  cr                       TEXT NOT NULL DEFAULT '0',
  cpa                      TEXT NOT NULL DEFAULT '0',
  aov                      TEXT NOT NULL DEFAULT '0',
  upsell_rate              TEXT NOT NULL DEFAULT '0',
  refund_rate              TEXT NOT NULL DEFAULT '0',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_analytics_steps_project_id ON analytics_steps(project_id);

-- =====================================================================
-- DONE. Remember: also create a Supabase Storage bucket called
-- `project-files` (public read, authenticated write).
-- =====================================================================
