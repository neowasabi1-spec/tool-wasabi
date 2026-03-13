-- =====================================================
-- FUNNEL SWIPER DASHBOARD - SUPABASE SCHEMA
-- =====================================================
-- Esegui questo SQL nella console SQL di Supabase:
-- https://supabase.com/dashboard/project/bsovaojzveayoagshuuy/sql
-- =====================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- PRODUCTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  image_url TEXT,
  benefits TEXT[] NOT NULL DEFAULT '{}',
  cta_text TEXT NOT NULL DEFAULT 'Acquista Ora',
  cta_url TEXT NOT NULL DEFAULT '',
  brand_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for faster queries
CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at DESC);

-- =====================================================
-- SWIPE TEMPLATES TABLE
-- =====================================================
CREATE TYPE page_type AS ENUM (
  '5_reasons_listicle',
  'quiz_funnel',
  'landing',
  'product_page',
  'safe_page',
  'checkout',
  'advertorial',
  'altro'
);

CREATE TABLE IF NOT EXISTS swipe_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  page_type page_type NOT NULL DEFAULT 'landing',
  tags TEXT[] NOT NULL DEFAULT '{}',
  description TEXT,
  preview_image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for faster queries
CREATE INDEX IF NOT EXISTS idx_swipe_templates_page_type ON swipe_templates(page_type);
CREATE INDEX IF NOT EXISTS idx_swipe_templates_created_at ON swipe_templates(created_at DESC);

-- =====================================================
-- FUNNEL PAGES TABLE
-- =====================================================
CREATE TYPE swipe_status AS ENUM (
  'pending',
  'in_progress',
  'completed',
  'failed'
);

CREATE TABLE IF NOT EXISTS funnel_pages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  page_type page_type NOT NULL DEFAULT 'landing',
  template_id UUID REFERENCES swipe_templates(id) ON DELETE SET NULL,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url_to_swipe TEXT NOT NULL DEFAULT '',
  prompt TEXT,
  swipe_status swipe_status NOT NULL DEFAULT 'pending',
  swipe_result TEXT,
  feedback TEXT DEFAULT '',
  cloned_data JSONB,
  swiped_data JSONB,
  analysis_status swipe_status,
  analysis_result TEXT,
  extracted_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_funnel_pages_product_id ON funnel_pages(product_id);
CREATE INDEX IF NOT EXISTS idx_funnel_pages_template_id ON funnel_pages(template_id);
CREATE INDEX IF NOT EXISTS idx_funnel_pages_swipe_status ON funnel_pages(swipe_status);
CREATE INDEX IF NOT EXISTS idx_funnel_pages_created_at ON funnel_pages(created_at DESC);

-- =====================================================
-- POST PURCHASE PAGES TABLE
-- =====================================================
CREATE TYPE post_purchase_type AS ENUM (
  'thank_you',
  'upsell_1',
  'upsell_2',
  'downsell',
  'order_confirmation'
);

CREATE TABLE IF NOT EXISTS post_purchase_pages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  type post_purchase_type NOT NULL DEFAULT 'thank_you',
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url_to_swipe TEXT NOT NULL DEFAULT '',
  swipe_status swipe_status NOT NULL DEFAULT 'pending',
  swipe_result TEXT,
  cloned_data JSONB,
  swiped_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_post_purchase_pages_product_id ON post_purchase_pages(product_id);
CREATE INDEX IF NOT EXISTS idx_post_purchase_pages_type ON post_purchase_pages(type);
CREATE INDEX IF NOT EXISTS idx_post_purchase_pages_created_at ON post_purchase_pages(created_at DESC);

-- =====================================================
-- FUNNEL CRAWL STEPS TABLE (Funnel Analyzer - step salvati)
-- =====================================================
CREATE TABLE IF NOT EXISTS funnel_crawl_steps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  funnel_name TEXT NOT NULL DEFAULT '',
  funnel_tag TEXT,
  entry_url TEXT NOT NULL,
  step_index INT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  step_data JSONB NOT NULL DEFAULT '{}',
  screenshot_base64 TEXT,
  vision_analysis JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funnel_crawl_steps_entry_url ON funnel_crawl_steps(entry_url);
