-- Aggiunge la colonna vision_analysis alla tabella funnel_crawl_steps (analisi AI Vision)
-- Esegui in Supabase SQL Editor

ALTER TABLE funnel_crawl_steps
  ADD COLUMN IF NOT EXISTS vision_analysis JSONB DEFAULT NULL;

COMMENT ON COLUMN funnel_crawl_steps.vision_analysis IS 'Analisi AI (Vision) della pagina: page_type, headline, CTA, prezzi, tech stack, ecc.';
