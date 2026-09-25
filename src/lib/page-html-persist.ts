/**
 * Persist cloned/swiped HTML without blowing Postgres statement_timeout.
 *
 * Funnelish/ClickFunnels snapshots are 1–5 MB. Upserting that into
 * page_html.html rewrites TOAST and hits 57014. Large bodies go to the
 * project-files bucket; page_html keeps a tiny pointer. Readers expand it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const PAGE_HTML_BUCKET = 'project-files';
export const PAGE_HTML_MARKER = '@@wasabi-html:';
/** Stay under typical Supabase statement_timeout for a text upsert. */
const INLINE_LIMIT = 120_000;

export function pageHtmlObjectKey(pageId: string, kind: string, variant = 'desktop'): string {
  const safe = String(pageId || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return `page_html/${safe}/${kind}-${variant}.html`;
}

export function isHtmlStoragePointer(html: string): boolean {
  return String(html || '').startsWith(PAGE_HTML_MARKER);
}

export function htmlStoragePath(pointer: string): string {
  return String(pointer || '').slice(PAGE_HTML_MARKER.length).trim();
}

export async function persistPageHtml(
  sb: SupabaseClient,
  args: {
    pageId: string;
    kind: 'cloned' | 'swiped' | 'extracted';
    variant?: 'desktop' | 'mobile';
    html: string;
    ownerUserId?: string | null;
  },
): Promise<void> {
  const pageId = String(args.pageId || '').trim();
  const html = String(args.html || '');
  const kind = args.kind;
  const variant = args.variant || 'desktop';
  if (!pageId || !html) return;

  const key = pageHtmlObjectKey(pageId, kind, variant);
  let stored = html;
  if (html.length > INLINE_LIMIT) {
    await uploadHtmlObject(sb, key, html);
    stored = `${PAGE_HTML_MARKER}${key}`;
  } else {
    // A previous large snapshot lives at this same key. If we leave it,
    // readPageHtml used to return that file and ignore the newer inline row,
    // so the eye reopened the original clone after an edit or translation.
    await sb.storage.from(PAGE_HTML_BUCKET).remove([key]).catch(() => undefined);
  }

  const row: Record<string, unknown> = {
    page_id: pageId,
    kind,
    variant,
    html: stored,
    updated_at: new Date().toISOString(),
  };
  if (args.ownerUserId) row.owner_user_id = args.ownerUserId;

  const { error } = await sb.from('page_html').upsert(row, { onConflict: 'page_id,kind,variant' });
  if (!error) return;
  if (!isTimeout(error.message) || stored === html) {
    throw new Error(`saving ${kind} HTML failed: ${error.message}`);
  }

  // Huge previous TOAST row: drop it, insert the pointer.
  await sb.from('page_html').delete().eq('page_id', pageId).eq('kind', kind).eq('variant', variant);
  const { error: insErr } = await sb.from('page_html').insert(row);
  if (!insErr) return;
  if (isTimeout(insErr.message) || /duplicate|unique|23505/i.test(insErr.message)) {
    console.warn(`[page-html] Postgres timed out; HTML kept in storage ${pageHtmlObjectKey(pageId, kind, variant)}`);
    return;
  }
  throw new Error(`saving ${kind} HTML failed: ${insErr.message}`);
}

export async function readPageHtml(
  sb: SupabaseClient,
  pageId: string,
  kind: 'cloned' | 'swiped' | 'extracted',
  variant = 'desktop',
): Promise<string> {
  if (!pageId) return '';
  const key = pageHtmlObjectKey(pageId, kind, variant);
  let raw = '';
  let rowUpdated = 0;
  try {
    const { data, error } = await sb
      .from('page_html')
      .select('html, updated_at')
      .eq('page_id', pageId)
      .eq('kind', kind)
      .eq('variant', variant)
      .maybeSingle();
    if (error) console.warn('[page-html] select failed:', error.message);
    else if (data) {
      raw = typeof data.html === 'string' ? data.html : '';
      rowUpdated = data.updated_at ? new Date(data.updated_at as string).getTime() || 0 : 0;
    }
  } catch (e) {
    console.warn('[page-html] select failed:', (e as Error).message);
  }
  const storageUpdated = await storageObjectUpdatedAt(sb, key);
  const fromStorage = async () => downloadHtmlObject(sb, key);

  if (isHtmlStoragePointer(raw)) {
    const expanded = await downloadHtmlObject(sb, htmlStoragePath(raw));
    if (expanded.length > 80) return expanded;
  }
  // Inline row and a storage object can disagree: a large clone stays in
  // the bucket while a later edit is written inline, or the row upsert
  // times out after the bucket already has the new HTML. Newer one wins.
  const storageIsNewer = storageUpdated > rowUpdated;
  if (storageIsNewer) {
    const file = await fromStorage();
    if (file.length > 80) return file;
  }
  if (raw && !isHtmlStoragePointer(raw) && raw.length > 80) return raw;
  const file = await fromStorage();
  if (file.length > 80) return file;
  return raw.length > 80 ? raw : '';
}

async function storageObjectUpdatedAt(sb: SupabaseClient, key: string): Promise<number> {
  const slash = key.lastIndexOf('/');
  const folder = slash >= 0 ? key.slice(0, slash) : '';
  const name = slash >= 0 ? key.slice(slash + 1) : key;
  try {
    const { data, error } = await sb.storage.from(PAGE_HTML_BUCKET).list(folder, { search: name, limit: 10 });
    if (error || !data?.length) return 0;
    const hit = data.find((f) => f.name === name) || data[0];
    return hit?.updated_at ? new Date(hit.updated_at).getTime() || 0 : 0;
  } catch {
    return 0;
  }
}

export async function expandStoredHtml(sb: SupabaseClient, raw: string): Promise<string> {
  const t = String(raw || '');
  if (!isHtmlStoragePointer(t)) return t;
  return downloadHtmlObject(sb, htmlStoragePath(t));
}

async function uploadHtmlObject(sb: SupabaseClient, key: string, html: string): Promise<void> {
  const { error } = await sb.storage.from(PAGE_HTML_BUCKET).upload(key, Buffer.from(html, 'utf8'), {
    contentType: 'text/html; charset=utf-8',
    upsert: true,
  });
  if (error && /bucket/i.test(error.message)) {
    await sb.storage.createBucket(PAGE_HTML_BUCKET, { public: true, fileSizeLimit: 52_428_800 }).catch(() => undefined);
    const retry = await sb.storage.from(PAGE_HTML_BUCKET).upload(key, Buffer.from(html, 'utf8'), {
      contentType: 'text/html; charset=utf-8',
      upsert: true,
    });
    if (retry.error) throw new Error(`saving HTML to storage failed: ${retry.error.message}`);
    return;
  }
  if (error) throw new Error(`saving HTML to storage failed: ${error.message}`);
}

async function downloadHtmlObject(sb: SupabaseClient, key: string): Promise<string> {
  if (!key) return '';
  try {
    const { data, error } = await sb.storage.from(PAGE_HTML_BUCKET).download(key);
    if (error || !data) return '';
    const text = await data.text();
    return text.length > 80 ? text : '';
  } catch {
    return '';
  }
}

function isTimeout(message: string): boolean {
  return /statement timeout|57014|canceling statement/i.test(message || '');
}
