-- Ads Creative intelligence (Jev integration) — brand rules, analyses, jobs
-- Apply on a DEV Supabase project before production.

-- Brand rules live on the project (Jev "Brain")
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS brand_rules JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN projects.brand_rules IS
  'Ads Creative brand rules: tone, positioning, palette[], forbidden[], required_elements[], logo_rules, logo_path';

-- Side-table analyses for competitor_ads or own_ads (does not mutate scrape rows)
CREATE TABLE IF NOT EXISTS creative_analyses (
  id            BIGSERIAL PRIMARY KEY,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ad_source     TEXT NOT NULL CHECK (ad_source IN ('competitor', 'own')),
  ad_ref_id     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'extracting', 'analyzing', 'ready', 'failed')),
  extraction    JSONB NOT NULL DEFAULT '{}'::jsonb,
  ranking       JSONB NOT NULL DEFAULT '{}'::jsonb,
  error         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, ad_source, ad_ref_id)
);

CREATE INDEX IF NOT EXISTS creative_analyses_project_idx
  ON creative_analyses (project_id, updated_at DESC);

-- Job queue for ads-intel (local inline or Netlify background)
CREATE TABLE IF NOT EXISTS ads_intel_jobs (
  id            BIGSERIAL PRIMARY KEY,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  progress      TEXT NOT NULL DEFAULT '',
  result        JSONB,
  error         TEXT NOT NULL DEFAULT '',
  attempts      INT NOT NULL DEFAULT 0,
  run_after     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ads_intel_jobs_claim_idx
  ON ads_intel_jobs (status, run_after)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS ads_intel_jobs_project_idx
  ON ads_intel_jobs (project_id, created_at DESC);

-- Per-user Meta connections (OAuth or env-spike mirrored for local tests)
CREATE TABLE IF NOT EXISTS user_meta_connections (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL,
  access_token_enc TEXT NOT NULL DEFAULT '',
  token_expires_at TIMESTAMPTZ,
  scopes          TEXT[] NOT NULL DEFAULT '{}',
  fb_user_id      TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS user_meta_ad_accounts (
  id              BIGSERIAL PRIMARY KEY,
  connection_id   BIGINT NOT NULL REFERENCES user_meta_connections(id) ON DELETE CASCADE,
  act_id          TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, act_id)
);

CREATE TABLE IF NOT EXISTS own_ads (
  id              BIGSERIAL PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ad_account_id   TEXT NOT NULL DEFAULT '',
  external_ad_id  TEXT NOT NULL,
  ad_name         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT '',
  headline        TEXT NOT NULL DEFAULT '',
  body_text       TEXT NOT NULL DEFAULT '',
  media_type      TEXT NOT NULL DEFAULT 'image',
  media_url       TEXT NOT NULL DEFAULT '',
  thumbnail_url   TEXT NOT NULL DEFAULT '',
  raw             JSONB NOT NULL DEFAULT '{}'::jsonb,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, external_ad_id)
);

CREATE INDEX IF NOT EXISTS own_ads_project_idx ON own_ads (project_id, synced_at DESC);

CREATE TABLE IF NOT EXISTS own_ad_insights (
  id              BIGSERIAL PRIMARY KEY,
  own_ad_id       BIGINT NOT NULL REFERENCES own_ads(id) ON DELETE CASCADE,
  date_start      DATE NOT NULL,
  date_end        DATE NOT NULL,
  spend           NUMERIC NOT NULL DEFAULT 0,
  impressions     BIGINT NOT NULL DEFAULT 0,
  clicks          BIGINT NOT NULL DEFAULT 0,
  ctr             NUMERIC NOT NULL DEFAULT 0,
  cpa             NUMERIC,
  roas            NUMERIC,
  hook_rate       NUMERIC,
  purchases       NUMERIC NOT NULL DEFAULT 0,
  UNIQUE (own_ad_id, date_start, date_end)
);

CREATE TABLE IF NOT EXISTS creative_concepts (
  id              BIGSERIAL PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'image' CHECK (kind IN ('text', 'image', 'video')),
  title           TEXT NOT NULL DEFAULT '',
  brief           TEXT NOT NULL DEFAULT '',
  dna             JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_analysis_ids BIGINT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'draft',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creative_concepts_project_idx ON creative_concepts (project_id, created_at DESC);

-- Extend creative_outputs for WAS- codes / specs / assets (additive, ignore if cols exist)
ALTER TABLE creative_outputs ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE creative_outputs ADD COLUMN IF NOT EXISTS concept_id BIGINT;
ALTER TABLE creative_outputs ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'image';
ALTER TABLE creative_outputs ADD COLUMN IF NOT EXISTS spec JSONB DEFAULT '{}'::jsonb;
ALTER TABLE creative_outputs ADD COLUMN IF NOT EXISTS result_path TEXT DEFAULT '';
ALTER TABLE creative_outputs ADD COLUMN IF NOT EXISTS gate_decision TEXT DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS creative_outputs_code_uidx ON creative_outputs (code) WHERE code IS NOT NULL AND code <> '';
