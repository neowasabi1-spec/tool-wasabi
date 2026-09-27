-- =====================================================
-- archived_funnels.steps_meta: the steps WITHOUT page HTML.
--
-- `steps` carries the full HTML of every page (~145 kB compressed per funnel,
-- 147 MB in total). The list endpoints only need names, URLs and screenshots,
-- but reading `steps` makes Postgres decompress and serialize all of it: in
-- pg_stat_statements those reads were ~half of the database time.
--
-- steps_meta holds the same array with the HTML keys removed (same keys as
-- slimOneStep() in src/lib/slim-archived-funnels.ts). A trigger keeps it in
-- sync on every write, so no write path in the app has to change.
-- Safe to run multiple times.
-- =====================================================

-- 1) Pure function: steps → steps without HTML.
-- Never raises: a malformed legacy value yields '[]' instead of failing the
-- write that fired the trigger.
CREATE OR REPLACE FUNCTION public.archived_steps_meta(p_steps jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  arr jsonb := p_steps;
BEGIN
  -- Some legacy rows store the array as a JSON string.
  IF jsonb_typeof(arr) = 'string' THEN
    BEGIN
      arr := (arr #>> '{}')::jsonb;
    EXCEPTION WHEN others THEN
      arr := NULL;
    END;
  END IF;
  IF arr IS NULL OR jsonb_typeof(arr) <> 'array' THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(
             CASE WHEN jsonb_typeof(e.elem) = 'object' THEN COALESCE((
               SELECT jsonb_object_agg(
                        kv.key,
                        CASE WHEN kv.key IN ('cloned_data', 'swiped_data', 'extracted_data')
                               AND jsonb_typeof(kv.value) = 'object'
                             THEN kv.value - ARRAY['html', 'mobileHtml', 'htmlMobile', 'rawHtml', 'renderedHtml', 'content']
                             ELSE kv.value
                        END)
               FROM jsonb_each(e.elem) AS kv
             ), '{}'::jsonb)
             ELSE e.elem
             END
             ORDER BY e.ord)
    FROM jsonb_array_elements(arr) WITH ORDINALITY AS e(elem, ord)
  ), '[]'::jsonb);
END;
$$;

-- 2) Column (NULL = not backfilled yet; the app then falls back to `steps`).
ALTER TABLE archived_funnels ADD COLUMN IF NOT EXISTS steps_meta jsonb;

-- 3) Keep it in sync on every insert and on every update that touches steps.
CREATE OR REPLACE FUNCTION public.archived_funnels_sync_steps_meta()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.steps_meta := public.archived_steps_meta(NEW.steps);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_archived_funnels_steps_meta ON archived_funnels;
CREATE TRIGGER trg_archived_funnels_steps_meta
  BEFORE INSERT OR UPDATE OF steps ON archived_funnels
  FOR EACH ROW EXECUTE FUNCTION public.archived_funnels_sync_steps_meta();

-- 4) BACKFILL — run SEPARATELY, after the statements above, ideally when the
--    app is quiet. It decompresses 100 funnels per run: re-run it until the
--    editor reports "0 rows affected" (about 11 runs for ~1050 funnels).
--
-- UPDATE archived_funnels
--    SET steps_meta = public.archived_steps_meta(steps)
--  WHERE id IN (SELECT id FROM archived_funnels WHERE steps_meta IS NULL LIMIT 100);
--
-- Check (should return 0, and a total far below the 147 MB of `steps`):
--
-- SELECT count(*) FILTER (WHERE steps_meta IS NULL) AS mancanti,
--        pg_size_pretty(sum(pg_column_size(steps_meta))::bigint) AS peso_meta
--   FROM archived_funnels;
