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

/** Apify uses `username~actor-name` in the REST path; the store shows
 *  `username/actor-name`. Accept either and normalize. */
function normalizeActorId(slug: string): string {
  return slug.trim().replace('/', '~');
}

export function apifyActorId(): string {
  // Override with APIFY_FB_ADS_ACTOR ("username~actor-name"). Default is a
  // widely-used FB Ad Library scraper.
  return normalizeActorId(process.env.APIFY_FB_ADS_ACTOR || 'curious_coder~facebook-ads-library-scraper');
}

export function apifyTiktokActorId(): string {
  return normalizeActorId(process.env.APIFY_TIKTOK_ADS_ACTOR || 'aiscraperdev~tiktok-ads-library-scraper');
}

export function apifyGoogleActorId(): string {
  return normalizeActorId(process.env.APIFY_GOOGLE_ADS_ACTOR || 'jaybird~google-ads-transparency-scraper');
}

export type AdPlatform = 'meta' | 'tiktok' | 'google';

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

/** Low-level: start any actor with a JSON input + run webhook. */
export async function startActorRun(
  actorId: string,
  input: Record<string, unknown>,
  webhookUrl: string,
): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const token = apifyToken();
  if (!token) return { ok: false, error: 'APIFY_KEY not configured' };

  const url =
    `${APIFY_BASE}/acts/${actorId}/runs` +
    `?token=${encodeURIComponent(token)}` +
    `&webhooks=${encodeURIComponent(webhooksParam(webhookUrl))}`;

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

/**
 * Start a Meta/Facebook Ad Library run for an Ad Library URL. Returns the run id.
 * `webhookUrl` should already carry any context we need back (projectId,
 * platform, brandId, etc.) as query params; Apify appends its own payload.
 */
export async function startAdsLibraryRun(opts: {
  adsLibraryUrl: string;
  count?: number;
  webhookUrl: string;
}): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
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
  return startActorRun(apifyActorId(), input, opts.webhookUrl);
}

/** Start a TikTok Ad Library / Creative Center run for a keyword. */
export async function startTiktokAdsRun(opts: {
  keyword: string;
  country?: string;
  count?: number;
  webhookUrl: string;
}): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  if (!opts.keyword) return { ok: false, error: 'Missing keyword' };
  const count = Math.min(Math.max(opts.count || 20, 1), 200);
  const region = (opts.country || '').trim() || 'all';
  // Tolerant superset across the common TikTok ad-library actors.
  const input: Record<string, unknown> = {
    searchQuery: opts.keyword,
    query: opts.keyword,
    keyword: opts.keyword,
    // Keyword-filtered verified advertisers (EU/UK/TR) → relevant competitors.
    source: 'ad_library',
    region,
    regions: [region],
    countries: [region],
    adType: 'all',
    maxResults: count,
    maxResultsPerQuery: count,
    resultsLimit: count,
    count,
  };
  return startActorRun(apifyTiktokActorId(), input, opts.webhookUrl);
}

/** Start a Google Ads Transparency Center run for a keyword. */
export async function startGoogleAdsRun(opts: {
  keyword: string;
  region?: string;
  count?: number;
  webhookUrl: string;
}): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  if (!opts.keyword) return { ok: false, error: 'Missing keyword' };
  const count = Math.min(Math.max(opts.count || 20, 1), 200);
  const region = (opts.region || '').trim() || 'anywhere';
  // Tolerant superset across the common Google Ads Transparency actors.
  const input: Record<string, unknown> = {
    queries: [opts.keyword],
    searchQuery: opts.keyword,
    searchTargets: [opts.keyword],
    region,
    regions: [region],
    dateRangePreset: 'LAST_30_DAYS',
    adFormat: 'ALL',
    enrichLandingPages: true,
    scrapeDetails: true,
    maxResults: count,
    maxAdsPerTarget: count,
    maxAdvertisersPerKeyword: 8,
  };
  return startActorRun(apifyGoogleActorId(), input, opts.webhookUrl);
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
  /** Destination/landing page URL (mainly from Google Ads Transparency). */
  landingUrl?: string;
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

// ── TikTok Ad Library / Creative Center ─────────────────────────────────────

/**
 * Deep-probe a URL-ish value that may be a plain string, an object keyed by
 * resolution (TikTok `video_url: {360p,540p,720p,1080p}`), an `{url|src|...}`
 * object, or a `urlList` array. Returns the first usable https URL.
 */