CREATE INDEX IF NOT EXISTS idx_funnel_crawl_steps_funnel_name ON funnel_crawl_steps(funnel_name);
CREATE INDEX IF NOT EXISTS idx_funnel_crawl_steps_funnel_tag ON funnel_crawl_steps(funnel_tag);
CREATE INDEX IF NOT EXISTS idx_funnel_crawl_steps_created_at ON funnel_crawl_steps(created_at DESC);

ALTER TABLE funnel_crawl_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations on funnel_crawl_steps" ON funnel_crawl_steps FOR ALL USING (true) WITH CHECK (true);

-- =====================================================
-- UPDATED_AT TRIGGER FUNCTION
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to all tables
DROP TRIGGER IF EXISTS update_products_updated_at ON products;
CREATE TRIGGER update_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_swipe_templates_updated_at ON swipe_templates;
CREATE TRIGGER update_swipe_templates_updated_at
  BEFORE UPDATE ON swipe_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_funnel_pages_updated_at ON funnel_pages;
CREATE TRIGGER update_funnel_pages_updated_at
  BEFORE UPDATE ON funnel_pages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_post_purchase_pages_updated_at ON post_purchase_pages;
CREATE TRIGGER update_post_purchase_pages_updated_at
  BEFORE UPDATE ON post_purchase_pages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================
-- Enable RLS on all tables (currently allowing all operations)
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE swipe_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE funnel_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_purchase_pages ENABLE ROW LEVEL SECURITY;

-- Create policies for anonymous access (using anon key)
-- NOTE: In production, you should restrict these policies
CREATE POLICY "Allow all operations on products" ON products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on swipe_templates" ON swipe_templates FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on funnel_pages" ON funnel_pages FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on post_purchase_pages" ON post_purchase_pages FOR ALL USING (true) WITH CHECK (true);

-- =====================================================
-- SAMPLE DATA (Optional - remove in production)
-- =====================================================
-- Insert sample product
INSERT INTO products (name, description, price, benefits, cta_text, cta_url, brand_name)
VALUES (
  'Prodotto Demo 1',
  'Integratore naturale per il benessere quotidiano',
  47.00,
  ARRAY['Aumenta l''energia', 'Migliora il sonno', 'Supporta il sistema immunitario'],
  'Acquista Ora',
  'https://example.com/buy',
  'NaturalWell'
) ON CONFLICT DO NOTHING;

-- Insert sample template
INSERT INTO swipe_templates (name, source_url, page_type, tags, description)
VALUES (
  'Multicooker Landing',
  'https://mister-discount.com/index.php/multicooker-ptmic/',
  'landing',
  ARRAY['nutra', 'physical-product', 'advertorial'],
  'Landing page stile advertorial per prodotti fisici'
) ON CONFLICT DO NOTHING;

-- =====================================================
-- SAVED PROMPTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS saved_prompts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  tags TEXT[] NOT NULL DEFAULT '{}',
  is_favorite BOOLEAN NOT NULL DEFAULT false,
  use_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_prompts_category ON saved_prompts(category);
CREATE INDEX IF NOT EXISTS idx_saved_prompts_is_favorite ON saved_prompts(is_favorite);
CREATE INDEX IF NOT EXISTS idx_saved_prompts_created_at ON saved_prompts(created_at DESC);

ALTER TABLE saved_prompts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations on saved_prompts" ON saved_prompts FOR ALL USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS update_saved_prompts_updated_at ON saved_prompts;
CREATE TRIGGER update_saved_prompts_updated_at
  BEFORE UPDATE ON saved_prompts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- VERIFICATION QUERY
-- =====================================================
-- Run this to verify tables were created:
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
