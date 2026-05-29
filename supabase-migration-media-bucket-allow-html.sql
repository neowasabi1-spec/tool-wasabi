-- =====================================================================
-- Sblocca il bucket Storage "media" per l'HTML delle funnel page.
-- =====================================================================
-- Sintomo: dopo aver editato e salvato una pagina nel VisualHtmlEditor,
-- al reload l'HTML torna alla versione precedente / non si vede.
--
-- Causa: l'editor salva l'HTML su Storage (path funnel-html/<pageId>/...)
-- come `text/html`. Se il bucket "media" ha una allowlist `allowed_mime_types`
-- che non include text/html, l'upload viene RIFIUTATO e la copia "ufficiale"
-- (cross-device) non viene mai scritta.
--
-- Questo script:
--   1) rende il bucket pubblico (serve per la rehydrate via getPublicUrl)
--   2) rimuove la restrizione MIME (consente qualsiasi content-type)
--
-- Eseguire nel SQL editor di Supabase. Idempotente.
-- =====================================================================

update storage.buckets
set
  public = true,
  allowed_mime_types = null   -- null = nessuna restrizione (accetta text/html)
where id = 'media';

-- Verifica (facoltativa):
-- select id, public, allowed_mime_types from storage.buckets where id = 'media';
