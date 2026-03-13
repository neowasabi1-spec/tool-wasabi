-- =====================================================
-- Migration: affiliate_saved_funnels
-- Salva funnel e quiz analizzati dall'agente browser,
-- strutturati da Claude AI, dalla pagina Affiliate Browser Chat
-- =====================================================

CREATE TABLE IF NOT EXISTS affiliate_saved_funnels (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Collegamento alla chat che ha generato il risultato
  chat_id               UUID        NULL REFERENCES affiliate_browser_chats(id) ON DELETE SET NULL,

  -- Identità del funnel
  funnel_name           TEXT        NOT NULL,                -- Es: "Bioma Health Weight Loss Quiz"
  brand_name            TEXT        NULL,                    -- Es: "Bioma Health"
  entry_url             TEXT        NOT NULL,                -- URL di ingresso del funnel

  -- Classificazione AI
  funnel_type           TEXT        NOT NULL DEFAULT 'other', -- quiz_funnel | sales_funnel | landing_page | webinar_funnel | tripwire_funnel | lead_magnet | vsl_funnel | other
  category              TEXT        NOT NULL DEFAULT 'other', -- weight_loss | supplements | skincare | fitness | finance | saas | ecommerce | health | education | other
  tags                  TEXT[]      NOT NULL DEFAULT '{}',    -- Tag liberi assegnati da Claude

  -- Dati strutturati
  total_steps           INTEGER     NOT NULL DEFAULT 0,
  steps                 JSONB       NOT NULL DEFAULT '[]',   -- Array di step strutturati
  /*
    Formato di ogni step in steps[]:
    {
      "step_index": 1,
      "url": "https://...",
      "title": "Titolo/Domanda dello step",
      "step_type": "quiz_question" | "info_screen" | "lead_capture" | "checkout" | "upsell" | "thank_you" | "landing" | "other",
      "input_type": "multiple_choice" | "checkbox" | "text_input" | "numeric_input" | "image_select" | "button" | "none",
      "options": ["Opzione 1", "Opzione 2"],
      "description": "Descrizione degli elementi visibili",
      "cta_text": "Testo del pulsante principale"
    }
  */

  -- Analisi AI
  analysis_summary      TEXT        NULL,                    -- Riassunto dell'analisi generato da Claude
  persuasion_techniques TEXT[]      NOT NULL DEFAULT '{}',   -- Tecniche di persuasione identificate
  lead_capture_method   TEXT        NULL,                    -- email | phone | form | none
  notable_elements      TEXT[]      NOT NULL DEFAULT '{}',   -- Elementi notevoli (progress bar, social proof, urgency, ecc.)

  -- Testo originale dell'agente (per riferimento)
  raw_agent_result      TEXT        NOT NULL,

  -- Timestamps
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indici per ricerca e filtraggio
CREATE INDEX IF NOT EXISTS idx_affiliate_saved_funnels_type
  ON affiliate_saved_funnels (funnel_type);

CREATE INDEX IF NOT EXISTS idx_affiliate_saved_funnels_category
  ON affiliate_saved_funnels (category);

CREATE INDEX IF NOT EXISTS idx_affiliate_saved_funnels_brand
  ON affiliate_saved_funnels (brand_name);

CREATE INDEX IF NOT EXISTS idx_affiliate_saved_funnels_created
  ON affiliate_saved_funnels (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_affiliate_saved_funnels_chat_id
  ON affiliate_saved_funnels (chat_id);

-- Trigger per aggiornare updated_at automaticamente
CREATE OR REPLACE FUNCTION update_affiliate_saved_funnels_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_affiliate_saved_funnels_updated_at ON affiliate_saved_funnels;
CREATE TRIGGER trg_affiliate_saved_funnels_updated_at
  BEFORE UPDATE ON affiliate_saved_funnels
  FOR EACH ROW
  EXECUTE FUNCTION update_affiliate_saved_funnels_updated_at();
