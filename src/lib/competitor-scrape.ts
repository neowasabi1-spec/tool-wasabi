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
  mapApifyAdItem,
} from '@/lib/apify';
import { adExistsByExternalId, insertCompetitorAd } from '@/lib/competitor-ads';
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
 * Ingest a finished run's dataset for a brand: dedup by external id, download
 * media, insert, and (best-effort, time-budgeted) transcribe videos.
 */
export async function ingestDataset(opts: {
  projectId: string;
  brandId: number;
  datasetId: string;
}): Promise<{ added: number; skipped: number; failed: number }> {
  const { projectId, brandId, datasetId } = opts;
  const items = await getDatasetItems(datasetId);
  const startedAt = Date.now();
  // Leave headroom before the 300s ceiling; past this, stop downloading and
  // just record remaining creatives as remote URLs (fast) so nothing is lost.
  const DOWNLOAD_BUDGET_MS = 240_000;
  let added = 0, skipped = 0, failed = 0;

  for (const raw of items) {
    const mapped = mapApifyAdItem(raw);
    if (!mapped || !mapped.mediaUrl) { failed++; continue; }

    if (mapped.externalId && (await adExistsByExternalId(brandId, mapped.externalId))) {
      skipped++;
      continue;
    }

    const withinBudget = Date.now() - startedAt < DOWNLOAD_BUDGET_MS;
    const dl = withinBudget ? await downloadMedia(mapped.mediaUrl) : null;
    const contentType =
      dl?.contentType || (mapped.mediaType === 'video' ? 'video/mp4' : 'image/jpeg');

    let bodyText = mapped.bodyText;
    // Auto-transcribe only SHORT clips (inline-capable). Long videos are still
    // downloaded/stored and can be transcribed later on demand via the button.
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

  await supabaseAdmin
    .from('competitor_brands')
    .update({ last_scraped: new Date().toISOString() })
    .eq('id', brandId);

  return { added, skipped, failed };
}
