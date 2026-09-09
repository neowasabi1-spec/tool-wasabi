-- =====================================================
-- MIGRATION: funnel_pages.checkout_mode
-- =====================================================
-- Adds the per-step choice between a standard checkout and a WasabiCRM
-- checkout (Whop payments driven by the /js/wasabi-checkout.js runtime,
-- which binds to data-wc-* attributes at page load).
--
-- Only meaningful when page_type is a checkout type; ignored elsewhere.
-- NULL / 'standard' = the behaviour that existed before this column, so
-- every pre-existing row keeps working exactly as it did.
--
-- Until this migration is applied, the app still works: createFunnelPage /
-- updateFunnelPage in src/lib/supabase-operations.ts detect the missing
-- column and retry without it (the choice just doesn't persist across
-- reloads).
--
-- Run this in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/<your-project>/sql
-- =====================================================

ALTER TABLE funnel_pages
  ADD COLUMN IF NOT EXISTS checkout_mode TEXT;

ALTER TABLE funnel_pages
  DROP CONSTRAINT IF EXISTS funnel_pages_checkout_mode_check;

ALTER TABLE funnel_pages
  ADD CONSTRAINT funnel_pages_checkout_mode_check
  CHECK (checkout_mode IS NULL OR checkout_mode IN ('standard', 'wasabi'));

COMMENT ON COLUMN funnel_pages.checkout_mode IS
  'Checkout flavour for checkout-type steps: standard (default) or wasabi (WasabiCRM/Whop). Drives the extra rules injected into every AI rewrite/edit prompt for this page.';