function deepUrl(...vals: unknown[]): string {
  for (const v of vals) {
    if (!v) continue;
    if (typeof v === 'string') {
      if (/^https?:\/\//i.test(v)) return v;
      continue;
    }
    const o = rec(v);
    const known = firstStr(
      o.url, o.src, o.downloadAddr, o.playAddr, o.play_url, o.download_url,
      o['1080p'], o['720p'], o['540p'], o['360p'], o.hd, o.sd,
    );
    if (known && /^https?:\/\//i.test(known)) return known;
    const list = arr(o.urlList ?? o.url_list);
    if (list.length) {
      const u = firstStr(...list);
      if (u && /^https?:\/\//i.test(u)) return u;
    }
    // Last resort: any string value that looks like an https URL.
    for (const val of Object.values(o)) {
      if (typeof val === 'string' && /^https?:\/\//i.test(val)) return val;
    }
  }
  return '';
}

/** Map one TikTok ad-library / creative-center item into our creative shape.
 *  Matches the aiscraperdev actor's snake_case schema (video_url object for
 *  Creative Center, cover_image_url for Ad Library) plus tolerant fallbacks. */
export function mapTiktokAdItem(raw: unknown): MappedAd | null {
  const r = rec(raw);
  const video = r.video_url ?? r.videoUrl ?? r.video ?? r.videoInfo;

  const advertiser = firstStr(
    r.advertiser_name, r.advertiserName, r.advertiser, r.brandName, r.brand,
    r.pageName, r.author, rec(r.advertiser).name, rec(r.brand).name,
  );
  const externalId = firstStr(r.ad_id, r.adId, r.id, r.creativeId, r.itemId);

  const videoUrl = deepUrl(video, r.playAddr, r.downloadAddr, r.playUrl, r.videoUrlNoWaterMark);
  const imageUrl = deepUrl(
    r.cover_image_url, r.coverImageUrl, r.coverUrl, r.cover, r.imageUrl, r.image,
    r.thumbnail, r.thumbnailUrl, r.videoCoverUrl, r.originCover,
  );
  const mediaUrl = videoUrl || imageUrl;
  if (!mediaUrl) return null;

  const bodyText = firstStr(r.ad_text, r.adText, r.text, r.caption, r.description, r.desc);
  const headline = firstStr(r.title, r.adTitle, r.headline, r.name);
  const landingUrl = firstStr(
    r.landing_page_url, r.landingPageUrl, r.landingUrl, r.clickUrl, r.destinationUrl,
  );

  return {
    externalId,
    mediaType: videoUrl ? 'video' : 'image',
    mediaUrl,
    pageName: advertiser || 'TikTok advertiser',
    headline: headline.slice(0, 500),
    hook: '',
    bodyText: bodyText.slice(0, 4000),
    adStartedAt: toIsoDate(r.first_shown_date, r.firstShownDate, r.firstShown, r.startDate),
    adActive: '',
    adVariants: 0,
    spend: '',
    impressions: firstStr(r.estimatedAudience, r.impressions).slice(0, 60),
    reach: null,
    landingUrl: landingUrl || undefined,
  };
}

// ── Google Ads Transparency Center ──────────────────────────────────────────

/** Map one Google Ads Transparency item into our creative shape. */
export function mapGoogleAdItem(raw: unknown): MappedAd | null {
  const r = rec(raw);
  const advertiser = firstStr(
    r.advertiserName, r.advertiser_name, r.advertiser, r.brand, r.brandName,
    rec(r.advertiser).name,
  );
  const externalId = firstStr(r.creativeId, r.creative_id, r.adId, r.ad_id, r.id);
  const format = firstStr(r.adFormat, r.ad_format, r.format, r.type, r.creativeType).toLowerCase();

  const videoUrl = deepUrl(
    r.videoUrl, r.video_url, r.video, r.youtubeUrl, r.youtube_url, r.mp4Url,
    format.includes('video') ? (r.previewUrl ?? r.preview_url) : '',
  );
  const imageUrl = deepUrl(
    r.imageUrl, r.image_url, r.image, r.thumbnailUrl, r.thumbnail_url, r.thumbnail,
    !format.includes('video') ? (r.previewUrl ?? r.preview_url) : '',
  );
  const mediaUrl = videoUrl || imageUrl;

  const landingUrl = firstStr(
    r.landingPageUrl, r.landing_page_url, r.landingUrl, r.destinationUrl, r.destination_url,
    r.finalUrl, r.final_url, r.clickUrl, r.adUrl, r.ad_url, rec(r.landingPage).url,
  );

  const headline = firstStr(r.headline, r.title, r.text, r.body).slice(0, 500);
  const bodyText = firstStr(r.text, r.body, r.description).slice(0, 4000);
  const adStartedAt = toIsoDate(r.firstShown, r.first_shown, r.firstShownDate, r.startDate);

  // Text-only ads have no media but still carry a landing page — return them
  // with an empty mediaUrl handled by the caller (used for landing capture).
  if (!mediaUrl) {
    if (!landingUrl) return null;
    return {
      externalId, mediaType: 'image', mediaUrl: '', pageName: advertiser || 'Google advertiser',
      headline, hook: '', bodyText, adStartedAt,
      adActive: '', adVariants: 0, spend: '', impressions: '', reach: null, landingUrl,
    };
  }

  return {
    externalId,
    mediaType: videoUrl ? 'video' : 'image',
    mediaUrl,
    pageName: advertiser || 'Google advertiser',
    headline,
    hook: '',
    bodyText,
    adStartedAt,
    adActive: '',
    adVariants: 0,
    spend: '',
    impressions: '',
    reach: null,
    landingUrl: landingUrl || undefined,
  };
}

/** Pick the right mapper for a platform. */
export function mapperForPlatform(platform: AdPlatform): (raw: unknown) => MappedAd | null {
  if (platform === 'tiktok') return mapTiktokAdItem;
  if (platform === 'google') return mapGoogleAdItem;
  return mapApifyAdItem;
}
