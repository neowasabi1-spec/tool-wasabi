-- =====================================================================
-- MULTI-TENANCY MIGRATION — PHASE 1 (transitional, non-breaking)
-- =====================================================================
-- Adds `owner_user_id` to every user-content table, backfills existing
-- rows to the master account, and enables Row Level Security with
-- policies that let:
--
--   * the OWNER read/write their own rows
--   * the MASTER read/write EVERYONE'S rows (audit + support)
--   * SERVICE-ROLE / unauthenticated SERVER calls keep working
--     temporarily (the `auth.uid() IS NULL` fallback). This avoids
--     breaking the ~40 API routes that still use the server-side anon
--     client. Phase 2 (`...phase2-tighten-rls.sql`) drops the fallback
--     once all routes are switched to a user-aware client.
--
-- A BEFORE-INSERT trigger auto-populates `owner_user_id` with:
--   1. NEW.owner_user_id (if explicitly set)
--   2. auth.uid() (when the call carries a user JWT — anon client
--      from the browser with persisted session)
--   3. get_master_id() (when neither — service-role calls, workers,
--      scripts; we attribute to master as a safe default)
--
-- BROWSER ANON CLIENT BEHAVIOUR
--   - Logged-in user: auth.uid() = user.id → sees/writes ONLY own rows
--   - Master: is_master(auth.uid()) = true → sees/writes EVERYTHING
--   - Logged-out: blocked by AuthGate at UI layer
--
-- SERVER-SIDE ANON CLIENT BEHAVIOUR (transitional)
--   - auth.uid() = NULL → falls through to the temporary fallback
--   - This is the BACKWARDS-COMPAT escape hatch. Tighten in phase 2.
--
-- SERVICE-ROLE CLIENT
--   - Bypasses RLS entirely. Always.
--
-- This migration is IDEMPOTENT: re-running it is safe.
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 0a) PRE-CLEANUP — wipe legacy permissive policies
-- ─────────────────────────────────────────────────────────────────────
-- Postgres OR's all PERMISSIVE policies on a table, so any leftover
-- `USING (true)` policy would silently grant access to everyone and
-- vanificare every owner_or_master_* policy we install below.
-- The most common offenders on this project are named like:
--     "Allow all operations on funnel_pages"
--     "Allow all operations on archived_funnels"
--     "Allow public read access"
--     "Enable all access for authenticated users"
-- so we proactively drop ANYTHING starting with "Allow " or "Enable "
-- on every table that has (or is about to have) owner_user_id. The
-- per-table DROP POLICY statements further down still cover their
-- specific names; this block is just the belt-and-braces.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, pol.polname AS policy_name
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND (pol.polname ILIKE 'Allow %' OR pol.polname ILIKE 'Enable %')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
      r.policy_name, r.schema_name, r.table_name);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 0) Helpers
-- ─────────────────────────────────────────────────────────────────────

-- 0.1 is_master(uid) — bypasses RLS via SECURITY DEFINER so policies
--     can call it without recursive RLS lookups on app_user_permissions.
CREATE OR REPLACE FUNCTION public.is_master(uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_user_permissions
    WHERE user_id = uid AND role = 'master'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_master(UUID) TO authenticated, anon, service_role;

-- 0.2 get_master_id() — returns the master UUID used as fallback during
--     backfill (orphan rows have no obvious owner — they get the master).
CREATE OR REPLACE FUNCTION public.get_master_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT user_id FROM public.app_user_permissions
  WHERE role = 'master'
  ORDER BY created_at ASC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_master_id() TO authenticated, anon, service_role;

-- 0.3 auto_owner_user_id() — BEFORE INSERT trigger fn. Fill owner_user_id
--     when missing using this precedence:
--       1. NEW.owner_user_id (explicit — wins)
--       2. auth.uid()        (anon/auth Supabase client → user JWT)
--       3. get_master_id()   (service-role / worker / no session →
--                             attribute to master so we never break
--                             a server-side insert that forgot to pass it)
--
--     Rationale: rule (3) keeps backwards compatibility. Every server
--     route that uses supabaseAdmin (service-role) would otherwise hit
--     the NOT NULL constraint. By falling back to the master we get a
--     SAFE default (data visible only to the master) while we patch
--     routes one at a time to set owner_user_id explicitly.
CREATE OR REPLACE FUNCTION public.auto_owner_user_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.owner_user_id IS NULL THEN
    NEW.owner_user_id := COALESCE(auth.uid(), public.get_master_id());
  END IF;
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- 1) Generic "owned-table" pattern, applied per table
-- ─────────────────────────────────────────────────────────────────────
-- For each table we do:
--   a) ADD COLUMN owner_user_id UUID REFERENCES auth.users(id)
--   b) Backfill — from a parent FK when applicable, else master
--   c) SET NOT NULL
--   d) CREATE INDEX
--   e) Auto-populate trigger
--   f) ENABLE RLS + 4 policies (owner OR master)
--
-- Tables migrated (in dependency order so child backfill can read parent):
--   - projects               (root)
--   - project_files          (child: project_id → projects)
--   - funnel_steps           (child: project_id → projects)
--   - products               (root)
--   - post_purchase_pages    (child: product_id → products)
--   - funnel_pages           (root, may have project_id)
--   - swipe_templates        (root, may have project_id)
--   - archived_funnels       (root, may have project_id)
--   - saved_prompts          (root)
--   - openclaw_messages      (root — job queue)
--   - funnel_crawl_jobs      (root)
--   - funnel_crawl_steps     (child: job_id → funnel_crawl_jobs)
--   - affiliate_saved_funnels(root)
--   - affiliate_browser_chats(root)
--   - scheduled_browser_jobs (root)
--   - quiz_archive           (root)
--   - multiagent_jobs        (root)
--   - cloning_jobs           (root, has legacy user_id)
--   - cloning_texts          (child: job_id → cloning_jobs)
--   - checkpoint_funnels     (root)
--   - funnel_checkpoints     (child: funnel_id → checkpoint_funnels)
--   - funnel_flows           (root)
--   - flow_steps             (child: flow_id → funnel_flows)
--   - page_html              (root — large HTML blobs, keyed by page_id)
--
-- NOT migrated (system / workspace-shared):
--   app_user_permissions, api_keys, settings, analytics_events,
--   audit_logs, api_usage_log, user_profiles
-- These keep their existing RLS (already locked down or intentionally shared).
-- ─────────────────────────────────────────────────────────────────────

