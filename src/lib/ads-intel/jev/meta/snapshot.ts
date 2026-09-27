import { fbToken } from './graph';
import { fetchRetry, HttpError } from '../retry';

export type SnapshotMedia = { videos: string[]; images: string[] };

const unescape = (s: string) => s.replace(/\\\//g, '/').replace(/\\u0025/g, '%').replace(/&amp;/g, '&');

/**
 * Recupera gli URL dei media dalla pagina di snapshot dell'ad (best effort: la Library API non restituisce i file).
 * Se non trova nulla, il media si può caricare a mano dalla scheda della creatività.
 */
export async function fetchSnapshotMedia(snapshotUrl: string): Promise<SnapshotMedia> {
  const url = new URL(snapshotUrl);
  if (!url.searchParams.get('access_token')) url.searchParams.set('access_token', await fbToken());
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/126 Safari/537.36', 'Accept-Language': 'en-US' } });
  if (!res.ok) throw new Error(`Snapshot ${res.status}`);
  const html = await res.text();
  const grab = (re: RegExp) => [...html.matchAll(re)].map((m) => unescape(m[1]));
  const videos = [...new Set([...grab(/"video_hd_url":"([^"]+)"/g), ...grab(/"video_sd_url":"([^"]+)"/g), ...grab(/<video[^>]+src="([^"]+)"/g)])];
  const images = [...new Set([...grab(/"original_image_url":"([^"]+)"/g), ...grab(/"resized_image_url":"([^"]+)"/g), ...grab(/"video_preview_image_url":"([^"]+)"/g)])];
  // preferisci HD: tieni un solo video per creatività (il primo), tutte le immagini distinte per i caroselli
  return { videos: videos.slice(0, 1), images: videos.length ? images.slice(0, 1) : images.slice(0, 10) };
}

export async function download(url: string): Promise<{ buf: Buffer; contentType: string }> {
  const res = await fetchRetry(url);
  if (!res.ok) throw new HttpError(`Download media ${res.status}`, res.status);
  return { buf: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}
