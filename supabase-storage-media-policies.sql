-- =====================================================================
-- Policy RLS per consentire l'upload BROWSER (anon) dell'HTML funnel
-- nel bucket Storage "media" (prefisso funnel-html/).
-- =====================================================================
-- Da eseguire SOLO se, dopo aver reso il bucket pubblico + tolto la
-- restrizione MIME, il salvataggio dell'HTML resta "solo locale" e il
-- banner mostra un errore tipo "new row violates row-level security
-- policy" / "not authorized".
--
-- L'editor carica l'HTML da browser con la chiave anon, quindi servono
-- policy su storage.objects che permettano INSERT/UPDATE/SELECT al ruolo
-- anon sugli oggetti del bucket "media". Le policy qui sotto sono limitate
-- al bucket "media".
--
-- Idempotente: droppa e ricrea.
-- =====================================================================

-- INSERT (upload nuovi file)
drop policy if exists "media anon insert" on storage.objects;
create policy "media anon insert"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'media');

-- UPDATE (upsert: sovrascrive file esistenti, es. re-save dell'editor)
drop policy if exists "media anon update" on storage.objects;
create policy "media anon update"
  on storage.objects for update
  to anon, authenticated
  using (bucket_id = 'media')
  with check (bucket_id = 'media');

-- SELECT (lettura/rehydrate; per i bucket pubblici la GET passa comunque,
-- ma serve per le API che listano gli oggetti)
drop policy if exists "media anon select" on storage.objects;
create policy "media anon select"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'media');

-- Verifica:
-- select * from pg_policies where tablename = 'objects' and schemaname = 'storage';
