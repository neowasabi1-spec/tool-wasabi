-- Add feedback and prompt columns to funnel_pages
-- Run in Supabase SQL Editor: https://supabase.com/dashboard/project/bsovaojzveayoagshuuy/sql

ALTER TABLE funnel_pages
  ADD COLUMN IF NOT EXISTS feedback TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS prompt TEXT;
