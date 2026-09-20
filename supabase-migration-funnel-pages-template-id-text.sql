-- =====================================================
-- MIGRATION: funnel_pages.template_id as TEXT
-- =====================================================
-- Clone/Swipe template picker stores archive keys of the form
--   arc:<archived_funnel_id>::<urlencoded-url>
-- not swipe_templates UUIDs. The original column was
--   UUID REFERENCES swipe_templates(id)
-- so every pick failed (invalid uuid / FK) and the cell snapped
-- back to "Pick template".
--
-- Drop the FK and widen the column so the choice persists.
-- Legacy UUID values remain valid TEXT.
--
-- Until this runs, the app still keeps the pick in-session and in
-- localStorage (see src/store/useStore.ts) and retries the row
-- write without template_id.
--
-- Run this in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/<your-project>/sql
-- =====================================================

ALTER TABLE funnel_pages
  DROP CONSTRAINT IF EXISTS funnel_pages_template_id_fkey;

ALTER TABLE funnel_pages
  ALTER COLUMN template_id TYPE TEXT USING template_id::text;

COMMENT ON COLUMN funnel_pages.template_id IS
  'Selected Clone/Swipe template: archive key arc:<funnel_id>::<url>, or a legacy swipe_templates UUID.';
