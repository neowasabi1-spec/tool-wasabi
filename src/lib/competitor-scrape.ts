/**
 * Orchestrates competitor Ad Library scraping via Apify:
 *  - decide which brands are due for a refresh,
 *  - start an actor run (with a callback webhook),
 *  - ingest the run's dataset: dedup, download media, insert, transcribe.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  startAdsLibraryRun,
  getDatasetItems,
  mapperForPlatform,
  type AdPlatform,
} from '@/lib/apify';
import { adExistsByExternalId, insertCompetitorAd, ensureBrand } from '@/lib/competitor-ads';
import { transcribeVideo } from '@/lib/transcribe';

// Download cap for a single creative. Generous so even long VSL-style videos
// get stored permanently (the Supabase bucket file-size limit must allow it).
const MAX_MEDIA_BYTES = 300 * 1024 * 1024;
// Overall transcription budget for the whole run (webhook can run up to 300s).
const TRANSCRIBE_BUDGET_MS = 180_000;

export interface Brand {
  id: number;
  project_id: string;
  name: string;
  ads_library_url: string;
  frequency: string;
  scrape_count: number | null;
  is_active: string;
  last_scraped: string | null;
}

/** The deployed site base URL (used to build the Apify callback webhook). */
export function siteBaseUrl(): string {
  return (
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    ''
  ).replace(/\/$/, '');
}

export function webhookSecret(): string {
  return process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';
}

const FREQUENCY_DAYS: Record<string, number> = {
  daily: 1,
  every_day: 1,
  every_3_days: 3,
  every_7_days: 7,
  weekly: 7,
  every_14_days: 14,
  biweekly: 14,
  every_30_days: 30,
  monthly: 30,
};

export function frequencyDays(freq: string): number {
  return FREQUENCY_DAYS[(freq || '').trim().toLowerCase()] ?? 7;
}

export function isBrandDue(b: Brand): boolean {
  if (!b.ads_library_url) return false;
  if (b.is_active === 'false') return false;
  if (!b.last_scraped) return true;
  const days = frequencyDays(b.frequency);
  const elapsed = Date.now() - new Date(b.last_scraped).getTime();
  return elapsed >= days * 24 * 60 * 60 * 1000;
}

/** Start an Apify run for one brand; the webhook does the ingestion later. */
export async function startBrandScrape(
  brand: Brand,
): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const base = siteBaseUrl();
  if (!base) return { ok: false, error: 'Site base URL not configured (env URL)' };

  const params = new URLSearchParams({
    projectId: brand.project_id,
    brandId: String(brand.id),
  });
  const secret = webhookSecret();
  if (secret) params.set('secret', secret);

  const res = await startAdsLibraryRun({
    adsLibraryUrl: brand.ads_library_url,
    count: brand.scrape_count || 20,
    webhookUrl: `${base}/api/apify/webhook?${params.toString()}`,
  });

  if (res.ok) {
    await supabaseAdmin
      .from('competitor_brands')
      .update({ last_run_id: res.runId })
      .eq('id', brand.id);
  }
  return res;
}

/** Best-effort fetch of a landing page's rendered-enough HTML. */
async function fetchLandingHtml(url: string): Promise<string> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
    });
    if (!resp.ok) return '';
    const ct = resp.headers.get('content-type') || '';
    if (!/text\/html/i.test(ct)) return '';
    const text = await resp.text();
    return text.slice(0, 3_000_000);
  } catch {
    return '';
  }
}

/**
 * Save discovered competitor LANDING pages into the project's "Competitor
 * Landings" (archived_funnels rows with project_id). Best-effort, deduped by
 * source_url, capped so a run stays within the webhook time budget.
 */
export async function saveCompetitorLandings(
  projectId: string,
  urls: string[],
  platformLabel = '',
): Promise<number> {
  const MAX = 6;
  const { data: existingRows } = await supabaseAdmin
    .from('archived_funnels')
    .select('id, steps')
    .eq('project_id', projectId);
  const existing = new Set<string>();
  for (const r of (existingRows || []) as Array<{ steps?: unknown }>) {
    const step = Array.isArray(r.steps) ? (r.steps[0] as Record<string, unknown>) : null;
    const cd = step?.cloned_data as Record<string, unknown> | undefined;
    const u = typeof cd?.source_url === 'string' ? cd.source_url : '';
    if (u) existing.add(u);
  }

  let saved = 0;
  for (const url of urls) {
    if (saved >= MAX) break;
    if (existing.has(url)) continue;
    const html = await fetchLandingHtml(url);
    if (!html || html.length < 200) continue;

    let name = 'Competitor landing';
    try { name = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep default */ }
    if (platformLabel) name = `${name} (${platformLabel})`;

    const step = {
      step_index: 1, name, page_type: 'landing', category: '', template_name: '',
      product_name: '', url_to_swipe: url, prompt: '', feedback: '',
      swipe_status: 'completed', swipe_result: '', swiped_data: null,
      cloned_data: {
        html, title: name, source_url: url, method_used: 'apify',
        cloned_at: new Date().toISOString(), category: '', tags: [] as string[],
      },
    };
    const { data: created, error } = await supabaseAdmin
      .from('archived_funnels')
      .insert({ name, total_steps: 1, steps: [step], project_id: projectId })
      .select('id')
      .single();
    if (error || !created) continue;

    try {
      await supabaseAdmin.from('page_html').upsert(
        { page_id: created.id, kind: 'cloned', variant: 'desktop', html, updated_at: new Date().toISOString() },
        { onConflict: 'page_id,kind,variant' },
      );
    } catch { /* editor mirror is optional */ }

    saved++;
    existing.add(url);
  }
  return saved;
}

