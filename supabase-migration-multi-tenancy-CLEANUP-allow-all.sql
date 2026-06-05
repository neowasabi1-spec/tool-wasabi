-- ============================================================
-- CLEANUP: drop legacy "Allow all" policies that vanificavano la
-- migration multi-tenancy.
-- ============================================================
--
-- Problema:
--   La migration phase 1 (`supabase-migration-multi-tenancy.sql`)
--   droppava solo le policy chiamate "Allow all" e "Enable all
--   access for authenticated users", ma su questo progetto le
--   policy storiche si chiamano:
--
--     "Allow all operations on funnel_pages"
--     "Allow all operations on archived_funnels"
--     ...etc, una per ogni tabella
--
--   Postgres applica le policy PERMISSIVE in OR: anche con le mie
--   nuove policy owner_or_master_*, quella vecchia che dice
--   `USING (true) WITH CHECK (true)` lascia passare TUTTO.
--   Risultato: l'utente vede sempre tutti i dati del master.
--
-- Fix:
--   Loop dinamico che droppa OGNI policy il cui nome inizia per
--   "Allow all" su QUALSIASI tabella public.* che ha la colonna
--   owner_user_id (= le 24 tabelle multi-tenant). Sicuro perche':
--     - non tocca tabelle che non abbiamo migrato a multi-tenancy
--     - non tocca le policy `*_owner_or_master_*` create da noi
--     - non tocca eventuali policy granulari di Supabase Auth
--
-- Esecuzione:
--   Lancia questo file UNA VOLTA in Supabase SQL Editor.
--   Idempotente: rilanciarlo non rompe nulla (drop su policy gia'
--   sparite e' un no-op grazie a IF EXISTS).
-- ============================================================

BEGIN;

DO $$
DECLARE
  r RECORD;
  drop_count INT := 0;
BEGIN
  FOR r IN
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      pol.polname AS policy_name
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND pol.polname ILIKE 'Allow all%'
      -- Only target tables that participate in multi-tenancy.
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns col
        WHERE col.table_schema = n.nspname
          AND col.table_name = c.relname
          AND col.column_name = 'owner_user_id'
      )
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      r.policy_name, r.schema_name, r.table_name
    );
    drop_count := drop_count + 1;
    RAISE NOTICE 'dropped policy "%" on %.%', r.policy_name, r.schema_name, r.table_name;
  END LOOP;

  RAISE NOTICE 'cleanup done: % legacy "Allow all%%" policies removed', drop_count;
END $$;

-- Verifica post-cleanup: nessuna policy "Allow all%" deve rimanere
-- sulle tabelle multi-tenant. Restituisce 0 righe se tutto ok.
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  pol.polname AS leftover_policy
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND pol.polname ILIKE 'Allow all%'
  AND EXISTS (
    SELECT 1 FROM information_schema.columns col
    WHERE col.table_schema = n.nspname
      AND col.table_name = c.relname
      AND col.column_name = 'owner_user_id'
  );

COMMIT;

-- ============================================================
-- Post-check rapido: per ogni tabella multi-tenant mostra
-- (a) se RLS e' abilitata e (b) quante policy ha residue.
-- Se vedi RLS=false su qualche tabella, devi ri-abilitarla:
--   ALTER TABLE public.<table> ENABLE ROW LEVEL SECURITY;
-- ============================================================

SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  (SELECT COUNT(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND EXISTS (
    SELECT 1 FROM information_schema.columns col
    WHERE col.table_schema = n.nspname
      AND col.table_name = c.relname
      AND col.column_name = 'owner_user_id'
  )
ORDER BY c.relname;
