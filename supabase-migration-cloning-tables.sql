-- =====================================================
-- MIGRAZIONE: Tabelle per Clone Competitor (smooth-responder)
-- =====================================================
-- Esegui questo SQL nella console SQL di Supabase
-- Dashboard → SQL Editor → New Query → Incolla ed esegui

-- 1. Tabella user_profiles (se non esiste già)
-- Necessaria per memorizzare le API key degli utenti
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anthropic_api_key TEXT,
  screenshotone_access_key TEXT,
  screenshotone_secret_key TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Inserisci utente default per il dashboard
-- ⚠️ IMPORTANTE: Sostituisci 'YOUR_ANTHROPIC_API_KEY' con la tua API key reale
INSERT INTO user_profiles (id, anthropic_api_key) 
VALUES (
  '00000000-0000-0000-0000-000000000001', 
  'YOUR_ANTHROPIC_API_KEY'
)
ON CONFLICT (id) DO UPDATE SET 
  anthropic_api_key = EXCLUDED.anthropic_api_key,
  updated_at = NOW();

-- 2. Tabella cloning_jobs - Job di clonazione
CREATE TABLE IF NOT EXISTS cloning_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES user_profiles(id),
  url TEXT NOT NULL,
  clone_mode TEXT NOT NULL DEFAULT 'rewrite',
  product_name TEXT DEFAULT '',
  product_description TEXT DEFAULT '',
  price_full TEXT,
  price_discounted TEXT,
  output_format TEXT DEFAULT 'html',
  categoria TEXT,
  framework TEXT,
  target TEXT,
  custom_prompt TEXT,
  original_html TEXT,
  final_html TEXT,
  total_texts INTEGER DEFAULT 0,
  status TEXT DEFAULT 'extracting',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Indice per velocizzare lookup per utente
CREATE INDEX IF NOT EXISTS idx_cloning_jobs_user_id ON cloning_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_cloning_jobs_status ON cloning_jobs(status);

-- 3. Tabella cloning_texts - Singoli testi estratti per ogni job
CREATE TABLE IF NOT EXISTS cloning_texts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES cloning_jobs(id) ON DELETE CASCADE,
  index INTEGER NOT NULL,
  original_text TEXT NOT NULL,
  raw_text TEXT,
  new_text TEXT,
  tag_name TEXT DEFAULT '',
  full_tag TEXT DEFAULT '',
  classes TEXT DEFAULT '',
  attributes TEXT DEFAULT '',
  context TEXT DEFAULT '',
  position INTEGER DEFAULT 0,
  processed BOOLEAN DEFAULT FALSE,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indici per velocizzare le query
CREATE INDEX IF NOT EXISTS idx_cloning_texts_job_id ON cloning_texts(job_id);
CREATE INDEX IF NOT EXISTS idx_cloning_texts_processed ON cloning_texts(job_id, processed);
CREATE INDEX IF NOT EXISTS idx_cloning_texts_index ON cloning_texts(job_id, index);

-- 4. RLS (Row Level Security) - Disabilitato per semplicità
-- Se vuoi abilitare RLS, decommentare e configurare le policy
-- ALTER TABLE cloning_jobs ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE cloning_texts ENABLE ROW LEVEL SECURITY;

-- 5. Verifica
SELECT 'Migrazione completata!' AS status,
  (SELECT COUNT(*) FROM user_profiles) AS user_profiles_count,
  EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'cloning_jobs') AS cloning_jobs_exists,
  EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'cloning_texts') AS cloning_texts_exists;
