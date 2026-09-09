-- =====================================================
-- Persist every Clone/Swipe TYPE (Upsell, TSL, Quiz, custom, …)
-- =====================================================
-- funnel_pages.page_type / swipe_templates.page_type were a tiny enum.
-- The app mapped everything else to `altro`, and the TYPE <select> has no
-- `altro` option, so the browser showed the first item (Bridge Page).
--
-- 1) Add every built-in slug to the enum (safe if already present).
-- 2) Convert both columns to text so custom "+ New Type" values persist too.
-- Run in the Supabase SQL editor.
-- =====================================================

DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'lst'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'tsl'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'quiz'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'upsell_1'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'upsell_2'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'upsell_3'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'downsell_1'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'downsell_2'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'downsell_3'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'bridge_page'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'vsl'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'thank_you'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'upsell'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'downsell'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'oto'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'other'; EXCEPTION WHEN OTHERS THEN NULL; END $$;

DROP VIEW IF EXISTS public.v_funnel_dropoff;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'funnel_pages'
      AND column_name = 'page_type' AND udt_name = 'page_type'
  ) THEN
    ALTER TABLE public.funnel_pages ALTER COLUMN page_type DROP DEFAULT;
    ALTER TABLE public.funnel_pages ALTER COLUMN page_type TYPE text USING page_type::text;
    ALTER TABLE public.funnel_pages ALTER COLUMN page_type SET DEFAULT 'landing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'swipe_templates'
      AND column_name = 'page_type' AND udt_name = 'page_type'
  ) THEN
    ALTER TABLE public.swipe_templates ALTER COLUMN page_type DROP DEFAULT;
    ALTER TABLE public.swipe_templates ALTER COLUMN page_type TYPE text USING page_type::text;
    ALTER TABLE public.swipe_templates ALTER COLUMN page_type SET DEFAULT 'landing';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'analytics_events'
  ) THEN
    EXECUTE $v$
CREATE OR REPLACE VIEW public.v_funnel_dropoff AS
WITH step_sessions AS (
  SELECT
    e.project_id,
    e.page_id,
    fp.name AS page_name,
    fp.page_type::text AS page_type,
    CASE fp.page_type::text
      WHEN 'lander' THEN 10
      WHEN 'landing' THEN 10
      WHEN 'presell' THEN 20
      WHEN 'advertorial' THEN 20
      WHEN 'quiz' THEN 30
      WHEN 'vsl' THEN 40
      WHEN 'checkout' THEN 50
      WHEN 'upsell' THEN 60
      WHEN 'upsell_1' THEN 60
      WHEN 'downsell' THEN 65
      WHEN 'downsell_1' THEN 65
      WHEN 'thank_you' THEN 70
      WHEN 'thankyou' THEN 70
      ELSE 99
    END AS step_order,
    fp.created_at,
    COUNT(DISTINCT e.session_id) AS sessions_count
  FROM analytics_events e
  LEFT JOIN funnel_pages fp ON fp.id = e.page_id
  WHERE e.event_type = 'pageview'
    AND e.is_bot = FALSE
    AND e.page_id IS NOT NULL
  GROUP BY e.project_id, e.page_id, fp.name, fp.page_type, fp.created_at
)
SELECT
  project_id,
  page_id,
  page_name,
  page_type,
  step_order,
  sessions_count,
  LAG(sessions_count) OVER (
    PARTITION BY project_id
    ORDER BY step_order, created_at
  ) AS previous_step_sessions,
  CASE
    WHEN LAG(sessions_count) OVER (
      PARTITION BY project_id
      ORDER BY step_order, created_at
    ) > 0
    THEN ROUND(
      (1.0 - sessions_count::numeric / LAG(sessions_count) OVER (
        PARTITION BY project_id
        ORDER BY step_order, created_at
      )) * 100,
      2
    )
    ELSE NULL
  END AS dropoff_pct,
  CASE
    WHEN FIRST_VALUE(sessions_count) OVER (
      PARTITION BY project_id
      ORDER BY step_order, created_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) > 0
    THEN ROUND(
      sessions_count::numeric / FIRST_VALUE(sessions_count) OVER (
        PARTITION BY project_id
        ORDER BY step_order, created_at
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
      ) * 100,
      2
    )
    ELSE NULL
  END AS conversion_pct
FROM step_sessions
ORDER BY project_id, step_order, created_at
    $v$;
  END IF;
END $$;