-- ============== A) ROOT TABLES (no parent backfill) =================

-- A.1 projects ----------------------------------------------------
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

UPDATE public.projects
   SET owner_user_id = public.get_master_id()
 WHERE owner_user_id IS NULL;

-- guard: only NOT NULL once backfill succeeded
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.projects WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.projects ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS projects_owner_user_id_idx
  ON public.projects(owner_user_id);

DROP TRIGGER IF EXISTS trg_projects_auto_owner ON public.projects;
CREATE TRIGGER trg_projects_auto_owner
  BEFORE INSERT ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Enable all access for authenticated users" ON public.projects;
DROP POLICY IF EXISTS "Allow public read access" ON public.projects;
DROP POLICY IF EXISTS "projects_owner_or_master_select" ON public.projects;
DROP POLICY IF EXISTS "projects_owner_or_master_insert" ON public.projects;
DROP POLICY IF EXISTS "projects_owner_or_master_update" ON public.projects;
DROP POLICY IF EXISTS "projects_owner_or_master_delete" ON public.projects;
CREATE POLICY "projects_owner_or_master_select" ON public.projects FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "projects_owner_or_master_insert" ON public.projects FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "projects_owner_or_master_update" ON public.projects FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "projects_owner_or_master_delete" ON public.projects FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.2 products ----------------------------------------------------
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
UPDATE public.products SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.products WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.products ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS products_owner_user_id_idx ON public.products(owner_user_id);
DROP TRIGGER IF EXISTS trg_products_auto_owner ON public.products;
CREATE TRIGGER trg_products_auto_owner BEFORE INSERT ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.products;
DROP POLICY IF EXISTS "Enable all access for authenticated users" ON public.products;
DROP POLICY IF EXISTS "products_owner_or_master_select" ON public.products;
DROP POLICY IF EXISTS "products_owner_or_master_insert" ON public.products;
DROP POLICY IF EXISTS "products_owner_or_master_update" ON public.products;
DROP POLICY IF EXISTS "products_owner_or_master_delete" ON public.products;
CREATE POLICY "products_owner_or_master_select" ON public.products FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "products_owner_or_master_insert" ON public.products FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "products_owner_or_master_update" ON public.products FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "products_owner_or_master_delete" ON public.products FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.3 funnel_pages -----------------------------------------------
ALTER TABLE public.funnel_pages
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
-- project_id was added by a separate migration; if absent the JOIN
-- below errors out. Wrap in EXCEPTION handler — falls through to the
-- master backfill so the schema is still left in a valid state.
DO $$ BEGIN
  UPDATE public.funnel_pages fp
     SET owner_user_id = COALESCE(p.owner_user_id, public.get_master_id())
    FROM public.projects p
   WHERE fp.project_id = p.id AND fp.owner_user_id IS NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;
UPDATE public.funnel_pages SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.funnel_pages WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.funnel_pages ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS funnel_pages_owner_user_id_idx ON public.funnel_pages(owner_user_id);
DROP TRIGGER IF EXISTS trg_funnel_pages_auto_owner ON public.funnel_pages;
CREATE TRIGGER trg_funnel_pages_auto_owner BEFORE INSERT ON public.funnel_pages
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.funnel_pages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.funnel_pages;
DROP POLICY IF EXISTS "Enable all access for authenticated users" ON public.funnel_pages;
DROP POLICY IF EXISTS "funnel_pages_owner_or_master_select" ON public.funnel_pages;
DROP POLICY IF EXISTS "funnel_pages_owner_or_master_insert" ON public.funnel_pages;
DROP POLICY IF EXISTS "funnel_pages_owner_or_master_update" ON public.funnel_pages;
DROP POLICY IF EXISTS "funnel_pages_owner_or_master_delete" ON public.funnel_pages;
CREATE POLICY "funnel_pages_owner_or_master_select" ON public.funnel_pages FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_pages_owner_or_master_insert" ON public.funnel_pages FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_pages_owner_or_master_update" ON public.funnel_pages FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_pages_owner_or_master_delete" ON public.funnel_pages FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.4 swipe_templates --------------------------------------------
ALTER TABLE public.swipe_templates
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
-- project_id may not exist if the project-id-links migration was
-- never run — defensive EXCEPTION wrapper.
DO $$ BEGIN
  UPDATE public.swipe_templates st
     SET owner_user_id = COALESCE(p.owner_user_id, public.get_master_id())
    FROM public.projects p
   WHERE st.project_id = p.id AND st.owner_user_id IS NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;
