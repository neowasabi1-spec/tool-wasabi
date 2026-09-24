/**
 * Shared helpers for the Competitor Library "creatives" (competitor_ads).
 *
 * Used by both the projecthub UI upload route and the browser-extension
 * save-creative endpoint so uploads/insertions behave identically.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { autoSplitIfVideo } from '@/lib/segment-enqueue';

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
  /** Spoken transcript. Kept off body_text so Meta primary text is not shown as the script. */
  transcript?: string;
  landing_url?: string;
}

let transcriptColumnReady: Promise<void> | null = null;

/** Spoken words live in `transcript`, not in `body_text` (that's Meta primary text). */
export function ensureTranscriptColumn(): Promise<void> {
  if (!transcriptColumnReady) {
    transcriptColumnReady = (async () => {
      const statements = [
        'ALTER TABLE public.competitor_ads ADD COLUMN IF NOT EXISTS transcript text;',
        "NOTIFY pgrst, 'reload schema';",
      ];
      for (const sql of statements) {
        const { error } = await supabaseAdmin.rpc('exec_sql', { sql });
        if (error) console.warn('[competitor-ads] transcript column:', error.message);
      }
    })().catch((e) => {
      console.warn('[competitor-ads] transcript column:', e instanceof Error ? e.message : e);
    });
  }
  return transcriptColumnReady;
}
export async function adExistsByExternalId(
  brandId: number,
  externalId: string,
): Promise<boolean> {
  if (!externalId) return false;
  const { data } = await supabaseAdmin
    .from('competitor_ads')
    .select('id')
    .eq('brand_id', brandId)
    .eq('external_id', externalId)
    .maybeSingle();
  return !!data?.id;
}

/**
 * If this brand already has the ad, fill any empty Meta copy fields
 * (primary text / title / description / destination) from a later scrape.
 * Returns true when the row exists (caller should skip inserting a duplicate).
 */
