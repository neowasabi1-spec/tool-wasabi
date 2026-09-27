-- Full Jev Creative schema port for tool-wasabi
-- Tables prefixed jev_* except FKs to existing projects(id)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS brand_rules JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tone TEXT DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS positioning TEXT DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS palette TEXT[] DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS logo_rules TEXT DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS logo_path TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS forbidden TEXT[] DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS required_elements TEXT[] DEFAULT '{}';


-- ===== from 0001_init.sql =====

-- jev-facebook-creative: schema iniziale
create extension if not exists vector;
create extension if not exists pgcrypto;

-- Progetto = brand o cliente. Contiene il Brain a livello di brand.
-- projects: using existing Wasabi projects table

create table if not exists jev_products (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  description text default '',
  avatar text default '',
  offer text default '',
  markets text[] default '{EU,US}',
  landing_urls text[] default '{}',
  image_paths text[] default '{}',
  forbidden text[] default '{}',
  required_elements text[] default '{}',
  -- pesi della classifica e regole per il corpus, modificabili per prodotto
  weights jsonb default '{}'::jsonb,
  corpus_rules jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- Fonti: pagine Facebook o domini, catalogate per progetto e collegate ai prodotti.
create table if not exists jev_sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null default 'page' check (kind in ('page','domain')),
  page_id text,
  name text default '',
  url text default '',
  role text not null default 'competitor' check (role in ('own','competitor','adjacent')),
  status text default 'ok',               -- ok | unresolved
  status_note text,
  last_refreshed_at timestamptz,
  created_at timestamptz default now(),
  unique (project_id, page_id)
);

create table if not exists jev_product_sources (
  product_id uuid references jev_products(id) on delete cascade,
  source_id uuid references jev_sources(id) on delete cascade,
  primary key (product_id, source_id)
);

-- Creatività unica (media deduplicato). È l'unità di analisi.
create table if not exists jev_creatives (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  source_id uuid references jev_sources(id) on delete set null,
  product_id uuid references jev_products(id) on delete set null,
  assigned_by text check (assigned_by in ('domain','judge','manual')),
  assign_p real,
  media_type text not null check (media_type in ('text','image','video','carousel')),
  media_hash text not null,
  media_paths text[] default '{}',
  dhashes text[] default '{}',
  bodies text[] default '{}',
  titles text[] default '{}',
  descriptions text[] default '{}',
  captions text[] default '{}',
  languages text[] default '{}',
  countries text[] default '{}',
  first_seen date,
  last_seen date,
  active boolean default true,
  copies int default 1,
  extraction jsonb,
  extraction_status text default 'pending', -- pending | running | done | error | no_media
  extraction_error text,
  description_en text,
  embedding vector(1024),
  ranking jsonb,                             -- punteggi calcolati nel codice
  created_at timestamptz default now(),
  unique (project_id, media_hash)
);
create index on jev_creatives (product_id);

-- Righe grezze della Ad Library, collegate alla creatività.
create table if not exists jev_ads (
  id uuid primary key default gen_random_uuid(),
  library_id text unique not null,
  creative_id uuid references jev_creatives(id) on delete cascade,
  source_id uuid references jev_sources(id) on delete set null,
  page_name text,
  start_date date,
  stop_date date,
  active boolean,
  snapshot_url text,
  raw jsonb,
  created_at timestamptz default now()
);

-- Sezioni dei video: hook / message / visual_format
create table if not exists jev_creative_sections (
  id uuid primary key default gen_random_uuid(),
  creative_id uuid not null references jev_creatives(id) on delete cascade,
  section text not null check (section in ('hook','message','visual_format')),
  start_s real,
  end_s real,
  content jsonb,
  text text,
  embedding vector(1024),
  ranking jsonb,
  unique (creative_id, section)
);

create table if not exists jev_judgments (
  id uuid primary key default gen_random_uuid(),
  target_type text not null,     -- creative | section | concept | output | assign
  target_id uuid not null,
  question_set text not null,
  key text not null,
  value jsonb,
  p real,
  raw jsonb,
  engine text,
  created_at timestamptz default now()
);
create index on jev_judgments (target_type, target_id);

create table if not exists jev_reference_ads (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references jev_products(id) on delete cascade,
  creative_id uuid not null references jev_creatives(id) on delete cascade,
  outcome text not null check (outcome in ('win','loss','unknown','inspiration')),
  outcome_source text not null,  -- own_metrics | longevity | short_lived | adjacent | manual
  weight real default 1,
  unique (product_id, creative_id)
);

create table if not exists jev_playbooks (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references jev_products(id) on delete cascade,
  version int not null,
  content jsonb not null,
  text text not null,
  created_at timestamptz default now()
);

create table if not exists jev_concepts (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references jev_products(id) on delete cascade,
  kind text not null check (kind in ('text','image','video')),
  title text,
  brief text,
  dna jsonb,
  genotype jsonb,
  mutation text,
  source_refs jsonb,             -- [{creative_id, section?}]
  distance jsonb,
  embedding vector(1024),
  status text default 'new',     -- new | pass | review | reject | approved | rejected
  created_at timestamptz default now()
);