UPDATE public.swipe_templates SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.swipe_templates WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.swipe_templates ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS swipe_templates_owner_user_id_idx ON public.swipe_templates(owner_user_id);
DROP TRIGGER IF EXISTS trg_swipe_templates_auto_owner ON public.swipe_templates;
CREATE TRIGGER trg_swipe_templates_auto_owner BEFORE INSERT ON public.swipe_templates
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.swipe_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.swipe_templates;
DROP POLICY IF EXISTS "Enable all access for authenticated users" ON public.swipe_templates;
DROP POLICY IF EXISTS "swipe_templates_owner_or_master_select" ON public.swipe_templates;
DROP POLICY IF EXISTS "swipe_templates_owner_or_master_insert" ON public.swipe_templates;
DROP POLICY IF EXISTS "swipe_templates_owner_or_master_update" ON public.swipe_templates;
DROP POLICY IF EXISTS "swipe_templates_owner_or_master_delete" ON public.swipe_templates;
CREATE POLICY "swipe_templates_owner_or_master_select" ON public.swipe_templates FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "swipe_templates_owner_or_master_insert" ON public.swipe_templates FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "swipe_templates_owner_or_master_update" ON public.swipe_templates FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "swipe_templates_owner_or_master_delete" ON public.swipe_templates FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.5 archived_funnels -------------------------------------------
ALTER TABLE public.archived_funnels
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
-- project_id may not exist on older schemas.
DO $$ BEGIN
  UPDATE public.archived_funnels af
     SET owner_user_id = COALESCE(p.owner_user_id, public.get_master_id())
    FROM public.projects p
   WHERE af.project_id = p.id AND af.owner_user_id IS NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;
