-- =====================================================
-- MIGRATION: Extend page_type enum to match app values
-- =====================================================
-- Problem: the original enum only allowed 8 values, but the app's
-- BuiltInPageType union (src/types/index.ts) declares 32+ values. Any insert
-- on funnel_pages with a value outside the 8 (e.g. 'vsl', 'opt_in', 'thank_you',
-- 'upsell', etc.) fails with Postgres error 22P02:
--   invalid input value for enum page_type: "vsl"
--
-- Until this migration is applied, the runtime fallback in
-- src/lib/supabase-operations.ts (sanitizePageTypeForDb) maps unknown values
-- to one of the 8 originals. Once this migration is applied, the fallback
-- becomes a no-op for the new values.
--
-- Run this in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/<your-project>/sql
-- =====================================================

-- Pre-sell / top of funnel
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'listicle';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'native_ad';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'vsl';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'webinar';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'bridge_page';

-- Landing & opt-in
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'opt_in';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'squeeze_page';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'lead_magnet';

-- Quiz family
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'survey';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'assessment';

-- Sales pages
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'sales_letter';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'offer_page';

-- Post-purchase
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'thank_you';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'upsell';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'downsell';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'oto';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'order_confirmation';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'membership';

-- Content pages
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'blog';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'article';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'content_page';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'review';

-- Compliance & safe
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'privacy';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'terms';
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'disclaimer';

-- Generic fallback used by the app (kept alongside legacy 'altro')
ALTER TYPE page_type ADD VALUE IF NOT EXISTS 'other';
