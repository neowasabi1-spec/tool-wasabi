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
import { absolutizeUrlsInHtml } from '@/lib/spa-rescue';
import { extractLandingMediaFromHtml } from '@/lib/landing-media';
import { isOnNiche } from '@/lib/competitor-relevance';
import { shortApifyWebhookUrl } from '@/lib/discovery-lexicon';

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

  const res = await startAdsLibraryRun({
    adsLibraryUrl: brand.ads_library_url,
    count: brand.scrape_count || 20,
    webhookUrl: shortApifyWebhookUrl({
      base,
      projectId: brand.project_id,
      brandId: brand.id,
      secret: webhookSecret(),
    }),
  });

  if (res.ok) {
    await supabaseAdmin
      .from('competitor_brands')
      .update({ last_run_id: res.runId })
      .eq('id', brand.id);
  }
  return res;
}

// Platform / SaaS / agency / marketplace brands that are NOT real product
// competitors — they advertise everywhere and pollute niche discovery.
const NOISE_TERMS = /\b(shopify|whatchimp|manychat|klaviyo|mailchimp|hubspot|salesforce|semrush|ahrefs|wix|squarespace|godaddy|bluehost|hostinger|printful|printify|oberlo|aliexpress|alibaba|fiverr|upwork|canva|easyads|adspy|dropshipping|clickfunnels|systeme\.io|kajabi|teachable|shesellsremote|podpluser)\b/i;

/** True for an advertiser name that is a real product competitor (not a
 *  platform/agency/marketplace that advertises across every niche). */
function isRealAdvertiser(name: string | undefined): boolean {
  if (!name) return false;
  return !NOISE_TERMS.test(name);
}

/** True for a real advertiser destination (not a social/ad-platform host,
 *  jobs/careers page, or known platform/agency domain). */
function isRealLandingUrl(url: string | undefined): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (/(^|\.)(facebook\.com|fb\.me|instagram\.com|tiktok\.com|library\.tiktok\.com|google\.com|adstransparency\.google\.com|youtube\.com|l\.facebook\.com|linkedin\.com)$/.test(host)) return false;
    if (/^(jobs|careers|karriere|recruiting)\.|\.personio\.|\.jobs\./.test(host)) return false; // hiring pages
    if (NOISE_TERMS.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Best-effort plain fetch of a landing page's HTML (fallback when the
 *  headless browser is unavailable or fails). */
async function fetchLandingHtml(url: string): Promise<{ html: string; finalUrl: string }> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
    });
    if (!resp.ok) return { html: '', finalUrl: url };
    const ct = resp.headers.get('content-type') || '';
    if (!/text\/html/i.test(ct)) return { html: '', finalUrl: resp.url || url };
    const text = await resp.text();
    return { html: text.slice(0, 3_000_000), finalUrl: resp.url || url };
  } catch {
    return { html: '', finalUrl: url };
  }
}

/** Fire-and-forget: trigger the dedicated background function that renders
 *  desktop+mobile screenshots for a project's landings and patches them in.
 *  Decoupled from this webhook so heavy Playwright work never competes with
 *  ad ingestion for the 300s budget (it gets its own 15-min background run). */
async function triggerLandingShots(projectId: string): Promise<void> {
  const base = siteBaseUrl();
  if (!base) return;
  const secret = webhookSecret();
  const url = `${base}/.netlify/functions/competitor-shots-background`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, secret }),
      signal: AbortSignal.timeout(5_000), // background returns 202 immediately
    });
  } catch { /* fire-and-forget: background may still have been queued */ }
}

/**
 * Save discovered competitor LANDING pages into the project's "Competitor
 * Landings" (archived_funnels rows with project_id). Saves the rendered HTML
 * FAST (plain fetch + absolutize) so landings always appear, then hands off
 * desktop+mobile SCREENSHOT capture to a background function (extension parity)
 * which patches each row's preview URLs. Deduped by source_url, capped.
 */
export async function saveCompetitorLandings(
  projectId: string,
  urls: string[],
  platformLabel = '',
): Promise<number> {
  const MAX = 16;
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

    const fetched = await fetchLandingHtml(url);
    let html = fetched.html;
    const pageUrl = fetched.finalUrl || url;
    if (!html || html.length < 200) continue;
    try { html = absolutizeUrlsInHtml(html, pageUrl); } catch { /* keep raw */ }
    html = html.slice(0, 3_000_000);

    let name = 'Competitor landing';
    try { name = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* keep default */ }
    if (platformLabel) name = `${name} (${platformLabel})`;

    const step = {
      step_index: 1, name, page_type: 'landing', category: '', template_name: '',
      product_name: '', url_to_swipe: pageUrl, prompt: '', feedback: '',
      swipe_status: 'completed', swipe_result: '', swiped_data: null,
      cloned_data: {
        html, title: name, source_url: pageUrl, method_used: 'apify',
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
    existing.add(pageUrl);
    try {
      await extractLandingMediaFromHtml(supabaseAdmin, {
        projectId,
        html,
        pageUrl,
        limit: 16,
      });
    } catch (e) {
      console.warn('[saveCompetitorLandings] landing media:', (e as Error).message);
    }
  }

  // Hand off screenshot rendering to the background function (best-effort).
  if (saved > 0) await triggerLandingShots(projectId);
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
  /** Discovery-only: keep creatives that mention the product, drop the rest. */
  includeTerms?: string[];
  excludeTerms?: string[];
}): Promise<{ added: number; skipped: number; failed: number; brands: number; landings: number }> {
  const { projectId, datasetId } = opts;
  const platform: AdPlatform = opts.platform || 'meta';
  const fixedBrandId = opts.brandId && opts.brandId > 0 ? opts.brandId : 0;
  const includeTerms = opts.includeTerms || [];
  const excludeTerms = opts.excludeTerms || [];
  const discoveryFilter = !fixedBrandId && includeTerms.length > 0;
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

    const nicheParts = [
      mapped.pageName, mapped.headline, mapped.hook, mapped.bodyText, mapped.landingUrl,
    ];
    if (discoveryFilter && !isOnNiche(nicheParts, includeTerms, excludeTerms)) {
      skipped++;
      continue;
    }

    // Collect REAL advertiser landing pages from Meta (snapshot.link_url) and
    // Google (landing_page_url). TikTok only exposes its own ad-detail link, so
    // it's excluded. Social/internal hosts are filtered out.
    if ((platform === 'meta' || platform === 'google') && isRealLandingUrl(mapped.landingUrl)) {
      landingUrls.add(mapped.landingUrl as string);
    }
    if (!mapped.mediaUrl) { continue; } // text-only ad → landing captured, no creative

    // Resolve the brand this creative belongs to.
    let brandId = fixedBrandId;
    if (!brandId) {
      const advertiser = (mapped.pageName || '').trim() || `${platformLabel || 'Unknown'} advertiser`;
      if (!isRealAdvertiser(advertiser)) { skipped++; continue; } // drop platform/agency noise
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
