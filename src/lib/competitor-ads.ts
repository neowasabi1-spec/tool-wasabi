/**
 * Shared helpers for the Competitor Library "creatives" (competitor_ads).
 *
 * Used by both the projecthub UI upload route and the browser-extension
 * save-creative endpoint so uploads/insertions behave identically.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';

const BUCKET = 'project-files';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
};

export function extForContentType(ct: string, fallback = 'bin'): string {
  const base = (ct || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[base] || fallback;
}

export function mediaTypeForContentType(ct: string): 'image' | 'video' {
  return /^video\//i.test((ct || '').trim()) ? 'video' : 'image';
}

/** Turn any URL / hostname into a clean, human brand label. */
export function brandNameFromUrl(pageUrl: string): string {
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./i, '');
    return host || 'Saved creatives';
  } catch {
    return 'Saved creatives';
  }
}

/**
 * Find (or create) the competitor brand for a given project + display name.
 * Extension saves group all creatives from the same source domain under one
 * brand card. Returns the brand id.
 */
export async function ensureBrand(
  projectId: string,
  name: string,
  adsLibraryUrl = '',
): Promise<number | null> {
  const clean = name.trim() || 'Saved creatives';

  const { data: existing } = await supabaseAdmin
    .from('competitor_brands')
    .select('id')
    .eq('project_id', projectId)
    .eq('name', clean)
    .maybeSingle();
  if (existing?.id) return existing.id as number;

  const { data: created, error } = await supabaseAdmin
    .from('competitor_brands')
    .insert({
      project_id: projectId,
      name: clean,
      ads_library_url: adsLibraryUrl,
      brand_type: 'competitor',
    })
    .select('id')
    .single();
  if (error || !created) return null;
  return created.id as number;
}

export interface CreativeMeta {
  name?: string;
  headline?: string;
  hook?: string;
  body_text?: string;
}

/**
 * Upload creative bytes to storage and insert a competitor_ads row.
 * When `buffer` is null we store `remoteUrl` directly as the file_path so the
 * preview still resolves through a direct link (getUploadUrl passes http(s)
 * paths through untouched).
 */
export async function insertCompetitorAd(opts: {
  projectId: string;
  brandId: number;
  buffer: Buffer | null;
  contentType: string;
  originalName?: string;
  remoteUrl?: string;
  meta?: CreativeMeta;
}): Promise<{ ok: true; ad: Record<string, unknown> } | { ok: false; error: string }> {
  const { projectId, brandId, buffer, contentType, remoteUrl, meta = {} } = opts;
  const mediaType = mediaTypeForContentType(contentType);

  let filePath = '';
  if (buffer && buffer.length > 0) {
    const ext = extForContentType(contentType, mediaType === 'video' ? 'mp4' : 'jpg');
    const rand = Math.random().toString(36).slice(2, 8);
    filePath = `${projectId}/competitor-ads/${brandId}/${Date.now()}_${rand}.${ext}`;
    const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(filePath, buffer, {
      contentType: contentType || 'application/octet-stream',
      upsert: false,
    });
    if (upErr) {
      // Fall back to the remote URL rather than failing the whole save.
      filePath = remoteUrl && /^https?:\/\//i.test(remoteUrl) ? remoteUrl : '';
      if (!filePath) return { ok: false, error: `Upload failed: ${upErr.message}` };
    }
  } else if (remoteUrl && /^https?:\/\//i.test(remoteUrl)) {
    filePath = remoteUrl;
  } else {
    return { ok: false, error: 'No media bytes and no remote URL to store' };
  }

  const { data, error } = await supabaseAdmin
    .from('competitor_ads')
    .insert({
      project_id: projectId,
      brand_id: brandId,
      file_path: filePath,
      media_type: mediaType,
      name: (meta.name || '').slice(0, 300),
      headline: (meta.headline || '').slice(0, 500),
      hook: (meta.hook || '').slice(0, 500),
      body_text: (meta.body_text || '').slice(0, 4000),
    })
    .select()
    .single();

  if (error || !data) return { ok: false, error: error?.message || 'Insert failed' };
  return { ok: true, ad: data };
}
