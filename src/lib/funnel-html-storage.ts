'use client';

/**
 * Persistenza dell'HTML delle funnel pages su Supabase Storage.
 *
 * Perché esiste:
 * - `cloned_data` / `swiped_data` / `extracted_data` sono colonne JSONB e
 *   l'app storicamente ci buttava dentro l'HTML rendered (1-5 MB su
 *   Funnelish/ClickFunnels SPA snapshots).
 * - Postgres `statement_timeout` per il role `anon` è 3 s. Un UPDATE sul
 *   TOAST chain di JSONB grossi sfora e si becca `57014 statement timeout`.
 * - `supabase-operations.stripHtmlFromJsonb` toglie l'HTML dal payload
 *   prima del save → l'HTML resta SOLO nello state Zustand in memoria →
 *   al refresh della tab si perde, e le edit fatte dal VisualHtmlEditor
 *   tornano alla versione pre-edit (o spariscono del tutto).
 *
 * Soluzione: caricare l'HTML come file `.html` nel bucket Storage `media`
 * (path `funnel-html/{pageId}/{kind}.html`) PRIMA dello strip, e mettere
 * nel JSONB solo l'URL pubblico. È piccolo (< 200 byte), passa il timeout,
 * e persiste cross-browser / cross-device.
 *
 * IndexedDB (`html-blob-store.ts`) resta come backup locale: se Storage
 * è momentaneamente irraggiungibile (rete, RLS, ecc.) l'edit non si perde
 * comunque sulla macchina dell'utente.
 */

import { getSupabaseBrowser } from './supabase-browser';

const BUCKET = 'media';

/** Soglia oltre la quale spostiamo l'HTML su Storage invece di lasciarlo
 *  nel JSONB. Tenuta in linea con `HTML_PERSIST_THRESHOLD` di
 *  supabase-operations.ts (entrambe servono lo stesso scopo). */
export const HTML_STORAGE_THRESHOLD = 50_000;

export type HtmlKind = 'cloned' | 'swiped' | 'extracted';

function pathFor(pageId: string, kind: HtmlKind, variant: 'desktop' | 'mobile'): string {
  return `funnel-html/${pageId}/${kind}-${variant}.html`;
}

async function uploadOne(pageId: string, kind: HtmlKind, variant: 'desktop' | 'mobile', html: string): Promise<string> {
  const sb = getSupabaseBrowser();
  if (!sb) throw new Error('Supabase browser client not configured');

  const path = pathFor(pageId, kind, variant);
  const blob = new Blob([html], { type: 'text/html; charset=utf-8' });

  const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
    contentType: 'text/html; charset=utf-8',
    upsert: true,
    // niente cache-control: vogliamo sempre la versione più fresca al boot
    cacheControl: '0',
  });
  if (error) {
    if (error.message?.includes('Bucket not found')) {
      throw new Error(`Storage bucket "${BUCKET}" not found. Create it in Supabase → Storage and make it public.`);
    }
    throw new Error(error.message);
  }

  const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
  // Cache-buster: forziamo i client a rifare GET dopo ogni save anche se
  // un CDN intermedio cachasse comunque.
  return `${data.publicUrl}?v=${Date.now()}`;
}

export interface PersistedHtmlUrls {
  htmlUrl?: string;
  mobileHtmlUrl?: string;
}

/** Carica html (e mobileHtml se presente) su Storage. Ritorna gli URL
 *  pubblici da scrivere nel JSONB al posto dei blob. */
export async function persistHtmlToStorage(
  pageId: string,
  kind: HtmlKind,
  html?: string,
  mobileHtml?: string,
): Promise<PersistedHtmlUrls> {
  const out: PersistedHtmlUrls = {};
  if (html && html.length > 0) {
    out.htmlUrl = await uploadOne(pageId, kind, 'desktop', html);
  }
  if (mobileHtml && mobileHtml.length > 0) {
    out.mobileHtmlUrl = await uploadOne(pageId, kind, 'mobile', mobileHtml);
  }
  return out;
}

/** Scarica l'HTML salvato in Storage. Usato dalla rehydrate logic al boot
 *  quando il JSONB ha solo `htmlUrl` (e non `html`). */
export async function fetchHtmlFromStorage(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.text();
  } catch (err) {
    console.warn('[funnel-html-storage] fetchHtmlFromStorage failed:', err);
    return null;
  }
}
