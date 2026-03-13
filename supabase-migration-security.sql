-- =====================================================
-- SOC 2 SECURITY MIGRATION
-- =====================================================
-- Run in Supabase SQL editor AFTER enabling Supabase Auth.
-- Safe to run multiple times (all statements are idempotent).
-- Tables that don't exist yet are silently skipped.
-- =====================================================

-- Enable UUID extension (if not already)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- 1. AUDIT LOGS TABLE (SOC 2 Security & Availability)
-- =====================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  actor_id UUID,
  actor_ip TEXT,
  resource_type TEXT,
  resource_id TEXT,
  action TEXT NOT NULL,
  details JSONB DEFAULT '{}',
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_severity ON audit_logs(severity);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'audit_logs' AND policyname = 'Service role inserts audit logs') THEN
    CREATE POLICY "Service role inserts audit logs" ON audit_logs FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'audit_logs' AND policyname = 'Users read own audit logs') THEN
    CREATE POLICY "Users read own audit logs" ON audit_logs FOR SELECT USING (actor_id = auth.uid() OR auth.role() = 'service_role');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'audit_logs' AND policyname = 'No updates on audit logs') THEN
    CREATE POLICY "No updates on audit logs" ON audit_logs FOR UPDATE USING (false);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'audit_logs' AND policyname = 'No deletes on audit logs') THEN
    CREATE POLICY "No deletes on audit logs" ON audit_logs FOR DELETE USING (false);
  END IF;
END $$;


-- =====================================================
-- 2. ADD user_id TO EXISTING TABLES (Multi-tenancy)
-- =====================================================
-- Each block checks that the TABLE exists AND the column
-- doesn't exist yet before altering. Safe if table is missing.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'products')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'user_id')
  THEN
    ALTER TABLE products ADD COLUMN user_id UUID REFERENCES auth.users(id);
    CREATE INDEX IF NOT EXISTS idx_products_user_id ON products(user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'swipe_templates')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'swipe_templates' AND column_name = 'user_id')
  THEN
    ALTER TABLE swipe_templates ADD COLUMN user_id UUID REFERENCES auth.users(id);
    CREATE INDEX IF NOT EXISTS idx_swipe_templates_user_id ON swipe_templates(user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'funnel_pages')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'funnel_pages' AND column_name = 'user_id')
  THEN
    ALTER TABLE funnel_pages ADD COLUMN user_id UUID REFERENCES auth.users(id);
    CREATE INDEX IF NOT EXISTS idx_funnel_pages_user_id ON funnel_pages(user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'post_purchase_pages')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'post_purchase_pages' AND column_name = 'user_id')
  THEN
    ALTER TABLE post_purchase_pages ADD COLUMN user_id UUID REFERENCES auth.users(id);
    CREATE INDEX IF NOT EXISTS idx_post_purchase_pages_user_id ON post_purchase_pages(user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'saved_prompts')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'saved_prompts' AND column_name = 'user_id')
  THEN
    ALTER TABLE saved_prompts ADD COLUMN user_id UUID REFERENCES auth.users(id);
    CREATE INDEX IF NOT EXISTS idx_saved_prompts_user_id ON saved_prompts(user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'funnel_crawl_steps')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'funnel_crawl_steps' AND column_name = 'user_id')
  THEN
    ALTER TABLE funnel_crawl_steps ADD COLUMN user_id UUID REFERENCES auth.users(id);
    CREATE INDEX IF NOT EXISTS idx_funnel_crawl_steps_user_id ON funnel_crawl_steps(user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'affiliate_browser_chats')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'affiliate_browser_chats' AND column_name = 'user_id')
  THEN
    ALTER TABLE affiliate_browser_chats ADD COLUMN user_id UUID REFERENCES auth.users(id);
    CREATE INDEX IF NOT EXISTS idx_affiliate_browser_chats_user_id ON affiliate_browser_chats(user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'affiliate_saved_funnels')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'affiliate_saved_funnels' AND column_name = 'user_id')
  THEN
    ALTER TABLE affiliate_saved_funnels ADD COLUMN user_id UUID REFERENCES auth.users(id);
    CREATE INDEX IF NOT EXISTS idx_affiliate_saved_funnels_user_id ON affiliate_saved_funnels(user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'scheduled_browser_jobs')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'scheduled_browser_jobs' AND column_name = 'user_id')
  THEN
    ALTER TABLE scheduled_browser_jobs ADD COLUMN user_id UUID REFERENCES auth.users(id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_browser_jobs_user_id ON scheduled_browser_jobs(user_id);
  END IF;
END $$;


-- =====================================================
-- 3. TIGHTEN RLS POLICIES (SOC 2 Confidentiality)
-- =====================================================
-- For each table: drop the old "allow all" policy (if exists)
-- and create an auth-scoped one. Skips tables that don't exist.

-- Helper: reusable function for RLS policy migration
CREATE OR REPLACE FUNCTION _migrate_rls_policy(
  p_table TEXT,
  p_old_policy TEXT,
  p_new_policy TEXT
) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = p_table) THEN
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);

  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = p_table AND policyname = p_old_policy) THEN
    EXECUTE format('DROP POLICY %I ON %I', p_old_policy, p_table);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = p_table AND policyname = p_new_policy) THEN
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (auth.role() = ''service_role'' OR user_id = auth.uid() OR user_id IS NULL) WITH CHECK (auth.role() = ''service_role'' OR user_id = auth.uid() OR user_id IS NULL)',
      p_new_policy, p_table
    );
  END IF;
END;
$$ LANGUAGE plpgsql;

SELECT _migrate_rls_policy('products',              'Allow all operations on products',              'Authenticated users manage own products');
SELECT _migrate_rls_policy('swipe_templates',        'Allow all operations on swipe_templates',        'Authenticated users manage own templates');
SELECT _migrate_rls_policy('funnel_pages',           'Allow all operations on funnel_pages',           'Authenticated users manage own funnel pages');
SELECT _migrate_rls_policy('post_purchase_pages',    'Allow all operations on post_purchase_pages',    'Authenticated users manage own post purchase pages');
SELECT _migrate_rls_policy('saved_prompts',          'Allow all operations on saved_prompts',          'Authenticated users manage own saved prompts');
SELECT _migrate_rls_policy('funnel_crawl_steps',     'Allow all operations on funnel_crawl_steps',     'Authenticated users manage own crawl steps');
SELECT _migrate_rls_policy('affiliate_browser_chats','Allow all operations on affiliate_browser_chats','Authenticated users manage own browser chats');
SELECT _migrate_rls_policy('affiliate_saved_funnels','Allow all operations on affiliate_saved_funnels','Authenticated users manage own saved funnels');
SELECT _migrate_rls_policy('scheduled_browser_jobs', 'Allow all operations on scheduled_browser_jobs', 'Authenticated users manage own scheduled jobs');

DROP FUNCTION IF EXISTS _migrate_rls_policy;


-- =====================================================
-- 4. DATA RETENTION POLICY (SOC 2 Privacy)
-- =====================================================
-- Auto-delete audit logs older than 2 years.
-- Requires pg_cron (Supabase Pro). Uncomment when ready:
--
-- SELECT cron.schedule(
--   'purge-old-audit-logs',
--   '0 3 * * 0',
--   $$DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '2 years'$$
-- );


-- =====================================================
-- VERIFICATION
-- =====================================================
-- Run this to verify:
-- SELECT table_name, COUNT(*) as policy_count
-- FROM pg_policies WHERE schemaname = 'public'
-- GROUP BY table_name ORDER BY table_name;