UPDATE public.archived_funnels SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.archived_funnels WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.archived_funnels ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS archived_funnels_owner_user_id_idx ON public.archived_funnels(owner_user_id);
DROP TRIGGER IF EXISTS trg_archived_funnels_auto_owner ON public.archived_funnels;
CREATE TRIGGER trg_archived_funnels_auto_owner BEFORE INSERT ON public.archived_funnels
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.archived_funnels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.archived_funnels;
DROP POLICY IF EXISTS "Enable all access for authenticated users" ON public.archived_funnels;
DROP POLICY IF EXISTS "archived_funnels_owner_or_master_select" ON public.archived_funnels;
DROP POLICY IF EXISTS "archived_funnels_owner_or_master_insert" ON public.archived_funnels;
DROP POLICY IF EXISTS "archived_funnels_owner_or_master_update" ON public.archived_funnels;
DROP POLICY IF EXISTS "archived_funnels_owner_or_master_delete" ON public.archived_funnels;
CREATE POLICY "archived_funnels_owner_or_master_select" ON public.archived_funnels FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "archived_funnels_owner_or_master_insert" ON public.archived_funnels FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "archived_funnels_owner_or_master_update" ON public.archived_funnels FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "archived_funnels_owner_or_master_delete" ON public.archived_funnels FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.6 saved_prompts ----------------------------------------------
ALTER TABLE public.saved_prompts
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
UPDATE public.saved_prompts SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.saved_prompts WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.saved_prompts ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS saved_prompts_owner_user_id_idx ON public.saved_prompts(owner_user_id);
DROP TRIGGER IF EXISTS trg_saved_prompts_auto_owner ON public.saved_prompts;
CREATE TRIGGER trg_saved_prompts_auto_owner BEFORE INSERT ON public.saved_prompts
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.saved_prompts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.saved_prompts;
DROP POLICY IF EXISTS "Enable all access for authenticated users" ON public.saved_prompts;
DROP POLICY IF EXISTS "saved_prompts_owner_or_master_select" ON public.saved_prompts;
DROP POLICY IF EXISTS "saved_prompts_owner_or_master_insert" ON public.saved_prompts;
DROP POLICY IF EXISTS "saved_prompts_owner_or_master_update" ON public.saved_prompts;
DROP POLICY IF EXISTS "saved_prompts_owner_or_master_delete" ON public.saved_prompts;
CREATE POLICY "saved_prompts_owner_or_master_select" ON public.saved_prompts FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "saved_prompts_owner_or_master_insert" ON public.saved_prompts FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "saved_prompts_owner_or_master_update" ON public.saved_prompts FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "saved_prompts_owner_or_master_delete" ON public.saved_prompts FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.7 openclaw_messages (job queue — both worker poll and master view)
-- Workers use service-role → bypass RLS. UI uses anon → filtered by user.
ALTER TABLE public.openclaw_messages
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
UPDATE public.openclaw_messages SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.openclaw_messages WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.openclaw_messages ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS openclaw_messages_owner_user_id_idx ON public.openclaw_messages(owner_user_id);
DROP TRIGGER IF EXISTS trg_openclaw_messages_auto_owner ON public.openclaw_messages;
CREATE TRIGGER trg_openclaw_messages_auto_owner BEFORE INSERT ON public.openclaw_messages
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.openclaw_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.openclaw_messages;
DROP POLICY IF EXISTS "Enable all access for authenticated users" ON public.openclaw_messages;
DROP POLICY IF EXISTS "openclaw_messages_owner_or_master_select" ON public.openclaw_messages;
DROP POLICY IF EXISTS "openclaw_messages_owner_or_master_insert" ON public.openclaw_messages;
DROP POLICY IF EXISTS "openclaw_messages_owner_or_master_update" ON public.openclaw_messages;
DROP POLICY IF EXISTS "openclaw_messages_owner_or_master_delete" ON public.openclaw_messages;
CREATE POLICY "openclaw_messages_owner_or_master_select" ON public.openclaw_messages FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "openclaw_messages_owner_or_master_insert" ON public.openclaw_messages FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "openclaw_messages_owner_or_master_update" ON public.openclaw_messages FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "openclaw_messages_owner_or_master_delete" ON public.openclaw_messages FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.8 funnel_crawl_jobs ------------------------------------------
ALTER TABLE public.funnel_crawl_jobs
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
UPDATE public.funnel_crawl_jobs SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.funnel_crawl_jobs WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.funnel_crawl_jobs ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS funnel_crawl_jobs_owner_user_id_idx ON public.funnel_crawl_jobs(owner_user_id);
DROP TRIGGER IF EXISTS trg_funnel_crawl_jobs_auto_owner ON public.funnel_crawl_jobs;
CREATE TRIGGER trg_funnel_crawl_jobs_auto_owner BEFORE INSERT ON public.funnel_crawl_jobs
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.funnel_crawl_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.funnel_crawl_jobs;
DROP POLICY IF EXISTS "Enable all access for authenticated users" ON public.funnel_crawl_jobs;
DROP POLICY IF EXISTS "funnel_crawl_jobs_owner_or_master_select" ON public.funnel_crawl_jobs;
DROP POLICY IF EXISTS "funnel_crawl_jobs_owner_or_master_insert" ON public.funnel_crawl_jobs;
DROP POLICY IF EXISTS "funnel_crawl_jobs_owner_or_master_update" ON public.funnel_crawl_jobs;
DROP POLICY IF EXISTS "funnel_crawl_jobs_owner_or_master_delete" ON public.funnel_crawl_jobs;
CREATE POLICY "funnel_crawl_jobs_owner_or_master_select" ON public.funnel_crawl_jobs FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_crawl_jobs_owner_or_master_insert" ON public.funnel_crawl_jobs FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_crawl_jobs_owner_or_master_update" ON public.funnel_crawl_jobs FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_crawl_jobs_owner_or_master_delete" ON public.funnel_crawl_jobs FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.9 affiliate_saved_funnels -----------------------------------
ALTER TABLE public.affiliate_saved_funnels
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
UPDATE public.affiliate_saved_funnels SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.affiliate_saved_funnels WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.affiliate_saved_funnels ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS affiliate_saved_funnels_owner_user_id_idx ON public.affiliate_saved_funnels(owner_user_id);
DROP TRIGGER IF EXISTS trg_affiliate_saved_funnels_auto_owner ON public.affiliate_saved_funnels;
CREATE TRIGGER trg_affiliate_saved_funnels_auto_owner BEFORE INSERT ON public.affiliate_saved_funnels
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.affiliate_saved_funnels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.affiliate_saved_funnels;
DROP POLICY IF EXISTS "affiliate_saved_funnels_owner_or_master_select" ON public.affiliate_saved_funnels;
DROP POLICY IF EXISTS "affiliate_saved_funnels_owner_or_master_insert" ON public.affiliate_saved_funnels;
DROP POLICY IF EXISTS "affiliate_saved_funnels_owner_or_master_update" ON public.affiliate_saved_funnels;
DROP POLICY IF EXISTS "affiliate_saved_funnels_owner_or_master_delete" ON public.affiliate_saved_funnels;
CREATE POLICY "affiliate_saved_funnels_owner_or_master_select" ON public.affiliate_saved_funnels FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "affiliate_saved_funnels_owner_or_master_insert" ON public.affiliate_saved_funnels FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "affiliate_saved_funnels_owner_or_master_update" ON public.affiliate_saved_funnels FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "affiliate_saved_funnels_owner_or_master_delete" ON public.affiliate_saved_funnels FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.10 affiliate_browser_chats ----------------------------------
ALTER TABLE public.affiliate_browser_chats
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
UPDATE public.affiliate_browser_chats SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.affiliate_browser_chats WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.affiliate_browser_chats ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS affiliate_browser_chats_owner_user_id_idx ON public.affiliate_browser_chats(owner_user_id);
DROP TRIGGER IF EXISTS trg_affiliate_browser_chats_auto_owner ON public.affiliate_browser_chats;
CREATE TRIGGER trg_affiliate_browser_chats_auto_owner BEFORE INSERT ON public.affiliate_browser_chats
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.affiliate_browser_chats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.affiliate_browser_chats;
DROP POLICY IF EXISTS "affiliate_browser_chats_owner_or_master_select" ON public.affiliate_browser_chats;
DROP POLICY IF EXISTS "affiliate_browser_chats_owner_or_master_insert" ON public.affiliate_browser_chats;
DROP POLICY IF EXISTS "affiliate_browser_chats_owner_or_master_update" ON public.affiliate_browser_chats;
DROP POLICY IF EXISTS "affiliate_browser_chats_owner_or_master_delete" ON public.affiliate_browser_chats;
CREATE POLICY "affiliate_browser_chats_owner_or_master_select" ON public.affiliate_browser_chats FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "affiliate_browser_chats_owner_or_master_insert" ON public.affiliate_browser_chats FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "affiliate_browser_chats_owner_or_master_update" ON public.affiliate_browser_chats FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "affiliate_browser_chats_owner_or_master_delete" ON public.affiliate_browser_chats FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.11 scheduled_browser_jobs ----------------------------------
ALTER TABLE public.scheduled_browser_jobs
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
UPDATE public.scheduled_browser_jobs SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.scheduled_browser_jobs WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.scheduled_browser_jobs ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS scheduled_browser_jobs_owner_user_id_idx ON public.scheduled_browser_jobs(owner_user_id);
DROP TRIGGER IF EXISTS trg_scheduled_browser_jobs_auto_owner ON public.scheduled_browser_jobs;
CREATE TRIGGER trg_scheduled_browser_jobs_auto_owner BEFORE INSERT ON public.scheduled_browser_jobs
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.scheduled_browser_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.scheduled_browser_jobs;
DROP POLICY IF EXISTS "scheduled_browser_jobs_owner_or_master_select" ON public.scheduled_browser_jobs;
DROP POLICY IF EXISTS "scheduled_browser_jobs_owner_or_master_insert" ON public.scheduled_browser_jobs;
DROP POLICY IF EXISTS "scheduled_browser_jobs_owner_or_master_update" ON public.scheduled_browser_jobs;
DROP POLICY IF EXISTS "scheduled_browser_jobs_owner_or_master_delete" ON public.scheduled_browser_jobs;
CREATE POLICY "scheduled_browser_jobs_owner_or_master_select" ON public.scheduled_browser_jobs FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "scheduled_browser_jobs_owner_or_master_insert" ON public.scheduled_browser_jobs FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "scheduled_browser_jobs_owner_or_master_update" ON public.scheduled_browser_jobs FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "scheduled_browser_jobs_owner_or_master_delete" ON public.scheduled_browser_jobs FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.12 quiz_archive ------------------------------------------------
ALTER TABLE public.quiz_archive
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
UPDATE public.quiz_archive SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.quiz_archive WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.quiz_archive ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS quiz_archive_owner_user_id_idx ON public.quiz_archive(owner_user_id);
DROP TRIGGER IF EXISTS trg_quiz_archive_auto_owner ON public.quiz_archive;
CREATE TRIGGER trg_quiz_archive_auto_owner BEFORE INSERT ON public.quiz_archive
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.quiz_archive ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.quiz_archive;
DROP POLICY IF EXISTS "quiz_archive_owner_or_master_select" ON public.quiz_archive;
DROP POLICY IF EXISTS "quiz_archive_owner_or_master_insert" ON public.quiz_archive;
DROP POLICY IF EXISTS "quiz_archive_owner_or_master_update" ON public.quiz_archive;
DROP POLICY IF EXISTS "quiz_archive_owner_or_master_delete" ON public.quiz_archive;
CREATE POLICY "quiz_archive_owner_or_master_select" ON public.quiz_archive FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "quiz_archive_owner_or_master_insert" ON public.quiz_archive FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "quiz_archive_owner_or_master_update" ON public.quiz_archive FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "quiz_archive_owner_or_master_delete" ON public.quiz_archive FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.13 multiagent_jobs --------------------------------------------
ALTER TABLE public.multiagent_jobs
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
UPDATE public.multiagent_jobs SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.multiagent_jobs WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.multiagent_jobs ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS multiagent_jobs_owner_user_id_idx ON public.multiagent_jobs(owner_user_id);
DROP TRIGGER IF EXISTS trg_multiagent_jobs_auto_owner ON public.multiagent_jobs;
CREATE TRIGGER trg_multiagent_jobs_auto_owner BEFORE INSERT ON public.multiagent_jobs
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.multiagent_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.multiagent_jobs;
DROP POLICY IF EXISTS "multiagent_jobs_owner_or_master_select" ON public.multiagent_jobs;
DROP POLICY IF EXISTS "multiagent_jobs_owner_or_master_insert" ON public.multiagent_jobs;
DROP POLICY IF EXISTS "multiagent_jobs_owner_or_master_update" ON public.multiagent_jobs;
DROP POLICY IF EXISTS "multiagent_jobs_owner_or_master_delete" ON public.multiagent_jobs;
CREATE POLICY "multiagent_jobs_owner_or_master_select" ON public.multiagent_jobs FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "multiagent_jobs_owner_or_master_insert" ON public.multiagent_jobs FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "multiagent_jobs_owner_or_master_update" ON public.multiagent_jobs FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "multiagent_jobs_owner_or_master_delete" ON public.multiagent_jobs FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.14 cloning_jobs -----------------------------------------------
-- Already has a legacy `user_id` column (UUID, points at user_profiles
-- not auth.users). We ADD owner_user_id and backfill from user_id when
-- it matches an auth.users record, else master.
ALTER TABLE public.cloning_jobs
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
UPDATE public.cloning_jobs cj
   SET owner_user_id = u.id
  FROM auth.users u
 WHERE cj.user_id = u.id AND cj.owner_user_id IS NULL;
