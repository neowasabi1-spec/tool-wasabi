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
  type MappedAd,
} from '@/lib/apify';
import { adExistsByExternalId, insertCompetitorAd, ensureBrand } from '@/lib/competitor-ads';
import { transcribeVideo } from '@/lib/transcribe';
import { absolutizeUrlsInHtml } from '@/lib/spa-rescue';
import { extractLandingMediaFromHtml, isJunkLandingHost } from '@/lib/landing-media';
import { isOnNiche } from '@/lib/competitor-relevance';
import { hostOf, judgeAdvertisers, type AdvertiserCard, type ProductProfile } from '@/lib/competitor-judge';
import { shortApifyWebhookUrl } from '@/lib/discovery-lexicon';
import { htmlToReadableText } from '@/lib/page-text';

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

/** Advertiser identity for grouping: page name, else landing host. */
function advertiserKey(m: MappedAd): string {
  const name = (m.pageName || '').trim().toLowerCase();
  return name || hostOf(m.landingUrl) || '(unknown)';
}

/** One card per advertiser with a few readable ad texts for the model. */
function advertiserCards(items: Array<MappedAd | null>): AdvertiserCard[] {
  const byKey = new Map<string, AdvertiserCard>();
  for (const m of items) {
    if (!m) continue;
    const id = advertiserKey(m);
    let card = byKey.get(id);
    if (!card) {
      card = { id, name: (m.pageName || '').trim() || hostOf(m.landingUrl) || 'Unknown', samples: [], landingHost: '' };
      byKey.set(id, card);
    }
    if (!card.landingHost) card.landingHost = hostOf(m.landingUrl);
    const text = [m.headline, m.hook, m.bodyText]
      .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' — ');
    if (text && card.samples.length < 4 && !card.samples.some((s) => s.slice(0, 80) === text.slice(0, 80))) {
      card.samples.push(text);
    }
  }
  return [...byKey.values()];
}

/**
 * Give the judge the advertiser's LANDING PAGE, not just the ad: affiliates
 * usually keep the brand out of the ad text and name it (and link the offer
 * checkout) only on their pre-lander. One page per advertiser, fetched in
 * parallel with a tight budget; the HTML is cached for saveCompetitorLandings.
 */