async function downloadMedia(
  url: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') || '';
    const len = Number(resp.headers.get('content-length') || '0');
    if (len && len > MAX_MEDIA_BYTES) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_MEDIA_BYTES) return null;
    return { buffer: buf, contentType };
  } catch {
    return null;
  }
}

/**
 * Ingest a finished run's dataset: dedup by external id, download media,
 * insert, and (best-effort, time-budgeted) transcribe videos.
 *
 * Two modes:
 *  - LEGACY per-brand (brandId given): all creatives go under that brand
 *    (scheduled/manual scrapes of one competitor's Ad Library).
 *  - DISCOVERY (no brandId): a keyword search that surfaces MANY advertisers.
 *    We create/resolve one competitor brand PER advertiser ("divided by page")
 *    and file each creative under its advertiser. `platform` selects the mapper
 *    and tags the source.
 */
export async function ingestDataset(opts: {
  projectId: string;
  brandId?: number;
  datasetId: string;
  platform?: AdPlatform;
}): Promise<{ added: number; skipped: number; failed: number; brands: number; landings: number }> {
  const { projectId, datasetId } = opts;
  const platform: AdPlatform = opts.platform || 'meta';
  const fixedBrandId = opts.brandId && opts.brandId > 0 ? opts.brandId : 0;
  const map = mapperForPlatform(platform);
  const items = await getDatasetItems(datasetId);
  const startedAt = Date.now();
  const DOWNLOAD_BUDGET_MS = 240_000;
  let added = 0, skipped = 0, failed = 0;

  // Discovery-mode caches so we resolve each advertiser's brand only once.
  const brandCache = new Map<string, number>();
  const touchedBrands = new Set<number>();
  const landingUrls = new Set<string>();

  const platformLabel = platform === 'tiktok' ? 'TikTok' : platform === 'google' ? 'Google' : '';

  for (const raw of items) {
    const mapped = map(raw);
    if (!mapped) { failed++; continue; }

    // Collect landing pages from Google only (its landing_page_url is the real
    // advertiser destination; TikTok/Meta expose internal ad-detail links).
    if (platform === 'google' && mapped.landingUrl && /^https?:\/\//i.test(mapped.landingUrl)) {
      landingUrls.add(mapped.landingUrl);
    }
    if (!mapped.mediaUrl) { continue; } // text-only ad → landing captured, no creative

    // Resolve the brand this creative belongs to.
    let brandId = fixedBrandId;
    if (!brandId) {
      const advertiser = (mapped.pageName || '').trim() || `${platformLabel || 'Unknown'} advertiser`;
      // Tag with platform so the same brand name from different networks stays
      // grouped per advertiser but is still traceable to its source.
      const brandName = platformLabel ? `${advertiser} (${platformLabel})` : advertiser;
      const cached = brandCache.get(brandName);
      if (cached) brandId = cached;
      else {
        const resolved = await ensureBrand(projectId, brandName);
        if (!resolved) { failed++; continue; }
        brandId = resolved;
        brandCache.set(brandName, resolved);
      }
    }
    touchedBrands.add(brandId);

    if (mapped.externalId && (await adExistsByExternalId(brandId, mapped.externalId))) {
      skipped++;
      continue;
    }

    const withinBudget = Date.now() - startedAt < DOWNLOAD_BUDGET_MS;
    const dl = withinBudget ? await downloadMedia(mapped.mediaUrl) : null;
    const contentType =
      dl?.contentType || (mapped.mediaType === 'video' ? 'video/mp4' : 'image/jpeg');

    let bodyText = mapped.bodyText;
    const AUTO_TRANSCRIBE_MAX = 18 * 1024 * 1024;
    if (
      mapped.mediaType === 'video' &&
      dl?.buffer &&
      dl.buffer.length <= AUTO_TRANSCRIBE_MAX &&
      Date.now() - startedAt < TRANSCRIBE_BUDGET_MS
    ) {
      const remaining = TRANSCRIBE_BUDGET_MS - (Date.now() - startedAt);
      const transcript = await transcribeVideo(dl.buffer, contentType, remaining).catch(() => '');
      if (transcript) bodyText = `${bodyText ? bodyText + '\n\n' : ''}${transcript}`.slice(0, 4000);
    }

    const res = await insertCompetitorAd({
      projectId,
      brandId,
      buffer: dl?.buffer || null,
      contentType,
      remoteUrl: mapped.mediaUrl,
      externalId: mapped.externalId,
      source: 'apify',
      adStartedAt: mapped.adStartedAt || undefined,
      adActive: mapped.adActive,
      adVariants: mapped.adVariants,
      spend: mapped.spend || undefined,
      impressions: mapped.impressions || undefined,
      reach: mapped.reach,
      meta: {
        name: mapped.headline || mapped.pageName,
        headline: mapped.headline,
        hook: mapped.hook,
        body_text: bodyText,
      },
    });
    if (res.ok) added++;
    else failed++;
  }

  // Mark touched brands as scraped so the "new" badge + cron behave.
  const now = new Date().toISOString();
  if (fixedBrandId) {
    await supabaseAdmin.from('competitor_brands').update({ last_scraped: now }).eq('id', fixedBrandId);
  } else if (touchedBrands.size) {
    await supabaseAdmin.from('competitor_brands').update({ last_scraped: now }).in('id', [...touchedBrands]);
  }

  // Best-effort: save discovered competitor landing pages into the project.
  let landings = 0;
  if (landingUrls.size) {
    landings = await saveCompetitorLandings(projectId, [...landingUrls], platformLabel).catch(() => 0);
  }

  return { added, skipped, failed, brands: touchedBrands.size, landings };
}
