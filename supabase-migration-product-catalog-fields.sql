-- Migration: Add catalog-related fields to products table
-- Run this in the Supabase SQL Editor before using the Catalog Import feature

ALTER TABLE products ADD COLUMN IF NOT EXISTS sku text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS characteristics text[] DEFAULT '{}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS geo_market text;

CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);
