/**
 * Browser-side fill of Image landings.
 *
 * The server extract often misses HTML (page_id mismatch) or gets blocked
 * by CDNs. Here we use the same html_url the Landings preview already
 * loads, then ask the server to download each asset. If that fails, we
 * try fetching the image in the browser (CORS-ok CDNs) and upload bytes.
 */

import {
  collectLandingAssetUrls,
  isJunkLandingHost,
  type LandingMediaItem,
} from '@/lib/landing-media';

export type LandingFillResult = {
  items: LandingMediaItem[];
  saved: number;
  skipped: number;
  pages: number;
  found: number;
  downloadFailed: number;
  uploadFailed: number;
  error?: string;
};

type LandingRow = { url?: string; html_url?: string };

function asItems(data: unknown): LandingMediaItem[] {
  if (Array.isArray(data)) return data as LandingMediaItem[];
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: LandingMediaItem[] }).items;
  }
  return [];
}

async function listItems(projectId: string): Promise<LandingMediaItem[]> {
  const r = await fetch(`/api/projecthub/projects/${projectId}/landing-media`);
  if (!r.ok) return [];
  return asItems(await r.json().catch(() => []));
}

const inflight = new Map<string, Promise<LandingFillResult>>();

export function landingFillError(r: LandingFillResult): string | undefined {
  if (r.items.length) return undefined;
  if (r.error) return r.error;
  if (!r.pages) return 'Could not read the HTML of the saved landings';
  if (!r.found) return 'Saved landings have no photos, GIFs or videos in the HTML';
  if (r.downloadFailed || r.uploadFailed) {
    return `Found ${r.found} assets but could not download the files (${r.downloadFailed} blocked, ${r.uploadFailed} upload failed)`;
  }
  return 'No photos downloaded from the saved landings';
}

async function fillLandingLibraryOnce(
  projectId: string,
  opts?: { force?: boolean },
): Promise<LandingFillResult> {
  const empty: LandingFillResult = {
    items: [],
    saved: 0,
    skipped: 0,
    pages: 0,
    found: 0,
    downloadFailed: 0,
    uploadFailed: 0,
  };

  if (!opts?.force) {
    const existing = await listItems(projectId);
    if (existing.length) return { ...empty, items: existing };
  }

  const lr = await fetch(`/api/projecthub/projects/${projectId}/landings`);
  const landings = (lr.ok ? await lr.json().catch(() => []) : []) as LandingRow[];
  if (!Array.isArray(landings) || !landings.length) {
    return { ...empty, error: 'No competitor landings saved on this project' };
  }

  let items: LandingMediaItem[] = [];
  for (const landing of landings.slice(0, 12)) {
    if (isJunkLandingHost(landing.url || '')) continue;
    if (!landing.html_url) continue;
    const htmlRes = await fetch(landing.html_url);
    if (!htmlRes.ok) continue;
    const html = await htmlRes.text();
    if (html.length < 30) continue;
    empty.pages++;
    empty.found += collectLandingAssetUrls(html, landing.url || '').length;

    const post = await fetch(`/api/projecthub/projects/${projectId}/landing-media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, pageUrl: landing.url || '' }),
    });
    const data = (await post.json().catch(() => ({}))) as Record<string, unknown>;
    empty.saved += Number(data.saved || 0);
    empty.skipped += Number(data.skipped || 0);
    empty.downloadFailed += Number(data.downloadFailed || 0);
    empty.uploadFailed += Number(data.uploadFailed || 0);
    const next = asItems(data);
    if (next.length) items = next;
  }

  if (items.length) return { ...empty, items };

  // Browser download fallback — works when the CDN allows CORS from this origin.
  for (const landing of landings.slice(0, 8)) {
    if (isJunkLandingHost(landing.url || '')) continue;
    if (!landing.html_url) continue;
    const htmlRes = await fetch(landing.html_url);
    if (!htmlRes.ok) continue;
    const html = await htmlRes.text();
    const assets = collectLandingAssetUrls(html, landing.url || '');
    for (const asset of assets.slice(0, 12)) {
      try {
        const img = await fetch(asset.url, { mode: 'cors' });
        if (!img.ok) continue;
        const blob = await img.blob();
        if (blob.size < 80) continue;
        const fd = new FormData();
        const name = asset.url.split('/').pop()?.split('?')[0] || `${asset.kind}.bin`;
        fd.append('file', blob, name);
        fd.append('sourceUrl', asset.url);
        fd.append('kind', asset.kind);
        fd.append('section', asset.section);
        const put = await fetch(`/api/projecthub/projects/${projectId}/landing-media`, {
          method: 'PUT',
          body: fd,
        });
        const data = (await put.json().catch(() => ({}))) as Record<string, unknown>;
        if (put.ok) {
          empty.saved += Number(data.saved || 1);
          const next = asItems(data);
          if (next.length) items = next;
        }
      } catch {
        /* CORS or network — skip */
      }
    }
  }

  if (!items.length) items = await listItems(projectId);
  return { ...empty, items, error: items.length ? undefined : landingFillError(empty) };
}

export function fillLandingLibrary(
  projectId: string,
  opts?: { force?: boolean },
): Promise<LandingFillResult> {
  const key = `${projectId}:${opts?.force ? 'force' : 'auto'}`;
  const running = inflight.get(key);
  if (running) return running;
  const pending = fillLandingLibraryOnce(projectId, opts).finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}