create table if not exists jev_outputs (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,     -- da usare nel nome dell'ad (es. JFC-ab12cd34)
  concept_id uuid not null references jev_concepts(id) on delete cascade,
  product_id uuid not null references jev_products(id) on delete cascade,
  kind text not null check (kind in ('text','image','video')),
  language text not null,
  spec jsonb not null,
  result_path text,
  result_description jsonb,
  result_dhash text,
  embedding vector(1024),
  status text default 'draft',   -- draft | awaiting_upload | review | ready | rejected
  created_at timestamptz default now()
);

create table if not exists jev_gate_results (
  id uuid primary key default gen_random_uuid(),
  target_type text not null,     -- concept | output
  target_id uuid not null,
  stage text not null,           -- prompt | output
  decision text not null check (decision in ('pass','review','reject')),
  reasons jsonb default '[]'::jsonb,
  warnings jsonb default '[]'::jsonb,
  distance jsonb,
  reject_kind text,              -- off_brand | copy | weak
  human_override text check (human_override in ('approve','reject')),
  override_reason text,
  created_at timestamptz default now()
);
create index on jev_gate_results (target_type, target_id);

create table if not exists jev_test_groups (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references jev_products(id) on delete cascade,
  name text not null,
  axis text not null,
  budget text,
  notes text,
  created_at timestamptz default now()
);
create table if not exists jev_test_group_outputs (
  test_group_id uuid references jev_test_groups(id) on delete cascade,
  output_id uuid references jev_outputs(id) on delete cascade,
  primary key (test_group_id, output_id)
);

create table if not exists jev_outcomes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references jev_products(id) on delete cascade,
  output_id uuid references jev_outputs(id) on delete set null,
  creative_id uuid references jev_creatives(id) on delete set null,
  external_ad_id text,
  ad_name text,
  spend numeric, impressions numeric, clicks numeric, ctr numeric,
  cpa numeric, roas numeric, hook_rate numeric, purchases numeric,
  date_start date, date_end date,
  source text,                   -- csv | marketing_api
  created_at timestamptz default now(),
  unique (external_ad_id, date_start, date_end)
);

create table if not exists jev_labels (
  id uuid primary key default gen_random_uuid(),
  kind text not null,            -- judgment | distance
  target_id uuid not null,
  value jsonb not null,
  created_at timestamptz default now()
);

create table if not exists jev_usage_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,
  provider text, model text, purpose text,
  input_tokens int, output_tokens int, cost numeric,
  created_at timestamptz default now()
);

create table if not exists jev_settings (
  key text primary key,
  value jsonb not null
);

create table if not exists jev_jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  project_id uuid,
  status text not null default 'queued', -- queued | running | done | error
  progress text,
  result jsonb,
  error text,
  attempts int default 0,
  created_at timestamptz default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index on jev_jobs (status, created_at);

-- Prende il prossimo job in modo atomico
create or replace function claim_jev_job() returns setof jev_jobs language sql as $$
  update jev_jobs set status = 'running', started_at = now(), attempts = attempts + 1
  where id = (
    select id from jev_jobs where status = 'queued' order by created_at
    for update skip locked limit 1
  )
  returning *;
$$;

-- Ads del corpus più simili a un embedding
create or replace function match_reference(p_product uuid, p_embedding vector(1024), p_k int)
returns table (creative_id uuid, outcome text, outcome_source text, similarity real)
language sql stable as $$
  select c.id, r.outcome, r.outcome_source, (1 - (c.embedding <=> p_embedding))::real
  from jev_reference_ads r join jev_creatives c on c.id = r.creative_id
  where r.product_id = p_product and c.embedding is not null
  order by c.embedding <=> p_embedding
  limit p_k;
$$;

-- storage: use existing project-files bucket


-- ===== from 0002_product_modes.sql =====

-- Modalità delle fonti per prodotto + scheda prodotto dettagliata

-- same_product: le fonti promuovono lo stesso identico prodotto che promuoviamo noi
-- same_benefit: le fonti sono altri prodotti con lo stesso beneficio (es. perdita di peso) → va riadattato al nostro
alter table jev_products
  add column if not exists source_mode text not null default 'same_benefit' check (source_mode in ('same_product','same_benefit')),
  add column if not exists benefit text default '',            -- il beneficio condiviso, es. "perdita di peso senza dieta"
  add column if not exists mechanism text default '',          -- come funziona il NOSTRO prodotto
  add column if not exists features text default '',           -- ingredienti, componenti, caratteristiche
  add column if not exists proof text default '',              -- prove disponibili: studi, recensioni, numeri, garanzie
  add column if not exists differentiators text default '',    -- perché è diverso dagli altri prodotti con lo stesso beneficio
  add column if not exists guarantee text default '',
  add column if not exists product_sheet text default '';      -- spiegazione libera e dettagliata (anche testo incollato dalla landing)

