/**
 * Collapse near-identical competitor ads so we do not list / analyze the same
 * creative many times. Prefer bytes hash (same image, different storage path),
 * then copy; never treat unique file_path alone as identity.
 */

import { createHash } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';

const BUCKET = 'project-files';

export type FingerprintableAd = {
  id: number | string;
  file_path?: string | null;
  media_url?: string | null;
  media_hash?: string | null;
  headline?: string | null;
  hook?: string | null;
  body_text?: string | null;
  name?: string | null;
  ad_name?: string | null;
  media_type?: string | null;
  is_winner?: boolean | string | null;
  analysis?: { status?: string | null } | null;
  created_at?: string | null;
  impressions?: number | string | null;
};

function fold(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function storagePath(filePath: string): string | null {
  const p = String(filePath || '').split('?')[0].trim();
  if (!p || /^https?:\/\//i.test(p)) return null;
  return p.replace(/^\/+/, '');
}

function copyFingerprint(ad: FingerprintableAd): string | null {
  const copy = fold(
    [ad.headline, ad.hook, ad.body_text, ad.name || ad.ad_name]
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .join('|'),
  );
  if (copy.length < 12) return null;
  let h = 0;
  for (let i = 0; i < copy.length; i++) h = (Math.imul(31, h) + copy.charCodeAt(i)) | 0;
  return `c:${(h >>> 0).toString(36)}:${copy.slice(0, 80)}`;
}

/** Stable key for "same creative" — content hash first, then copy. */
export function creativeFingerprint(ad: FingerprintableAd): string {
  const hash = String(ad.media_hash || '').trim();
  if (hash.length >= 16) return `h:${hash}`;

  const copy = copyFingerprint(ad);
  if (copy) return copy;

  // Last resort: unique per row (do NOT use storage path — re-uploads differ).
  return `id:${ad.id}`;
}

function score(ad: FingerprintableAd): number {
  let s = 0;
  if (ad.analysis?.status === 'ready') s += 1000;
  if (ad.analysis?.status === 'extracting' || ad.analysis?.status === 'pending') s += 100;
  if (ad.is_winner === true || ad.is_winner === 'true') s += 50;
  const imp = Number(ad.impressions) || 0;
  s += Math.min(imp, 1_000_000) / 10_000;
  const t = Date.parse(String(ad.created_at || '')) || 0;
  s += t / 1e13;
  return s;
}

/**
 * Download storage bytes for ads missing media_hash, compute sha256, attach
 * in-memory (and persist when the column exists). Caps work per request.
 */
export async function attachContentHashes<T extends FingerprintableAd>(
  ads: T[],
  opts: { limit?: number; concurrency?: number } = {},
): Promise<T[]> {
  const limit = opts.limit ?? 120;
  const concurrency = opts.concurrency ?? 8;
  const need = ads
    .filter((a) => {
      if (String(a.media_hash || '').trim()) return false;
      if (String(a.media_type || '').includes('video')) return false;
      return Boolean(storagePath(String(a.file_path || '')));
    })
    .slice(0, limit);

  if (!need.length) return ads;

  const hashById = new Map<string, string>();
  let i = 0;
  const worker = async () => {
    while (i < need.length) {
      const ad = need[i++];
      const path = storagePath(String(ad.file_path || ''));
      if (!path) continue;
      try {
        const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(path);
        if (error || !data) continue;
        const buf = Buffer.from(await data.arrayBuffer());
        if (buf.length < 32) continue;
        const hex = sha256Hex(buf);
        hashById.set(String(ad.id), hex);
        // Best-effort persist (ignore if column missing).
        void supabaseAdmin
          .from('competitor_ads')
          .update({ media_hash: hex })
          .eq('id', ad.id)
          .then(() => undefined, () => undefined);
      } catch {
        /* ignore single failures */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, need.length) }, () => worker()));

  if (!hashById.size) return ads;
  return ads.map((a) => {
    const h = hashById.get(String(a.id));
    return h ? { ...a, media_hash: h } : a;
  });
}

/**
 * Keep one row per fingerprint. Prefer already-analyzed / winners.
 * Attaches duplicateCount (siblings collapsed, including self).
 */
export function dedupeCreatives<T extends FingerprintableAd>(ads: T[]): Array<T & { duplicateCount: number }> {
  const groups = new Map<string, T[]>();
  for (const ad of ads) {
    const k = creativeFingerprint(ad);
    const g = groups.get(k) || [];
    g.push(ad);
    groups.set(k, g);
  }
  const out: Array<T & { duplicateCount: number }> = [];
  for (const g of groups.values()) {
    g.sort((a, b) => score(b) - score(a));
    const best = g[0];
    out.push({ ...best, duplicateCount: g.length });
  }
  out.sort((a, b) => score(b) - score(a));
  return out;
}
