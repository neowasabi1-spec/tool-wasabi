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
 * Soluzione: salvare l'HTML in una tabella dedicata `page_html` (colonna
 * text) tramite la route server `/api/funnel-html`, che scrive col SERVICE
 * ROLE e quindi bypassa qualsiasi policy RLS. Nel JSONB resta solo una URL
 * (< 200 byte) che punta alla GET della stessa route. Passa il timeout e
 * persiste cross-browser / cross-device senza dipendere da Supabase Storage
 * (niente bucket, niente allowlist MIME, niente policy da configurare).
 *
 * IndexedDB (`html-blob-store.ts`) resta come backup locale: se la rete è
 * momentaneamente irraggiungibile l'edit non si perde comunque sulla
 * macchina dell'utente.
 */

import { injectWasabiTracker, type TrackerStepType } from './wasabi-tracker-inject';

/** Soglia oltre la quale spostiamo l'HTML nella tabella page_html invece di
 *  lasciarlo nel JSONB. Tenuta in linea con `HTML_PERSIST_THRESHOLD` di
 *  supabase-operations.ts (entrambe servono lo stesso scopo). */
export const HTML_STORAGE_THRESHOLD = 50_000;

export type HtmlKind = 'cloned' | 'swiped' | 'extracted';

/** Salva un singolo blob HTML via la route server (service role → tabella
 *  page_html). Ritorna la URL GET da scrivere nel JSONB al posto dell'HTML. */
async function uploadOne(
  pageId: string,
  kind: HtmlKind,
  variant: 'desktop' | 'mobile',
  html: string,
): Promise<string> {
  const res = await fetch('/api/funnel-html', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pageId, kind, variant, html }),
  });

  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      // body non-JSON: tieni lo statusText
    }
    throw new Error(`funnel-html save failed (${res.status}): ${msg}`);
  }

  const data = (await res.json()) as { url?: string };
  if (!data?.url) throw new Error('funnel-html save: risposta senza url');
  return data.url;
}

export interface PersistedHtmlUrls {
  htmlUrl?: string;
  mobileHtmlUrl?: string;
}

/** Opzioni per `persistHtmlToStorage`. Tutto opzionale per compatibilita'
 *  retro: chiamare senza opts continua a funzionare (skip tracker inject). */
export interface PersistHtmlOptions {
  /** project_id del funnel cui questa pagina appartiene. Necessario per
   *  iniettare il tag tracker — se manca, l'HTML viene salvato senza
   *  tracking (fail-safe). */
  funnelId?: string | null;
  /** Tipo di step (PageType / PageType.toString()) per popolare `data-step`
   *  nel tag. Se non passato, l'helper fa auto-detect dall'HTML. */
  stepType?: TrackerStepType | string | null;
  /** Forza skip dell'injection (es. per kind='extracted' o test). Default
   *  false. Quando true l'HTML viene caricato senza tag tracker. */
  skipTrackerInject?: boolean;
}

/** Carica html (e mobileHtml se presente) su Storage. Ritorna gli URL
 *  pubblici da scrivere nel JSONB al posto dei blob.
 *
 *  Side effect intenzionale: se `opts.funnelId` e' passato e l'HTML
 *  non e' "extracted" (raw competitor scrape), inietta automaticamente
 *  il tag `<script>` del Wasabi tracker prima dell'upload. L'inject e'
 *  idempotente (vedi src/lib/wasabi-tracker-inject.ts), quindi save
 *  ripetuti / re-edit dell'AI non duplicano il tag. */
export async function persistHtmlToStorage(
  pageId: string,
  kind: HtmlKind,
  html?: string,
  mobileHtml?: string,
  opts?: PersistHtmlOptions,
): Promise<PersistedHtmlUrls> {
  // Il kind 'extracted' contiene HTML RAW del competitor scrappato — NON
  // dobbiamo iniettare il nostro tracker li' dentro, perche' quell'HTML
  // serve come riferimento di analisi e potrebbe finire mostrato in UI
  // come "originale". Solo cloned/swiped (HTML "nostri") vengono tracciati.
  const shouldInject =
    !opts?.skipTrackerInject &&
    kind !== 'extracted' &&
    Boolean(opts?.funnelId);

  const processedHtml =
    shouldInject && html
      ? injectWasabiTracker(html, {
          funnelId: opts!.funnelId!,
          pageId,
          stepType: opts?.stepType,
        })
      : html;
  const processedMobile =
    shouldInject && mobileHtml
      ? injectWasabiTracker(mobileHtml, {
          funnelId: opts!.funnelId!,
          pageId,
          stepType: opts?.stepType,
        })
      : mobileHtml;

  const out: PersistedHtmlUrls = {};
  if (processedHtml && processedHtml.length > 0) {
    out.htmlUrl = await uploadOne(pageId, kind, 'desktop', processedHtml);
  }
  if (processedMobile && processedMobile.length > 0) {
    out.mobileHtmlUrl = await uploadOne(pageId, kind, 'mobile', processedMobile);
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
