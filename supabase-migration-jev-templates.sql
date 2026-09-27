-- Graphic templates for Jev auto image creatives (port of jev 0010_templates).
-- Safe to run on DBs that already applied supabase-migration-jev-full-port.sql.

create table if not exists jev_templates (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references jev_products(id) on delete cascade,
  creative_id uuid not null references jev_creatives(id) on delete cascade,
  spec jsonb not null,
  signature text,
  embedding vector(1024),
  group_key text,
  label text,
  created_at timestamptz default now(),
  unique (product_id, creative_id)
);
create index if not exists jev_templates_product_idx on jev_templates (product_id, group_key);
alter table jev_templates enable row level security;

alter table jev_outputs add column if not exists template_id uuid references jev_templates(id) on delete set null;