async function enrichCardsWithLandings(
  cards: AdvertiserCard[],
  items: Array<MappedAd | null>,
  htmlCache: Map<string, { html: string; finalUrl: string }>,
): Promise<void> {
  const urlByCard = new Map<string, string>();
  for (const m of items) {
    if (!m || !isRealLandingUrl(m.landingUrl) || isJunkLandingHost(m.landingUrl as string)) continue;
    const id = advertiserKey(m);
    if (!urlByCard.has(id)) urlByCard.set(id, m.landingUrl as string);
  }
  const targets = cards.filter((c) => urlByCard.has(c.id)).slice(0, 80);
  if (!targets.length) return;

  const deadline = Date.now() + 45_000;
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length && Date.now() < deadline) {
      const card = targets[cursor++];
      const url = urlByCard.get(card.id) as string;
      const fetched = htmlCache.get(url) || (await fetchLandingHtml(url));
      if (!fetched.html) continue;
      htmlCache.set(url, fetched);
      const text = htmlToReadableText(fetched.html, 1_500).replace(/\s+/g, ' ').trim();
      const title = (fetched.html.match(/<title[^>]*>([^<]{2,200})<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
      card.landingText = [title && `Title: ${title}`, text].filter(Boolean).join(' | ').slice(0, 1_500);
      // Outbound hosts: where the page's CTAs send the buyer.
      const links = new Set<string>();
      const re = /<a\b[^>]*\bhref=["'](https?:\/\/[^"'#\s]+)["']/gi;
      let lm: RegExpExecArray | null;
      while ((lm = re.exec(fetched.html)) && links.size < 40) {
        const h = hostOf(lm[1]);
        if (h && h !== hostOf(fetched.finalUrl)) links.add(h);
      }
      card.landingLinks = [...links];
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, targets.length) }, worker));
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
  opts: { collectMedia?: boolean; htmlCache?: Map<string, { html: string; finalUrl: string }>; deadline?: number } = {},
): Promise<number> {
  const collectMedia = opts.collectMedia !== false;
  const MAX = 30;
  const deadline = opts.deadline || Number.POSITIVE_INFINITY;
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
    if (Date.now() > deadline) break;
    if (existing.has(url)) continue;
    if (isJunkLandingHost(url)) continue;

    const fetched = opts.htmlCache?.get(url) || (await fetchLandingHtml(url));
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
    if (!collectMedia) continue; // affiliate: another brand's photos never enter the offer library
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
  /** Discovery-only: the product the model judges competitors against. */
  product?: ProductProfile | null;
  /** Discovery-only fallback when the model cannot be asked: keyword include/exclude. */
  includeTerms?: string[];
  excludeTerms?: string[];
  /** False in affiliate runs: competitor landings are saved, their photos are not pulled into the library. */
  collectMedia?: boolean;
}): Promise<{ added: number; skipped: number; failed: number; brands: number; landings: number }> {
  const { projectId, datasetId } = opts;
  const platform: AdPlatform = opts.platform || 'meta';
  const fixedBrandId = opts.brandId && opts.brandId > 0 ? opts.brandId : 0;
  const includeTerms = opts.includeTerms || [];
  const excludeTerms = opts.excludeTerms || [];
  const discovery = !fixedBrandId;
  const map = mapperForPlatform(platform);
  // Deep searches return hundreds of ads per run; read them all.
  const items = await getDatasetItems(datasetId, 1000);
  const startedAt = Date.now();
  // The webhook has 300s. Downloads stop at this mark so brands, ads and
  // landings are always written before Netlify kills the function.
  const DOWNLOAD_BUDGET_MS = 200_000;
  const HARD_DEADLINE = startedAt + 265_000;
  let added = 0, skipped = 0, failed = 0;

  // Discovery-mode caches so we resolve each advertiser's brand only once.
  const brandCache = new Map<string, number>();
  const touchedBrands = new Set<number>();
  const landingUrls = new Set<string>();

  const platformLabel = platform === 'tiktok' ? 'TikTok' : platform === 'google' ? 'Google' : '';

  const mappedItems = items.map((raw) => map(raw));

  // Discovery: the model reads every advertiser's copy once and says whether
  // it competes with our product. Keyword include/exclude is only the fallback
  // when the model cannot be asked.
  let keep: ((m: MappedAd) => boolean) | null = null;
  const byKeywords = (m: MappedAd) =>
    isOnNiche([m.pageName, m.headline, m.hook, m.bodyText, m.landingUrl], includeTerms, excludeTerms);
  // Landing pages fetched for the judge are reused when saving landings.
  const htmlCache = new Map<string, { html: string; finalUrl: string }>();
  if (discovery && opts.product?.name) {
    try {
      const cards = advertiserCards(mappedItems);
      // Affiliates keep the brand out of the ad and name it on the pre-lander:
      // the judge must read the landing page, not just the ad copy.
      await enrichCardsWithLandings(cards, mappedItems, htmlCache);
      const verdicts = await judgeAdvertisers(opts.product, cards);
      // Model verdict when it answered for this advertiser; keyword check only
      // for the ones it did not (a failed batch), never a blanket reject.
      keep = (m) => {
        const v = verdicts.get(advertiserKey(m));
        if (v) return v.competitor;
        return includeTerms.length ? byKeywords(m) : true;
      };
      const yes = [...verdicts.values()].filter((v) => v.competitor).length;
      console.log(`[ingestDataset] ${platform}: model kept ${yes}/${verdicts.size} advertisers for "${opts.product.name}"`);
    } catch (e) {
      console.warn('[ingestDataset] competitor judge failed, keyword fallback:', (e as Error).message);
    }
  }
  if (!keep && discovery && includeTerms.length > 0) {
    keep = byKeywords;
  }

  // Pass 1 — decide what to store. Ads are grouped per advertiser: the goal is
  // the ADVERTISER SET, so one page running 300 variants yields one brand with
  // a handful of creatives, and the download time goes to the next advertiser.
  const PER_ADVERTISER = 12;
  const perAdvertiser = new Map<string, number>();
  const queue: Array<{ mapped: MappedAd; brandName: string }> = [];
  for (const mapped of mappedItems) {
    if (!mapped) { failed++; continue; }

    if (keep && !keep(mapped)) {
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

    let brandName = '';
    if (!fixedBrandId) {
      const advertiser = (mapped.pageName || '').trim() || `${platformLabel || 'Unknown'} advertiser`;
      if (!isRealAdvertiser(advertiser)) { skipped++; continue; } // drop platform/agency noise
      // Tag with platform so the same brand name from different networks stays
      // grouped per advertiser but is still traceable to its source.
      brandName = platformLabel ? `${advertiser} (${platformLabel})` : advertiser;
      const n = perAdvertiser.get(brandName) || 0;
      if (discovery && n >= PER_ADVERTISER) { skipped++; continue; }
      perAdvertiser.set(brandName, n + 1);
    }
    queue.push({ mapped, brandName });
  }

  // Resolve brands once, sequentially (ensureBrand is find-or-create: running
  // it concurrently for the same name would create duplicates).
  for (const { brandName } of queue) {
    if (fixedBrandId || !brandName || brandCache.has(brandName)) continue;
    const resolved = await ensureBrand(projectId, brandName);
    if (resolved) brandCache.set(brandName, resolved);
  }

  // Pass 2 — download + insert with a small worker pool (sequential downloads
  // of 300 creatives do not fit the webhook budget).
  const AUTO_TRANSCRIBE_MAX = 18 * 1024 * 1024;
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const { mapped, brandName } = queue[cursor++];
      if (Date.now() > HARD_DEADLINE) { skipped++; continue; }
      const brandId = fixedBrandId || brandCache.get(brandName) || 0;
      if (!brandId) { failed++; continue; }
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
  };
  await Promise.all(Array.from({ length: Math.min(5, Math.max(1, queue.length)) }, worker));

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
    landings = await saveCompetitorLandings(projectId, [...landingUrls], platformLabel, {
      collectMedia: opts.collectMedia !== false,
      htmlCache,
      deadline: HARD_DEADLINE + 20_000,
    }).catch(() => 0);
  }

  return { added, skipped, failed, brands: touchedBrands.size, landings };
}