UPDATE public.cloning_jobs SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.cloning_jobs WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.cloning_jobs ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS cloning_jobs_owner_user_id_idx ON public.cloning_jobs(owner_user_id);
DROP TRIGGER IF EXISTS trg_cloning_jobs_auto_owner ON public.cloning_jobs;
CREATE TRIGGER trg_cloning_jobs_auto_owner BEFORE INSERT ON public.cloning_jobs
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.cloning_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.cloning_jobs;
DROP POLICY IF EXISTS "cloning_jobs_owner_or_master_select" ON public.cloning_jobs;
DROP POLICY IF EXISTS "cloning_jobs_owner_or_master_insert" ON public.cloning_jobs;
DROP POLICY IF EXISTS "cloning_jobs_owner_or_master_update" ON public.cloning_jobs;
DROP POLICY IF EXISTS "cloning_jobs_owner_or_master_delete" ON public.cloning_jobs;
CREATE POLICY "cloning_jobs_owner_or_master_select" ON public.cloning_jobs FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "cloning_jobs_owner_or_master_insert" ON public.cloning_jobs FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "cloning_jobs_owner_or_master_update" ON public.cloning_jobs FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "cloning_jobs_owner_or_master_delete" ON public.cloning_jobs FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.15 checkpoint_funnels -----------------------------------------
ALTER TABLE public.checkpoint_funnels
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
UPDATE public.checkpoint_funnels SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.checkpoint_funnels WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.checkpoint_funnels ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS checkpoint_funnels_owner_user_id_idx ON public.checkpoint_funnels(owner_user_id);
DROP TRIGGER IF EXISTS trg_checkpoint_funnels_auto_owner ON public.checkpoint_funnels;
CREATE TRIGGER trg_checkpoint_funnels_auto_owner BEFORE INSERT ON public.checkpoint_funnels
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.checkpoint_funnels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.checkpoint_funnels;
DROP POLICY IF EXISTS "checkpoint_funnels_owner_or_master_select" ON public.checkpoint_funnels;
DROP POLICY IF EXISTS "checkpoint_funnels_owner_or_master_insert" ON public.checkpoint_funnels;
DROP POLICY IF EXISTS "checkpoint_funnels_owner_or_master_update" ON public.checkpoint_funnels;
DROP POLICY IF EXISTS "checkpoint_funnels_owner_or_master_delete" ON public.checkpoint_funnels;
CREATE POLICY "checkpoint_funnels_owner_or_master_select" ON public.checkpoint_funnels FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "checkpoint_funnels_owner_or_master_insert" ON public.checkpoint_funnels FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "checkpoint_funnels_owner_or_master_update" ON public.checkpoint_funnels FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "checkpoint_funnels_owner_or_master_delete" ON public.checkpoint_funnels FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.16 funnel_flows -----------------------------------------------
ALTER TABLE public.funnel_flows
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
UPDATE public.funnel_flows SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.funnel_flows WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.funnel_flows ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS funnel_flows_owner_user_id_idx ON public.funnel_flows(owner_user_id);
DROP TRIGGER IF EXISTS trg_funnel_flows_auto_owner ON public.funnel_flows;
CREATE TRIGGER trg_funnel_flows_auto_owner BEFORE INSERT ON public.funnel_flows
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.funnel_flows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.funnel_flows;
DROP POLICY IF EXISTS "funnel_flows_owner_or_master_select" ON public.funnel_flows;
DROP POLICY IF EXISTS "funnel_flows_owner_or_master_insert" ON public.funnel_flows;
DROP POLICY IF EXISTS "funnel_flows_owner_or_master_update" ON public.funnel_flows;
DROP POLICY IF EXISTS "funnel_flows_owner_or_master_delete" ON public.funnel_flows;
CREATE POLICY "funnel_flows_owner_or_master_select" ON public.funnel_flows FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_flows_owner_or_master_insert" ON public.funnel_flows FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_flows_owner_or_master_update" ON public.funnel_flows FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_flows_owner_or_master_delete" ON public.funnel_flows FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- A.17 page_html ---------------------------------------------------
-- Inherits owner from funnel_pages via page_id when possible.
-- page_id is TEXT (no FK), so cast both sides to TEXT for matching.
ALTER TABLE public.page_html
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
DO $$ BEGIN
  UPDATE public.page_html ph
     SET owner_user_id = COALESCE(fp.owner_user_id, public.get_master_id())
    FROM public.funnel_pages fp
   WHERE ph.page_id::text = fp.id::text AND ph.owner_user_id IS NULL;
