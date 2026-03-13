-- =====================================================
-- Migration: scheduled_browser_jobs
-- Job programmabili che vengono eseguiti automaticamente
-- tramite cron endpoint (es. ogni giorno alle 6:00 UTC)
-- =====================================================

CREATE TABLE IF NOT EXISTS scheduled_browser_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Template/prompt info
  template_id     TEXT        NOT NULL,           -- ID del template (dalla lista default o 'custom')
  title           TEXT        NOT NULL,           -- Titolo visibile (es. "Facebook Ad Library — Health")
  prompt          TEXT        NOT NULL,           -- Prompt completo per l'agente
  start_url       TEXT        NULL,               -- URL di partenza (null = Google)
  max_turns       INTEGER     NOT NULL DEFAULT 100,
  category        TEXT        NOT NULL DEFAULT 'custom',  -- spy_ads | competitor_analysis | trends | funnel_analysis | content_research | offer_discovery | custom
  tags            TEXT[]      NOT NULL DEFAULT '{}',

  -- Schedule config
  frequency       TEXT        NOT NULL DEFAULT 'daily',  -- daily | weekly | bi_weekly | monthly
  is_active       BOOLEAN     NOT NULL DEFAULT true,     -- Se false, il job non viene eseguito
  next_run_at     TIMESTAMPTZ NOT NULL DEFAULT now(),    -- Prossima esecuzione programmata
  last_run_at     TIMESTAMPTZ NULL,                       -- Ultima esecuzione

  -- Last execution info
  last_job_id     TEXT        NULL,                       -- Job ID dell'ultima esecuzione remota
  last_status     TEXT        NULL,                       -- Status dell'ultima esecuzione
  last_result     TEXT        NULL,                       -- Risultato dell'ultima esecuzione
  last_error      TEXT        NULL,                       -- Errore dell'ultima esecuzione
  total_runs      INTEGER     NOT NULL DEFAULT 0,         -- Totale esecuzioni effettuate
  successful_runs INTEGER     NOT NULL DEFAULT 0,         -- Esecuzioni completate con successo

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indice per trovare job da eseguire (attivi con next_run_at <= now)
CREATE INDEX IF NOT EXISTS idx_scheduled_browser_jobs_next_run
  ON scheduled_browser_jobs (next_run_at)
  WHERE is_active = true;

-- Indice per cercare per categoria
CREATE INDEX IF NOT EXISTS idx_scheduled_browser_jobs_category
  ON scheduled_browser_jobs (category);

-- Indice per cercare per stato attivo
CREATE INDEX IF NOT EXISTS idx_scheduled_browser_jobs_active
  ON scheduled_browser_jobs (is_active);

-- Trigger per aggiornare updated_at automaticamente
CREATE OR REPLACE FUNCTION update_scheduled_browser_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_scheduled_browser_jobs_updated_at ON scheduled_browser_jobs;
CREATE TRIGGER trg_scheduled_browser_jobs_updated_at
  BEFORE UPDATE ON scheduled_browser_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_scheduled_browser_jobs_updated_at();
