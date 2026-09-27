/**
 * Collapse near-identical competitor ads so we do not list / analyze the same
 * creative many times (same media path or same copy).
 */

export type FingerprintableAd = {
  id: number | string;
  file_path?: string | null;
  media_url?: string | null;
  headline?: string | null;
  hook?: string | null;
  body_text?: string | null;
  name?: string | null;
  ad_name?: string | null;
  is_winner?: boolean | string | null;
  analysis?: { status?: string | null } | null;
  created_at?: string | null;
  impressions?: number | string | null;
};

function fold(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Stable key for "same creative" — prefer media path, else copy. */
export function creativeFingerprint(ad: FingerprintableAd): string {
  const media = String(ad.file_path || ad.media_url || '')
    .split('?')[0]
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .trim();
  if (media.length >= 8) return `m:${media}`;

  const copy = fold(
    [ad.headline, ad.hook, ad.body_text, ad.name || ad.ad_name]
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .join('|'),
  );
  if (copy.length >= 12) {
    // cheap stable hash
    let h = 0;
    for (let i = 0; i < copy.length; i++) h = (Math.imul(31, h) + copy.charCodeAt(i)) | 0;
    return `c:${(h >>> 0).toString(36)}:${copy.slice(0, 80)}`;
  }
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
