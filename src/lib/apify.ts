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

export interface MappedAd {
  externalId: string;
  mediaType: 'image' | 'video';
  mediaUrl: string;
  pageName: string;
  headline: string;
  hook: string;
  bodyText: string;
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

  return {
    externalId,
    mediaType,
    mediaUrl,
    pageName,
    headline: headline.slice(0, 500),
    hook: hook.slice(0, 500),
    bodyText: bodyText.slice(0, 4000),
  };
}
