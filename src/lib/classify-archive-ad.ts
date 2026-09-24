/**
 * Auto-file a captured creative into Template → Ads:
 *   Image / Video / Carousel / UGC / Story
 * plus a few English tags (format, platform, copy cues).
 *
 * Used by the AdSpends bulk importer and by "Upload & auto-sort".
 */

export type ArchiveAdKind = 'image' | 'video' | 'carousel' | 'ugc' | 'story';

export type ClassifyArchiveAdInput = {
  mediaType?: 'image' | 'video' | string;
  width?: number;
  height?: number;
  name?: string;
  text?: string;
  headline?: string;
  pageUrl?: string;
  pageTitle?: string;
  carousel?: boolean;
};

export type ClassifyArchiveAdResult = {
  ad_type: ArchiveAdKind;
  media_type: 'image' | 'video';
  category: string;
  tags: string[];
};

/** Strip CDN cache-busters so the same creative hashes the same on re-import. */
export function canonicalizeMediaUrl(raw: string): string {
  try {
    const u = new URL(String(raw || '').trim());
    if (!/^https?:$/i.test(u.protocol)) return '';
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    return `${u.protocol}//${host}${path}`.toLowerCase();
  } catch {
    return String(raw || '')
      .split('?')[0]
      .replace(/\/+$/, '')
      .toLowerCase();
  }
}

/** Portable djb2 — must match the copy in extension/popup.js. */
export function sourceFingerprint(url: string): string {
  const s = canonicalizeMediaUrl(url);
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) + h + s.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function sourceTag(url: string): string {
  return `src:${sourceFingerprint(url)}`;
}

export function parseSourceFingerprintFromTags(tags: string): string | null {
  const m = String(tags || '').match(/\bsrc:([0-9a-f]{8})\b/i);
  return m ? m[1].toLowerCase() : null;
}

function uniqueTags(list: string[], max = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const tag = String(raw || '')
      .trim()
      .replace(/^#/, '')
      .slice(0, 40);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

function slugCategory(raw: string): string {
  return String(raw || '')
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

export function categoryFromPage(pageUrl?: string, pageTitle?: string): string {
  try {
    const u = new URL(String(pageUrl || ''));
    for (const key of ['category', 'niche', 'board', 'offer', 'vertical', 'geo']) {
      const v = u.searchParams.get(key);
      if (v && v.trim()) return slugCategory(v);
    }
  } catch {
    /* ignore */
  }
  const title = String(pageTitle || '').trim();
  const cut = title.split(/\s+[—–\-|]\s+/).pop() || '';
  if (cut && cut.length >= 3 && cut.length <= 40 && !/adspend|adspy|dashboard/i.test(cut)) {
    return slugCategory(cut);
  }
  return '';
}

function keywordTags(blob: string): string[] {
  const tags: string[] = [];
  if (/\btiktok\b|\btt\b/.test(blob)) tags.push('tiktok');
  else if (/\binstagram\b|\breels?\b/.test(blob)) tags.push('instagram');
  else if (/\byoutube\b|\bshorts?\b/.test(blob)) tags.push('youtube');
  else if (/\bmeta\b|\bfacebook\b|\bfb\b|\bfbcdn\b/.test(blob)) tags.push('meta');
  if (/\btestimonial\b|\breview\b|\bsocial proof\b/.test(blob)) tags.push('testimonial');
  if (/\bbefore.?after\b|\btransformation\b/.test(blob)) tags.push('before-after');
  if (/\bunboxing\b/.test(blob)) tags.push('unboxing');
  if (/\bhook\b/.test(blob)) tags.push('hook');
  if (/\bvsl\b|\bvideo sales\b/.test(blob)) tags.push('vsl');
  if (/\bugc\b|\bcreator\b|\binfluencer\b/.test(blob)) tags.push('ugc');
  return tags;
}

export function classifyArchiveAd(input: ClassifyArchiveAdInput): ClassifyArchiveAdResult {
  const name = String(input.name || '');
  const text = String(input.text || '');
  const headline = String(input.headline || '');
  const blob = `${name} ${headline} ${text} ${input.pageUrl || ''} ${input.pageTitle || ''}`.toLowerCase();
  const w = Number(input.width) || 0;
  const h = Number(input.height) || 0;
  const ratio = w > 0 && h > 0 ? w / h : 0;
  const vertical = ratio > 0 && ratio <= 0.72;
  const square = ratio >= 0.85 && ratio <= 1.15;
  const landscape = ratio >= 1.4;

  const urlLooksVideo = /\.(mp4|webm|mov|m4v)(\?|$)/i.test(name) || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(String(input.pageUrl || ''));
  const isVideo = input.mediaType === 'video' || urlLooksVideo;

  const tags: string[] = [];
  if (isVideo) tags.push('video');
  else tags.push('image');
  if (vertical) tags.push('vertical');
  else if (square) tags.push('square');
  else if (landscape) tags.push('landscape');
  tags.push(...keywordTags(blob));

  let ad_type: ArchiveAdKind = isVideo ? 'video' : 'image';
  const carouselCue = Boolean(input.carousel) || /\bcarousel\b|\bcarosello\b|\bcatalog\b|\bcollection\b|\bmulti.?image\b|\bdossier\b/.test(blob);
  const ugcCue = /\bugc\b|\bselfie\b|\btalking.?head\b|\bcreator\b|\binfluencer\b|\breaction\b|\btestimonial\b|\bunboxing\b/.test(blob);
  const storyCue = /\bstory\b|\bstories\b|\breels?\b|\b9\s*[:/]\s*16\b|\b9x16\b/.test(blob);

  if (carouselCue) {
    ad_type = 'carousel';
    tags.push('carousel');
  } else if (ugcCue) {
    ad_type = 'ugc';
    tags.push('ugc');
  } else if (storyCue || (vertical && isVideo)) {
    ad_type = 'story';
    tags.push('story');
  } else if (vertical && !isVideo) {
    ad_type = 'story';
    tags.push('story');
  }

  if (/adspend/i.test(String(input.pageUrl || '')) || /adspend/i.test(String(input.pageTitle || ''))) {
    tags.push('adspends');
  }

  return {
    ad_type,
    media_type: isVideo ? 'video' : 'image',
    category: categoryFromPage(input.pageUrl, input.pageTitle),
    tags: uniqueTags(tags),
  };
}