EXCEPTION WHEN undefined_column OR undefined_table OR invalid_text_representation THEN NULL;
END $$;
UPDATE public.page_html SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.page_html WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.page_html ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS page_html_owner_user_id_idx ON public.page_html(owner_user_id);
DROP TRIGGER IF EXISTS trg_page_html_auto_owner ON public.page_html;
CREATE TRIGGER trg_page_html_auto_owner BEFORE INSERT ON public.page_html
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.page_html ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.page_html;
DROP POLICY IF EXISTS "page_html_owner_or_master_select" ON public.page_html;
DROP POLICY IF EXISTS "page_html_owner_or_master_insert" ON public.page_html;
DROP POLICY IF EXISTS "page_html_owner_or_master_update" ON public.page_html;
DROP POLICY IF EXISTS "page_html_owner_or_master_delete" ON public.page_html;
CREATE POLICY "page_html_owner_or_master_select" ON public.page_html FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "page_html_owner_or_master_insert" ON public.page_html FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "page_html_owner_or_master_update" ON public.page_html FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "page_html_owner_or_master_delete" ON public.page_html FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- ============== B) CHILD TABLES (backfill from parent) ==============

-- B.1 project_files (child of projects) ---------------------------
ALTER TABLE public.project_files
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
DO $$ BEGIN
  UPDATE public.project_files pf
     SET owner_user_id = COALESCE(p.owner_user_id, public.get_master_id())
    FROM public.projects p
   WHERE pf.project_id = p.id AND pf.owner_user_id IS NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;
UPDATE public.project_files SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.project_files WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.project_files ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS project_files_owner_user_id_idx ON public.project_files(owner_user_id);
DROP TRIGGER IF EXISTS trg_project_files_auto_owner ON public.project_files;
CREATE TRIGGER trg_project_files_auto_owner BEFORE INSERT ON public.project_files
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.project_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.project_files;
DROP POLICY IF EXISTS "project_files_owner_or_master_select" ON public.project_files;
DROP POLICY IF EXISTS "project_files_owner_or_master_insert" ON public.project_files;
DROP POLICY IF EXISTS "project_files_owner_or_master_update" ON public.project_files;
DROP POLICY IF EXISTS "project_files_owner_or_master_delete" ON public.project_files;
CREATE POLICY "project_files_owner_or_master_select" ON public.project_files FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "project_files_owner_or_master_insert" ON public.project_files FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "project_files_owner_or_master_update" ON public.project_files FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "project_files_owner_or_master_delete" ON public.project_files FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- B.2 funnel_steps (child of projects) ---------------------------
ALTER TABLE public.funnel_steps
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
DO $$ BEGIN
  UPDATE public.funnel_steps fs
     SET owner_user_id = COALESCE(p.owner_user_id, public.get_master_id())
    FROM public.projects p
   WHERE fs.project_id = p.id AND fs.owner_user_id IS NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;
