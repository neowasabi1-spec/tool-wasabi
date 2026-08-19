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
import { launchBrowser, type Browser } from '@/lib/get-browser';
import { absolutizeUrlsInHtml } from '@/lib/spa-rescue';

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

// Match the browser extension's capture viewports exactly so previews look
// identical to extension-saved landings.
const DESKTOP_VIEWPORT = { width: 1280, height: 900 } as const;
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const LANDING_MAX_HEIGHT = 18_000;

interface CaptureResult { buffer: Buffer | null; html: string; title: string }

/** Load a URL in a headless context, trigger lazy-load, then return a
 *  full-page JPEG + (optionally) the rendered HTML/title. */
async function capturePage(
  browser: Browser,
  url: string,
  device: 'desktop' | 'mobile',
  wantHtml: boolean,
): Promise<CaptureResult> {
  const viewport = device === 'mobile' ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
  const context = await browser.newContext({
    userAgent: device === 'mobile' ? MOBILE_UA : DESKTOP_UA,
    viewport,
    deviceScaleFactor: device === 'mobile' ? 2 : 1,
    isMobile: device === 'mobile',
    hasTouch: device === 'mobile',
    ignoreHTTPSErrors: true,
    bypassCSP: true,
  });
  const page = await context.newPage();
  try {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    } catch {
      await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
    }
    await page.waitForTimeout(1500);
    // Scroll to the bottom to trigger lazy-loaded media, then back to top.
    try {
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let total = 0;
          const step = 700;
          const timer = setInterval(() => {
            window.scrollBy(0, step);
            total += step;
            if (total >= document.body.scrollHeight - window.innerHeight) {
              clearInterval(timer);
              window.scrollTo(0, 0);
              setTimeout(resolve, 500);
            }
          }, 100);
        });
      });
    } catch { /* CSP/eval blocked — capture whatever rendered */ }

    let html = '';
    let title = '';
    if (wantHtml) {
      html = await page.content().catch(() => '');
      title = await page.title().catch(() => '');
    }
    const pageHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    const clipHeight = Math.min(LANDING_MAX_HEIGHT, pageHeight || LANDING_MAX_HEIGHT);
    const buffer = (await page.screenshot({
      type: 'jpeg',
      quality: 72,
      fullPage: clipHeight >= (pageHeight || 0),
      clip: clipHeight < (pageHeight || 0)
        ? { x: 0, y: 0, width: viewport.width, height: clipHeight }
        : undefined,
    })) as Buffer;
    return { buffer, html, title };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

/** Upload a landing screenshot to the public `media` bucket (same path
 *  scheme the extension uses) and return its public URL. */
async function uploadLandingShot(
  pageId: string,
  variant: 'desktop' | 'mobile',
  buffer: Buffer,
): Promise<string | null> {
  const path = `extension-captures/${pageId}/${variant}.jpg`;
  const { error } = await supabaseAdmin.storage
    .from('media')
    .upload(path, buffer, { contentType: 'image/jpeg', upsert: true });
  if (error) return null;
  const { data } = supabaseAdmin.storage.from('media').getPublicUrl(path);
  return data.publicUrl || null;
}

/**
 * Save discovered competitor LANDING pages into the project's "Competitor
 * Landings" (archived_funnels rows with project_id), replicating the browser
 * extension: rendered HTML (absolutized) + full-page DESKTOP and MOBILE
 * screenshots uploaded to Storage so the grid shows a real preview.
 * Best-effort, deduped by source_url, capped + time-budgeted for the webhook.
 */
export async function saveCompetitorLandings(
  projectId: string,
  urls: string[],
  platformLabel = '',
): Promise<number> {
  const MAX = 5;
  const BUDGET_MS = 150_000;
  const startedAt = Date.now();

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

  const targets = urls.filter((u) => !existing.has(u)).slice(0, MAX);
  if (targets.length === 0) return 0;

  let browser: Browser | null = null;
  try { browser = await launchBrowser(); }
  catch (e) { console.warn('[landings] browser launch failed, HTML-only fallback:', (e as Error).message); }

  let saved = 0;
  for (const url of targets) {
    if (existing.has(url)) continue;
    if (Date.now() - startedAt > BUDGET_MS) break;

    let name = 'Competitor landing';
    try { name = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep default */ }
    if (platformLabel) name = `${name} (${platformLabel})`;

    // 1) Render + screenshot with the headless browser (extension parity).
    let html = '';
    let title = name;
    let desktopBuf: Buffer | null = null;
    let mobileBuf: Buffer | null = null;
    if (browser) {
      try {
        const desktop = await capturePage(browser, url, 'desktop', true);
        desktopBuf = desktop.buffer;
        html = desktop.html;
        if (desktop.title) title = desktop.title;
      } catch (e) { console.warn(`[landings] desktop capture failed for ${url}:`, (e as Error).message); }
      try {
        const mobile = await capturePage(browser, url, 'mobile', false);
        mobileBuf = mobile.buffer;
      } catch (e) { console.warn(`[landings] mobile capture failed for ${url}:`, (e as Error).message); }
    }

    // 2) Fallback to a plain fetch if the browser produced no HTML.
    if (!html || html.length < 200) html = await fetchLandingHtml(url);
    if (!html || html.length < 200) continue; // nothing worth saving
    try { html = absolutizeUrlsInHtml(html, url); } catch { /* keep raw */ }
    html = html.slice(0, 3_000_000);

    const clonedData: Record<string, unknown> = {
      html, title, source_url: url, method_used: 'apify',
      cloned_at: new Date().toISOString(), category: '', tags: [] as string[],
    };
    const buildStep = () => ({
      step_index: 1, name, page_type: 'landing', category: '', template_name: '',
      product_name: '', url_to_swipe: url, prompt: '', feedback: '',
      swipe_status: 'completed', swipe_result: '', swiped_data: null,
      cloned_data: clonedData,
    });

    // 3) Insert the row, then upload screenshots under its id (extension scheme).
    const { data: created, error } = await supabaseAdmin
      .from('archived_funnels')
      .insert({ name, total_steps: 1, steps: [buildStep()], project_id: projectId })
      .select('id')
      .single();
    if (error || !created) continue;
    const pageId: string = created.id;

    const [desktopUrl, mobileUrl] = await Promise.all([
      desktopBuf ? uploadLandingShot(pageId, 'desktop', desktopBuf) : Promise.resolve(null),
      mobileBuf ? uploadLandingShot(pageId, 'mobile', mobileBuf) : Promise.resolve(null),
    ]);

    // 4) Mirror HTML for the editor + patch cloned_data with preview URLs.
    try {
      await supabaseAdmin.from('page_html').upsert(
        { page_id: pageId, kind: 'cloned', variant: 'desktop', html, updated_at: new Date().toISOString() },
        { onConflict: 'page_id,kind,variant' },
      );
    } catch { /* editor mirror is optional */ }

    clonedData.screenshotDesktopUrl = desktopUrl;
    clonedData.screenshotMobileUrl = mobileUrl;
    clonedData.htmlUrl = `/api/funnel-html?pageId=${encodeURIComponent(pageId)}&kind=cloned&variant=desktop&v=${Date.now()}`;
    await supabaseAdmin.from('archived_funnels').update({ steps: [buildStep()] }).eq('id', pageId);

    saved++;
    existing.add(url);
  }

  if (browser) await browser.close().catch(() => {});
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
