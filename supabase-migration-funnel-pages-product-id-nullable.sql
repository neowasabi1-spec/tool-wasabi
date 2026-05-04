-- =====================================================
-- MIGRATION: rendere product_id NULLABLE su funnel_pages
-- e post_purchase_pages, ora che il selettore della pipeline
-- e collegato a "My Projects" via project_id (vedi
-- supabase-migration-project-id-links.sql).
--
-- Problema risolto: l'ex constraint
--   funnel_pages.product_id NOT NULL REFERENCES products(id)
-- impediva di salvare uno step in cui l'utente seleziona un
-- PROGETTO al posto di un PRODOTTO. Postgres rispondeva con
-- 23502 / 23503 e il dropdown sembrava "non prendere".
--
-- Eseguila nello SQL Editor di Supabase:
-- https://supabase.com/dashboard/project/<your-project>/sql
-- =====================================================

-- 1) Funnel pages: product_id puo essere null
ALTER TABLE funnel_pages
  ALTER COLUMN product_id DROP NOT NULL;

-- 2) Post-purchase pages: product_id puo essere null
ALTER TABLE post_purchase_pages
  ALTER COLUMN product_id DROP NOT NULL;

-- 3) Backfill: per le righe esistenti che hanno solo product_id ma
--    nessun project_id, lasciamo product_id intatto (l'utente
--    selezionera di nuovo il project dal dropdown).
--    Nessuna riga viene cancellata o modificata silenziosamente.

-- =====================================================
-- (Optional) sanity check: verifica che le colonne siano nullable
-- SELECT column_name, is_nullable
--   FROM information_schema.columns
--  WHERE table_name IN ('funnel_pages', 'post_purchase_pages')
--    AND column_name = 'product_id';
-- =====================================================