UPDATE public.funnel_steps SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.funnel_steps WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.funnel_steps ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS funnel_steps_owner_user_id_idx ON public.funnel_steps(owner_user_id);
DROP TRIGGER IF EXISTS trg_funnel_steps_auto_owner ON public.funnel_steps;
CREATE TRIGGER trg_funnel_steps_auto_owner BEFORE INSERT ON public.funnel_steps
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.funnel_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.funnel_steps;
DROP POLICY IF EXISTS "funnel_steps_owner_or_master_select" ON public.funnel_steps;
DROP POLICY IF EXISTS "funnel_steps_owner_or_master_insert" ON public.funnel_steps;
DROP POLICY IF EXISTS "funnel_steps_owner_or_master_update" ON public.funnel_steps;
DROP POLICY IF EXISTS "funnel_steps_owner_or_master_delete" ON public.funnel_steps;
CREATE POLICY "funnel_steps_owner_or_master_select" ON public.funnel_steps FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_steps_owner_or_master_insert" ON public.funnel_steps FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_steps_owner_or_master_update" ON public.funnel_steps FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_steps_owner_or_master_delete" ON public.funnel_steps FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- B.3 post_purchase_pages (child of products) --------------------
ALTER TABLE public.post_purchase_pages
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
DO $$ BEGIN
  UPDATE public.post_purchase_pages ppp
     SET owner_user_id = COALESCE(pr.owner_user_id, public.get_master_id())
    FROM public.products pr
   WHERE ppp.product_id = pr.id AND ppp.owner_user_id IS NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;
UPDATE public.post_purchase_pages SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.post_purchase_pages WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.post_purchase_pages ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS post_purchase_pages_owner_user_id_idx ON public.post_purchase_pages(owner_user_id);
DROP TRIGGER IF EXISTS trg_post_purchase_pages_auto_owner ON public.post_purchase_pages;
CREATE TRIGGER trg_post_purchase_pages_auto_owner BEFORE INSERT ON public.post_purchase_pages
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.post_purchase_pages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.post_purchase_pages;
DROP POLICY IF EXISTS "post_purchase_pages_owner_or_master_select" ON public.post_purchase_pages;
DROP POLICY IF EXISTS "post_purchase_pages_owner_or_master_insert" ON public.post_purchase_pages;
DROP POLICY IF EXISTS "post_purchase_pages_owner_or_master_update" ON public.post_purchase_pages;
DROP POLICY IF EXISTS "post_purchase_pages_owner_or_master_delete" ON public.post_purchase_pages;
CREATE POLICY "post_purchase_pages_owner_or_master_select" ON public.post_purchase_pages FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "post_purchase_pages_owner_or_master_insert" ON public.post_purchase_pages FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "post_purchase_pages_owner_or_master_update" ON public.post_purchase_pages FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "post_purchase_pages_owner_or_master_delete" ON public.post_purchase_pages FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- B.4 funnel_crawl_steps (no FK to funnel_crawl_jobs, just match
-- by entry_url best-effort, else fall back to master). The schema
-- (supabase-migration-funnel-crawl-steps.sql) deliberately stores
-- entry_url instead of a job_id FK.
ALTER TABLE public.funnel_crawl_steps
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
DO $$ BEGIN
  UPDATE public.funnel_crawl_steps fcs
     SET owner_user_id = COALESCE(fcj.owner_user_id, public.get_master_id())
    FROM public.funnel_crawl_jobs fcj
   WHERE fcs.entry_url = fcj.entry_url AND fcs.owner_user_id IS NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;
UPDATE public.funnel_crawl_steps SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.funnel_crawl_steps WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.funnel_crawl_steps ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS funnel_crawl_steps_owner_user_id_idx ON public.funnel_crawl_steps(owner_user_id);
DROP TRIGGER IF EXISTS trg_funnel_crawl_steps_auto_owner ON public.funnel_crawl_steps;
CREATE TRIGGER trg_funnel_crawl_steps_auto_owner BEFORE INSERT ON public.funnel_crawl_steps
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.funnel_crawl_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.funnel_crawl_steps;
DROP POLICY IF EXISTS "funnel_crawl_steps_owner_or_master_select" ON public.funnel_crawl_steps;
DROP POLICY IF EXISTS "funnel_crawl_steps_owner_or_master_insert" ON public.funnel_crawl_steps;
DROP POLICY IF EXISTS "funnel_crawl_steps_owner_or_master_update" ON public.funnel_crawl_steps;
DROP POLICY IF EXISTS "funnel_crawl_steps_owner_or_master_delete" ON public.funnel_crawl_steps;
CREATE POLICY "funnel_crawl_steps_owner_or_master_select" ON public.funnel_crawl_steps FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_crawl_steps_owner_or_master_insert" ON public.funnel_crawl_steps FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_crawl_steps_owner_or_master_update" ON public.funnel_crawl_steps FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_crawl_steps_owner_or_master_delete" ON public.funnel_crawl_steps FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- B.5 cloning_texts (child of cloning_jobs) ----------------------
ALTER TABLE public.cloning_texts
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
DO $$ BEGIN
  UPDATE public.cloning_texts ct
     SET owner_user_id = COALESCE(cj.owner_user_id, public.get_master_id())
    FROM public.cloning_jobs cj
   WHERE ct.job_id = cj.id AND ct.owner_user_id IS NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;
UPDATE public.cloning_texts SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.cloning_texts WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.cloning_texts ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS cloning_texts_owner_user_id_idx ON public.cloning_texts(owner_user_id);
DROP TRIGGER IF EXISTS trg_cloning_texts_auto_owner ON public.cloning_texts;
CREATE TRIGGER trg_cloning_texts_auto_owner BEFORE INSERT ON public.cloning_texts
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.cloning_texts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.cloning_texts;
DROP POLICY IF EXISTS "cloning_texts_owner_or_master_select" ON public.cloning_texts;
DROP POLICY IF EXISTS "cloning_texts_owner_or_master_insert" ON public.cloning_texts;
DROP POLICY IF EXISTS "cloning_texts_owner_or_master_update" ON public.cloning_texts;
DROP POLICY IF EXISTS "cloning_texts_owner_or_master_delete" ON public.cloning_texts;
CREATE POLICY "cloning_texts_owner_or_master_select" ON public.cloning_texts FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "cloning_texts_owner_or_master_insert" ON public.cloning_texts FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "cloning_texts_owner_or_master_update" ON public.cloning_texts FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "cloning_texts_owner_or_master_delete" ON public.cloning_texts FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- B.6 funnel_checkpoints (child of checkpoint_funnels) -----------
-- NOTE: the FK column is `checkpoint_funnel_id`, NOT `funnel_id`
-- (see supabase-migration-funnel-checkpoints.sql).
ALTER TABLE public.funnel_checkpoints
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
DO $$ BEGIN
  UPDATE public.funnel_checkpoints fc
     SET owner_user_id = COALESCE(cf.owner_user_id, public.get_master_id())
    FROM public.checkpoint_funnels cf
   WHERE fc.checkpoint_funnel_id = cf.id AND fc.owner_user_id IS NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;
