/**
 * Apify integration for scraping a competitor's Meta (Facebook/Instagram)
 * Ad Library. We start an actor run and attach an ad-hoc webhook so Apify
 * calls us back when the run finishes — no polling, no local worker.
 *
 * The exact output shape differs between actors, so `mapApifyAdItem` is
 * intentionally tolerant and probes several common field names.
 */

const APIFY_BASE = 'https://api.apify.com/v2';

export function apifyToken(): string {
  return process.env.APIFY_KEY || process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || '';
}

export function apifyActorId(): string {
  // Override with APIFY_FB_ADS_ACTOR ("username~actor-name"). Default is a
  // widely-used FB Ad Library scraper.
  return process.env.APIFY_FB_ADS_ACTOR || 'curious_coder~facebook-ads-library-scraper';
}

export function apifyConfigured(): boolean {
  return !!apifyToken();
}

/** Build the base64 `webhooks` query param that attaches a run webhook. */
function webhooksParam(requestUrl: string): string {
  const payload = [
    {
      eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT'],
      requestUrl,
    },
  ];
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/**
 * Start an actor run for an Ad Library URL. Returns the Apify run id.
 * `webhookUrl` should already carry any context we need back (brandId, etc.)
 * as query params; Apify appends its own payload.
 */
export async function startAdsLibraryRun(opts: {
  adsLibraryUrl: string;
  count?: number;
  webhookUrl: string;
}): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const token = apifyToken();
  if (!token) return { ok: false, error: 'APIFY_KEY not configured' };
  if (!opts.adsLibraryUrl) return { ok: false, error: 'Missing ads_library_url' };

  const count = Math.min(Math.max(opts.count || 20, 1), 200);

  // Superset input — unknown keys are ignored by actors, so this works across
  // the common FB Ad Library actors without per-actor branching.
  const input: Record<string, unknown> = {
    urls: [{ url: opts.adsLibraryUrl, method: 'GET' }],
    startUrls: [{ url: opts.adsLibraryUrl }],
    adLibraryUrl: opts.adsLibraryUrl,
    count,
    maxResults: count,
    resultsLimit: count,
    scrapeAdDetails: true,
    scrapePageAds: true,
    activeStatus: 'active',
  };

  const url =
    `${APIFY_BASE}/acts/${apifyActorId()}/runs` +
    `?token=${encodeURIComponent(token)}` +
    `&webhooks=${encodeURIComponent(webhooksParam(opts.webhookUrl))}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = json?.error?.message || `Apify start failed (${resp.status})`;
      return { ok: false, error: msg };
    }
    const runId = json?.data?.id;
    if (!runId) return { ok: false, error: 'No run id returned by Apify' };
    return { ok: true, runId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Apify request failed' };
  }
}

/** Fetch dataset items produced by a finished run. */
export async function getDatasetItems(datasetId: string, limit = 200): Promise<unknown[]> {
  const token = apifyToken();
  if (!token || !datasetId) return [];
  const url =
    `${APIFY_BASE}/datasets/${datasetId}/items` +
    `?clean=true&format=json&limit=${limit}&token=${encodeURIComponent(token)}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const items = await resp.json();
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

// ── Tolerant field extraction ──────────────────────────────────────────────

type AnyRec = Record<string, unknown>;
const rec = (v: unknown): AnyRec => (v && typeof v === 'object' ? (v as AnyRec) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function firstStr(...vals: unknown[]): string {
  for (const v of vals) {
    const s = str(v).trim();
    if (s) return s;
  }
  return '';
}

/** First finite number from the candidates (0 allowed only via explicit check). */
function firstNum(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/**
 * Normalize a Meta Ad Library "start" value (unix seconds, unix ms, or an
 * ISO/date string) into an ISO timestamp string, or '' when unusable.
 */
function toIsoDate(...vals: unknown[]): string {
  // Numeric epoch first (FB usually returns seconds).
  const n = firstNum(...vals);
  if (n !== null && n > 0) {
    const ms = n < 1e12 ? n * 1000 : n; // seconds → ms heuristic
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const s = firstStr(...vals);
  if (s) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return '';
}

export interface MappedAd {
  externalId: string;
  mediaType: 'image' | 'video';
  mediaUrl: string;
  pageName: string;
  headline: string;
  hook: string;
  bodyText: string;
  /** Winner signals from the Ad Library. */
  adStartedAt: string; // ISO, '' when unknown
  adActive: string; // 'true' | 'false' | ''
  adVariants: number; // how many ads are collated under this creative
  /**
   * Spend, as Meta discloses it. Only present for political / social-issue
   * ads; '' for the commercial ads this tool targets. Impressions/reach come
   * from the same disclosure.
   */
  spend: string;
  impressions: string;
  reach: number | null;
}

/** Format a Meta `{ lower_bound, upper_bound }` range (or a plain value). */
function formatRange(v: unknown, currency = ''): string {
  const cur = currency ? `${currency} ` : '';
  const r = rec(v);
  const lo = firstNum(r.lower_bound, r.lowerBound);
  const hi = firstNum(r.upper_bound, r.upperBound);
  if (lo !== null || hi !== null) {
    const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`);
    if (lo !== null && hi !== null) return `${cur}${fmt(lo)}–${fmt(hi)}`;
    if (hi !== null) return `${cur}<${fmt(hi)}`;
    return `${cur}>${fmt(lo as number)}`;
  }
  const s = firstStr(v);
  return s ? `${cur}${s}` : '';
}

/**
 * Normalize one raw Apify item into our creative shape. Returns null when no
 * usable media URL can be found.
 */
export function mapApifyAdItem(raw: unknown): MappedAd | null {
  const r = rec(raw);
  const snap = rec(r.snapshot ?? r.snapshot_v2 ?? r);

  const externalId = firstStr(
    r.adArchiveID, r.ad_archive_id, r.adArchiveId, r.archiveID, r.archive_id,
    r.adId, r.ad_id, r.id, snap.ad_archive_id,
  );

  const pageName = firstStr(r.pageName, r.page_name, snap.page_name, r.advertiserName);

  // Cards (carousel) can hold the richest media/text.
  const cards = arr(snap.cards);
  const card0 = rec(cards[0]);

  const videos = arr(snap.videos ?? r.videos);
  const video0 = rec(videos[0]);
  const images = arr(snap.images ?? r.images);
  const image0 = rec(images[0]);

  const videoUrl = firstStr(
    video0.video_hd_url, video0.video_sd_url, video0.videoHdUrl, video0.videoSdUrl,
    card0.video_hd_url, card0.video_sd_url,
    r.videoUrl, r.video_url, snap.video_hd_url, snap.video_sd_url,
  );
  const imageUrl = firstStr(
    image0.original_image_url, image0.resized_image_url, image0.originalImageUrl,
    card0.original_image_url, card0.resized_image_url,
    r.imageUrl, r.image_url, snap.original_image_url, snap.resized_image_url,
    video0.video_preview_image_url,
  );

  const mediaUrl = videoUrl || imageUrl;
  if (!mediaUrl) return null;
  const mediaType: 'image' | 'video' = videoUrl ? 'video' : 'image';

  const bodyText = firstStr(
    rec(snap.body).text, snap.body, arr(r.ad_creative_bodies)[0],
    card0.body, r.body, r.text,
  );
  const headline = firstStr(
    snap.title, arr(r.ad_creative_link_titles)[0], card0.title, r.title, r.headline,
  );
  const hook = firstStr(
    snap.caption, arr(r.ad_creative_link_captions)[0], card0.caption,
    snap.link_description, r.caption,
  );

  // ── Winner signals ──────────────────────────────────────────────────────
  // How long the ad has been running + whether it's still live are the
  // strongest cheap proxies for "this creative works" (advertisers kill
  // losers fast). Field names vary across actors, so probe several.
  const adStartedAt = toIsoDate(
    r.startDate, r.start_date, r.startDateUnixTime, r.ad_delivery_start_time,
    r.startDateFormatted, snap.start_date, snap.startDate,
  );

  const activeRaw =
    r.isActive ?? r.is_active ?? r.active ?? r.adStatus ?? r.status ?? snap.is_active;
  let adActive = '';
  if (typeof activeRaw === 'boolean') adActive = activeRaw ? 'true' : 'false';
  else {
    const s = str(activeRaw).trim().toLowerCase();
    if (s === 'true' || s === 'active') adActive = 'true';
    else if (s === 'false' || s === 'inactive') adActive = 'false';
  }
  // If no explicit status but there's a start and no end date, treat as active.
  if (!adActive && adStartedAt) {
    const hasEnd = toIsoDate(r.endDate, r.end_date, r.ad_delivery_stop_time, snap.end_date);
    adActive = hasEnd ? 'false' : 'true';
  }

  const adVariants =
    firstNum(r.collationCount, r.collation_count, r.total, r.totalCount, snap.collation_count) ?? 0;

  // ── Spend / reach (disclosed only for political & social-issue ads) ───────
  const currency = firstStr(r.currency, snap.currency);
  const spend = formatRange(r.spend ?? snap.spend, currency).slice(0, 60);
  const impressions = formatRange(r.impressions ?? snap.impressions).slice(0, 60);
  const reach = firstNum(
    r.eu_total_reach, r.euTotalReach, r.total_reach, r.totalReach, r.reach, snap.eu_total_reach,
  );

  return {
    externalId,
    mediaType,
    mediaUrl,
    pageName,
    headline: headline.slice(0, 500),
    hook: hook.slice(0, 500),
    bodyText: bodyText.slice(0, 4000),
    adStartedAt,
    adActive,
    adVariants: Math.max(0, Math.round(adVariants)),
    spend,
    impressions,
    reach: reach !== null && reach > 0 ? Math.round(reach) : null,
  };
}
