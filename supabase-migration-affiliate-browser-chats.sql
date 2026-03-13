-- =====================================================
-- Migration: affiliate_browser_chats
-- Salva ogni prompt inviato dalla pagina Affiliate Browser Chat
-- =====================================================

CREATE TABLE IF NOT EXISTS affiliate_browser_chats (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Prompt e configurazione inviati dall'utente
  prompt        TEXT        NOT NULL,
  start_url     TEXT        NULL,           -- URL di partenza (null = Google)
  max_turns     INTEGER     NOT NULL DEFAULT 100,

  -- Riferimento al job sull'agentic server
  job_id        TEXT        NULL,           -- ID del job remoto

  -- Stato e risultati
  status        TEXT        NOT NULL DEFAULT 'queued',  -- queued | starting | running | completed | max_turns | blocked | error
  result        TEXT        NULL,           -- Risultato finale dell'agente
  error         TEXT        NULL,           -- Messaggio di errore (se presente)
  turns_used    INTEGER     NOT NULL DEFAULT 0,
  final_url     TEXT        NULL,           -- Ultimo URL visitato dall'agente

  -- Timestamps
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ NULL
);

-- Indice per cercare per stato (es. tutti i job completati)
CREATE INDEX IF NOT EXISTS idx_affiliate_browser_chats_status
  ON affiliate_browser_chats (status);

-- Indice per ordine cronologico
CREATE INDEX IF NOT EXISTS idx_affiliate_browser_chats_created
  ON affiliate_browser_chats (created_at DESC);

-- Trigger per aggiornare updated_at automaticamente
CREATE OR REPLACE FUNCTION update_affiliate_browser_chats_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_affiliate_browser_chats_updated_at ON affiliate_browser_chats;
CREATE TRIGGER trg_affiliate_browser_chats_updated_at
  BEFORE UPDATE ON affiliate_browser_chats
  FOR EACH ROW
  EXECUTE FUNCTION update_affiliate_browser_chats_updated_at();

-- RLS: abilita Row Level Security (opzionale, disabilitato per semplicità)
-- ALTER TABLE affiliate_browser_chats ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Allow all" ON affiliate_browser_chats FOR ALL USING (true);
