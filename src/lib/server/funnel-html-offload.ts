/**
 * Server-side HTML offload for funnel_pages JSONB blobs.
 *
 * Client-side writes already go through persistHtmlBlobs/stripHtmlFromJsonb,
 * but several SERVER writers (OpenClaw actions, the /api/v1 passthrough)
 * historically stored the FULL page HTML inline in cloned_data/swiped_data.
 * A handful of such rows (~2 MB each) is enough to balloon the boot-time
 * `funnel_pages` SELECT to >10 MB, hit the 12s init timeout and lock users
 * out of the app ("Connection Error" right after login).
 *
 * `offloadFunnelBlobHtml` mirrors any html/mobileHtml above the threshold
 * into the `page_html` table (the same source of truth the editor and the
 * boot rehydrate read) and replaces it in the JSONB with the usual pointer
 * shape: htmlUrl + htmlLength + htmlSkipped.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const THRESHOLD = 50 * 1024; // keep parity with the client-side HTML_STORAGE_THRESHOLD

type Blob = Record<string, unknown>;

const KIND_BY_COLUMN: Record<string, string> = {
  cloned_data: 'cloned',
  swiped_data: 'swiped',
  extracted_data: 'extracted',
};

function htmlUrlFor(pageId: string, kind: string, variant: string): string {
  return `/api/funnel-html?pageId=${encodeURIComponent(pageId)}&kind=${kind}&variant=${variant}&v=${Date.now()}`;
}

/** Strip big html/mobileHtml from one blob, mirroring it into page_html.
 *  Returns the slimmed blob (same object shape, pointer fields added). */
export async function offloadFunnelBlobHtml(
  sb: SupabaseClient,
  pageId: string,
  kind: string,
  blob: Blob | null | undefined,
  ownerUserId?: string | null,
): Promise<Blob | null> {
  if (!blob || typeof blob !== 'object') return blob ?? null;
  const out: Blob = { ...blob };

  for (const [field, variant, urlKey] of [
    ['html', 'desktop', 'htmlUrl'],
    ['mobileHtml', 'mobile', 'mobileHtmlUrl'],
  ] as const) {
    const val = typeof out[field] === 'string' ? (out[field] as string) : '';
    if (val.length <= THRESHOLD) continue;

    const { error } = await sb.from('page_html').upsert(
      {
        page_id: pageId,
        kind,
        variant,
        html: val,
        owner_user_id: ownerUserId ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'page_id,kind,variant' },
    );
    if (error) {
      // Mirror failed → keep the inline copy rather than losing the HTML.
      console.warn(`[funnel-html-offload] page_html upsert failed (${pageId}/${kind}/${variant}): ${error.message}`);
      continue;
    }
    out[`${field}Length`] = val.length;
    out[`${field}Skipped`] = true;
    out[urlKey] = htmlUrlFor(pageId, kind, variant);
    delete out[field];
  }
  return out;
}

/** Offload every known blob column of a funnel_pages payload in place.
 *  Call AFTER the row exists (needs the row id for the page_html key). */
export async function offloadFunnelPagePayload(
  sb: SupabaseClient,
  pageId: string,
  payload: Record<string, unknown>,
  ownerUserId?: string | null,
): Promise<Record<string, unknown>> {
  const out = { ...payload };
  for (const [column, kind] of Object.entries(KIND_BY_COLUMN)) {
    if (out[column] && typeof out[column] === 'object') {
      out[column] = await offloadFunnelBlobHtml(sb, pageId, kind, out[column] as Blob, ownerUserId);
    }
  }
  return out;
}