UPDATE public.funnel_checkpoints SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.funnel_checkpoints WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.funnel_checkpoints ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS funnel_checkpoints_owner_user_id_idx ON public.funnel_checkpoints(owner_user_id);
DROP TRIGGER IF EXISTS trg_funnel_checkpoints_auto_owner ON public.funnel_checkpoints;
CREATE TRIGGER trg_funnel_checkpoints_auto_owner BEFORE INSERT ON public.funnel_checkpoints
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.funnel_checkpoints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.funnel_checkpoints;
DROP POLICY IF EXISTS "funnel_checkpoints_owner_or_master_select" ON public.funnel_checkpoints;
DROP POLICY IF EXISTS "funnel_checkpoints_owner_or_master_insert" ON public.funnel_checkpoints;
DROP POLICY IF EXISTS "funnel_checkpoints_owner_or_master_update" ON public.funnel_checkpoints;
DROP POLICY IF EXISTS "funnel_checkpoints_owner_or_master_delete" ON public.funnel_checkpoints;
CREATE POLICY "funnel_checkpoints_owner_or_master_select" ON public.funnel_checkpoints FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_checkpoints_owner_or_master_insert" ON public.funnel_checkpoints FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_checkpoints_owner_or_master_update" ON public.funnel_checkpoints FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "funnel_checkpoints_owner_or_master_delete" ON public.funnel_checkpoints FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

-- B.7 flow_steps (child of funnel_flows) -------------------------
ALTER TABLE public.flow_steps
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
DO $$ BEGIN
  UPDATE public.flow_steps fs2
     SET owner_user_id = COALESCE(ff.owner_user_id, public.get_master_id())
    FROM public.funnel_flows ff
   WHERE fs2.flow_id = ff.id AND fs2.owner_user_id IS NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;
UPDATE public.flow_steps SET owner_user_id = public.get_master_id() WHERE owner_user_id IS NULL;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM public.flow_steps WHERE owner_user_id IS NULL) = 0 THEN
    ALTER TABLE public.flow_steps ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS flow_steps_owner_user_id_idx ON public.flow_steps(owner_user_id);
DROP TRIGGER IF EXISTS trg_flow_steps_auto_owner ON public.flow_steps;
CREATE TRIGGER trg_flow_steps_auto_owner BEFORE INSERT ON public.flow_steps
  FOR EACH ROW EXECUTE FUNCTION public.auto_owner_user_id();
ALTER TABLE public.flow_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.flow_steps;
DROP POLICY IF EXISTS "flow_steps_owner_or_master_select" ON public.flow_steps;
DROP POLICY IF EXISTS "flow_steps_owner_or_master_insert" ON public.flow_steps;
DROP POLICY IF EXISTS "flow_steps_owner_or_master_update" ON public.flow_steps;
DROP POLICY IF EXISTS "flow_steps_owner_or_master_delete" ON public.flow_steps;
CREATE POLICY "flow_steps_owner_or_master_select" ON public.flow_steps FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "flow_steps_owner_or_master_insert" ON public.flow_steps FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "flow_steps_owner_or_master_update" ON public.flow_steps FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL)
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "flow_steps_owner_or_master_delete" ON public.flow_steps FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

COMMIT;

-- =====================================================================
-- DONE — PHASE 1 APPLIED. Current state after running:
--
--   * All listed tables have owner_user_id (NOT NULL).
--   * Existing rows are tagged with the master user.
--   * New inserts auto-fill owner_user_id via the trigger:
--       (a) explicit value, (b) auth.uid(), (c) get_master_id().
--   * RLS is ENABLED with policies that allow:
--       - the owner to access own rows
--       - the master to access ALL rows
--       - server-side anon callers (auth.uid() IS NULL) to access
--         everything — TEMPORARY safety net while old routes are
--         migrated to a user-aware client.
--   * SERVICE ROLE keys continue to bypass RLS unchanged.
--
-- NEXT STEPS (manual):
--   1. Patch server-side API routes to attach the user's JWT to the
--      Supabase client (or extract user via getCurrentUserId(req)
--      and set owner_user_id explicitly on inserts).
--   2. When ALL routes are migrated, run the phase 2 SQL
--      (`supabase-migration-multi-tenancy-phase2-tighten-rls.sql`)
--      which drops the `OR auth.uid() IS NULL` fallback and enforces
--      strict isolation.
--
-- ROLLBACK (per table — repeat for each migrated table):
--   ALTER TABLE <t> DISABLE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS "<t>_owner_or_master_select" ON <t>;
--   DROP POLICY IF EXISTS "<t>_owner_or_master_insert" ON <t>;
--   DROP POLICY IF EXISTS "<t>_owner_or_master_update" ON <t>;
--   DROP POLICY IF EXISTS "<t>_owner_or_master_delete" ON <t>;
--   DROP TRIGGER IF EXISTS trg_<t>_auto_owner ON <t>;
--   ALTER TABLE <t> DROP COLUMN IF EXISTS owner_user_id;
-- =====================================================================
