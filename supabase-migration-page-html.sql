-- Tabella dedicata per l'HTML "pesante" delle funnel pages.
--
-- PERCHE':
--   cloned_data / swiped_data / extracted_data sono colonne JSONB sulla
--   riga (grassa) di funnel_pages. Mettere 1-5 MB di HTML li' dentro fa
--   sforare lo statement_timeout di 3s del role anon (errore 57014), quindi
--   l'app strippa ogni HTML > 50KB prima del save → senza una casa online
--   l'HTML restava SOLO in locale (IndexedDB di quel browser).
--
--   Una tabella stretta con una singola colonna text NON fa scattare il
--   timeout come l'update della riga grassa di funnel_pages. L'accesso
--   avviene esclusivamente via route server con SERVICE ROLE
--   (/api/funnel-html), che bypassa RLS: nessuna policy da configurare.
--
-- Esegui una volta nello SQL editor di Supabase.

create table if not exists public.page_html (
  page_id    text        not null,
  kind       text        not null,                 -- 'cloned' | 'swiped' | 'extracted'
  variant    text        not null default 'desktop', -- 'desktop' | 'mobile'
  html       text        not null,
  updated_at timestamptz not null default now(),
  primary key (page_id, kind, variant)
);

-- RLS attiva: le scritture passano dal service role (che bypassa RLS).
-- La policy di SELECT per anon e' opzionale ma innocua: utile se in futuro
-- si volesse leggere l'HTML direttamente dal client.
alter table public.page_html enable row level security;

drop policy if exists "page_html anon read" on public.page_html;
create policy "page_html anon read"
  on public.page_html
  for select
  to anon, authenticated
  using (true);