-- Cosa è stato sostituito nel passaggio da un prodotto sorgente al nostro
alter table jev_concepts add column if not exists adaptation text;

-- Prodotto effettivamente pubblicizzato dall'ad sorgente (utile in modalità same_benefit)
alter table jev_creatives add column if not exists advertised_product text;


-- ===== from 0003_public_library.sql =====

-- Raccolta dalla Ad Library pubblica (ordinata per impression) + classifica per impression

alter table jev_ads
  add column if not exists impression_rank int,        -- 1 = più impression tra le jev_ads della pagina
  add column if not exists impression_total int,       -- quante jev_ads c'erano nella classifica
  add column if not exists video_duration_s real,
  add column if not exists eu_transparency boolean default false,
  add column if not exists multi_version boolean default false,
  add column if not exists shared_copies int default 1; -- "Inserzioni che usano questa creatività e questo testo"

alter table jev_creatives
  add column if not exists impression_rank int,        -- miglior posizione tra le jev_ads che la usano
  add column if not exists impression_pct real,        -- 0 = in cima alla classifica, 1 = in fondo
  add column if not exists ctas text[] default '{}',
  add column if not exists poster_path text;           -- fotogramma del video (per somiglianza visiva)

alter table jev_sources add column if not exists last_total_label text;


-- ===== from 0004_retries.sql =====

-- Nuovi tentativi dei lavori con attesa (errori temporanei: 429, 5xx, timeout)
alter table jev_jobs add column if not exists run_after timestamptz;

create or replace function claim_jev_job() returns setof jev_jobs language sql as $$
  update jev_jobs set status = 'running', started_at = now(), attempts = attempts + 1
  where id = (
    select id from jev_jobs
    where status = 'queued' and (run_after is null or run_after <= now())
    order by created_at
    for update skip locked limit 1
  )
  returning *;
$$;


-- ===== from 0005_rls.sql =====

-- Row Level Security su tutte le tabelle, senza policy:
-- la chiave pubblica (anon) non può leggere né scrivere nulla via REST;
-- l'app e il worker usano la service role key, che ignora RLS.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;


-- ===== from 0006_output_quality.sql =====

-- Punteggio di qualità degli output e storia dei giri di miglioramento
alter table jev_outputs add column if not exists quality jsonb;


-- ===== from 0007_visual_features.sql =====

-- Scheda di caratteristiche visive (descrizione neutra di Gemini, votata da Jev) e scheda prodotto in inglese per Jev
alter table jev_creatives add column if not exists visual_features jsonb;
alter table jev_outputs add column if not exists visual_features jsonb;
alter table jev_products
  add column if not exists sheet_en text,
  add column if not exists sheet_en_hash text;


-- ===== from 0008_style_clusters.sql =====

-- Famiglie di stile per somiglianza visiva (embedding multimodale dell'immagine) invece che per una sola etichetta
alter table jev_creatives
  add column if not exists image_embedding vector(1024),
  add column if not exists style_family text;


-- ===== from 0009_batches.sql =====

-- Lotti di generazione: data, tipo e parametri di ogni generazione, per raggruppare e monitorare gli output
create table if not exists jev_batches (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references jev_products(id) on delete cascade,
  kind text not null,          -- auto | family | hooks | manual | legacy
  label text not null,
  params jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists batches_product_idx on jev_batches (product_id, created_at desc);
alter table jev_batches enable row level security;

alter table jev_concepts add column if not exists batch_id uuid references jev_batches(id) on delete set null;
alter table jev_outputs add column if not exists batch_id uuid references jev_batches(id) on delete set null;

-- Output già esistenti: un lotto per ogni ora di generazione, così lo storico resta raggruppato
do $$
declare r record; b uuid;
begin
  for r in
    select product_id, date_trunc('hour', created_at) h from jev_outputs where batch_id is null group by 1, 2
  loop
    insert into jev_batches (product_id, kind, label, created_at)
    values (r.product_id, 'legacy', 'Generazioni precedenti', r.h) returning id into b;
    update jev_outputs set batch_id = b where product_id = r.product_id and date_trunc('hour', created_at) = r.h and batch_id is null;
    update jev_concepts c set batch_id = b from jev_outputs o where o.concept_id = c.id and o.batch_id = b and c.batch_id is null;
  end loop;
end $$;


-- Claim job RPC for jev_jobs
CREATE OR REPLACE FUNCTION claim_jev_job()
RETURNS SETOF jev_jobs
LANGUAGE sql
AS $$
  UPDATE jev_jobs j
  SET status = 'running', started_at = now(), attempts = attempts + 1
  WHERE j.id = (
    SELECT id FROM jev_jobs
    WHERE status = 'queued' AND coalesce(run_after, now()) <= now()
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
$$;


-- ===== from 0010_templates.sql (graphic templates for auto image creatives) =====
-- Scheda riproducibile di UNA ad di riferimento; si genera dentro un template alla volta.
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