export async function fillMissingAdCopy(
  brandId: number,
  externalId: string,
  copy: { headline?: string; hook?: string; body_text?: string; landing_url?: string },
): Promise<boolean> {
  if (!externalId) return false;
  const load = async (cols: string) =>
    supabaseAdmin
      .from('competitor_ads')
      .select(cols)
      .eq('brand_id', brandId)
      .eq('external_id', externalId)
      .maybeSingle();

  let { data, error } = await load('id, headline, hook, body_text, landing_url');
  if (error && /landing_url|42703|PGRST204/i.test(error.message)) {
    ({ data, error } = await load('id, headline, hook, body_text'));
  }
  if (error || !data) return false;
  const row = data as {
    id: number; headline?: string; hook?: string; body_text?: string; landing_url?: string;
  };

  const patch: Record<string, unknown> = {};
  if (!(row.headline || '').trim() && copy.headline) patch.headline = copy.headline.slice(0, 500);
  if (!(row.hook || '').trim() && copy.hook) patch.hook = copy.hook.slice(0, 500);
  if (!(row.body_text || '').trim() && copy.body_text) patch.body_text = copy.body_text.slice(0, 4000);
  if (!(row.landing_url || '').trim() && copy.landing_url) patch.landing_url = copy.landing_url.slice(0, 2000);
  if (Object.keys(patch).length === 0) return true;

  let upd = await supabaseAdmin.from('competitor_ads').update(patch).eq('id', row.id);
  if (upd.error && patch.landing_url && /landing_url|42703|PGRST204/i.test(upd.error.message)) {
    delete patch.landing_url;
    if (Object.keys(patch).length > 0) {
      upd = await supabaseAdmin.from('competitor_ads').update(patch).eq('id', row.id);
    }
  }
  return true;
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
  /**
   * A storage path (in BUCKET) for media the caller already uploaded directly
   * (e.g. the extension pushing a large video straight to storage via a signed
   * URL to bypass the serverless body limit). Used as-is; no re-upload.
   */
  preUploadedPath?: string;
  meta?: CreativeMeta;
  externalId?: string;
  source?: string;
  /** Meta Ad Library winner signals (scraper only). */
  adStartedAt?: string;
  adActive?: string;
  adVariants?: number;
  /** Meta spend disclosure (scraper only; present for political ads). */
  spend?: string;
  impressions?: string;
  reach?: number | null;
  /** Advertiser destination URL (Meta snapshot.link_url). */
  landingUrl?: string;
  /** Site origin so auto-split can fire the Netlify background worker. */
  origin?: string;
}): Promise<{ ok: true; ad: Record<string, unknown> } | { ok: false; error: string }> {
  const { projectId, brandId, buffer, contentType, remoteUrl, meta = {} } = opts;
  const mediaType = mediaTypeForContentType(contentType);
  // Only reference external_id/source when a caller opts in (the scraper). This
  // keeps existing callers (extension / manual upload) working even before the
  // competitor-scrape migration has been applied.
  const usesScrapeCols = opts.externalId !== undefined || opts.source !== undefined;

  let filePath = '';
  if (opts.preUploadedPath && opts.preUploadedPath.trim()) {
    // Bytes were already uploaded straight to storage (signed URL) — use as-is.
    filePath = opts.preUploadedPath.trim();
  } else if (buffer && buffer.length > 0) {
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

  const insertRow: Record<string, unknown> = {
    project_id: projectId,
    brand_id: brandId,
    file_path: filePath,
    media_type: mediaType,
    name: (meta.name || '').slice(0, 300),
    headline: (meta.headline || '').slice(0, 500),
    hook: (meta.hook || '').slice(0, 500),
    body_text: (meta.body_text || '').slice(0, 4000),
  };
  if (usesScrapeCols) {
    insertRow.external_id = (opts.externalId || '').slice(0, 200);
    insertRow.source = opts.source || 'manual';
  }

  // Winner-detection signals (Phase 1). These live behind a newer migration,
  // so track which keys we added and retry without them if the columns don't
  // exist yet — never fail a save because the DB hasn't been migrated.
  const extraKeys: string[] = [];
  if (opts.adStartedAt) { insertRow.ad_started_at = opts.adStartedAt; extraKeys.push('ad_started_at'); }
  if (opts.adActive !== undefined) { insertRow.ad_active = opts.adActive || ''; extraKeys.push('ad_active'); }
  if (opts.adVariants !== undefined) { insertRow.ad_variants = opts.adVariants || 0; extraKeys.push('ad_variants'); }
  if (opts.spend) { insertRow.spend = opts.spend; extraKeys.push('spend'); }
  if (opts.impressions) { insertRow.impressions = opts.impressions; extraKeys.push('impressions'); }
  if (opts.reach !== undefined && opts.reach !== null) { insertRow.reach = opts.reach; extraKeys.push('reach'); }
  const spoken = (meta.transcript || '').trim();
  if (spoken) {
    await ensureTranscriptColumn();
    insertRow.transcript = spoken.slice(0, 8000);
    extraKeys.push('transcript');
  }
  const landingUrl = (opts.landingUrl || meta.landing_url || '').trim();
  const hasLanding = Boolean(landingUrl);
  if (hasLanding) insertRow.landing_url = landingUrl.slice(0, 2000);

  let { data, error } = await supabaseAdmin
    .from('competitor_ads')
    .insert(insertRow)
    .select()
    .single();

  if (error && insertRow.transcript && /transcript/i.test(error.message || '')) {
    delete insertRow.transcript;
    ({ data, error } = await supabaseAdmin
      .from('competitor_ads')
      .insert(insertRow)
      .select()
      .single());
  }

  // Missing-column fallback (PostgREST error code 42703 / PGRST204).
  // Drop landing_url first (newest column), then the older winner-signal keys.
  if (error && hasLanding && /landing_url|column|schema cache|42703|PGRST204/i.test(error.message)) {
    delete insertRow.landing_url;
    ({ data, error } = await supabaseAdmin
      .from('competitor_ads')
      .insert(insertRow)
      .select()
      .single());
  }
  if (error && extraKeys.length > 0 && /column|schema cache|42703|PGRST204/i.test(error.message)) {
    for (const k of extraKeys) delete insertRow[k];
    ({ data, error } = await supabaseAdmin
      .from('competitor_ads')
      .insert(insertRow)
      .select()
      .single());
  }

  if (error || !data) return { ok: false, error: error?.message || 'Insert failed' };

  // Auto-split new videos into shots the moment they land (scrape / extension /
  // manual upload) so the shot pool stays fresh without a manual click.
  if (mediaType === 'video' && filePath) {
    const adId = Number((data as { id?: number }).id);
    if (Number.isFinite(adId)) {
      await autoSplitIfVideo({ projectId, brandId, adId, mediaType, filePath, origin: opts.origin });
    }
  }

  return { ok: true, ad: data };
}
