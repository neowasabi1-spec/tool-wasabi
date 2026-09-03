/**
 * Competitor landing media — images / GIFs / videos pulled out of saved
 * Competitor Library landings and reused by Chimera swipe.
 *
 * Stored as project_files rows with file_type = 'landing_media'
 * (original_name = "kind|sourceUrl") so no extra table is required.
 */

export const LANDING_MEDIA_TYPE = 'landing_media';

export type LandingMediaKind = 'image' | 'gif' | 'video';

export const LANDING_SECTIONS = [
  'hero',
  'product',
  'lifestyle',
  'mechanism',
  'benefits',
  'ingredients',
  'testimonials',
  'comparison',
  'offer',
  'guarantee',
  'faq',
  'video',
  'other',
] as const;

export type LandingSection = (typeof LANDING_SECTIONS)[number];

export const LANDING_SECTION_LABEL: Record<LandingSection, string> = {
  hero: 'Hero',
  product: 'Product',
  lifestyle: 'Lifestyle',
  mechanism: 'How it works',
  benefits: 'Benefits',
  ingredients: 'Ingredients',
  testimonials: 'Testimonials',
  comparison: 'Comparison',
  offer: 'Offer',
  guarantee: 'Guarantee',
  faq: 'FAQ',
  video: 'Video',
  other: 'Other',
};

export type LandingMediaItem = {
  id: number | string;
  kind: LandingMediaKind;
  section: LandingSection;
  sourceUrl: string;
  storedUrl: string;
  filePath: string;
  name: string;
  /** Character offset on the source landing HTML — first photo = first slot. */
  position?: number;
};

const SECTION_RULES: Array<{ section: LandingSection; re: RegExp }> = [
  { section: 'hero', re: /\b(hero|banner|jumbotron|masthead|above[-_ ]?fold|first[-_ ]?screen|splash)\b/i },
  { section: 'testimonials', re: /\b(testimonial|reviews?|rating|stars?|customer[-_ ]?(said|love)|ugc)\b/i },
  { section: 'ingredients', re: /\b(ingredient|formula|composition|what'?s inside|actives?)\b/i },
  { section: 'mechanism', re: /\b(how[-_ ]?it[-_ ]?works|mechanism|science|why[-_ ]?it|process|steps?)\b/i },
  { section: 'comparison', re: /\b(compar|versus|\bvs\b|before[-_ ]?after|beforeafter|split[-_ ]?frame)\b/i },
  { section: 'guarantee', re: /\b(guarantee|refund|money[-_ ]?back|risk[-_ ]?free|warranty)\b/i },
  { section: 'faq', re: /\b(faq|questions?|answers?)\b/i },
  { section: 'offer', re: /\b(offer|checkout|buy[-_ ]?now|add[-_ ]?to[-_ ]?cart|price|bundle|order|cta|call[-_ ]?to[-_ ]?action)\b/i },
  { section: 'benefits', re: /\b(benefit|feature|advantage|results?|transform)\b/i },
  { section: 'product', re: /\b(product|packshot|bottle|jar|box|device|mockup|packaging)\b/i },
  { section: 'lifestyle', re: /\b(lifestyle|people|woman|man|using|in[-_ ]?use|portrait)\b/i },
  { section: 'video', re: /\b(video|vsl|wistia|vimeo|youtube|player)\b/i },
];

const RELATED_SECTIONS: Record<LandingSection, LandingSection[]> = {
  hero: ['product', 'lifestyle', 'video'],
  product: ['hero', 'lifestyle', 'offer'],
  lifestyle: ['product', 'hero', 'testimonials'],
  mechanism: ['benefits', 'product'],
  benefits: ['mechanism', 'product'],
  ingredients: ['product', 'mechanism'],
  testimonials: ['lifestyle', 'guarantee'],
  comparison: ['product', 'benefits'],
  offer: ['product', 'hero', 'guarantee'],
  guarantee: ['offer', 'testimonials'],
  faq: ['guarantee', 'offer'],
  video: ['hero', 'product'],
  other: [],
};

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

const JUNK_LANDING_HOSTS = /^(google\.com|google\.[a-z.]+|facebook\.com|fb\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|x\.com|twitter\.com|bing\.com)$/i;

/** Icons, stars, payment marks — not product photos. */
export const DECORATIVE_MEDIA =
  /logo|icon|favicon|sprite|pixel|1x1|tracking|analytics|badge|seal|award|star[s]?|rating|payment|visa|mastercard|amex|paypal|klarna|apple-?pay|g-?pay|emoji|loader|spinner|spacer|blank\.|placeholder|trustpilot|cookie|checkmark|greentick|arrow|play-btn|close-btn|hamburger|social|whatsapp|pinterest/i;

export function isDecorativeMedia(...parts: Array<string | undefined | null>): boolean {
  return parts.some((p) => !!p && DECORATIVE_MEDIA.test(p));
}

export function isJunkLandingHost(url: string): boolean {
  const host = hostOfUrl(url);
  return !host || JUNK_LANDING_HOSTS.test(host);
}

/** True when this file came from the same offer page (not another product). */
export function mediaBelongsToPage(
  item: { sourceUrl: string; name?: string },
  html: string,
  pageUrl = '',
): boolean {
  if (item.sourceUrl && html.includes(item.sourceUrl)) return true;
  const pageHost = hostOfUrl(pageUrl);
  const srcHost = hostOfUrl(item.sourceUrl);
  if (pageHost && srcHost && pageHost === srcHost) return true;
  const file = (item.name || item.sourceUrl.split('/').pop()?.split('?')[0] || '').trim();
  if (file && file.length > 4 && html.includes(file)) return true;
  return false;
}

const OFFER_HOST_HINT = /hinuki|readwellness|trkscaling|jelly.?stick|fnel\.ai/i;

function fold(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

/**
 * Photos to paint onto the funnel: downloaded files from THIS offer,
 * not Google and not a mashup of every other brand in the library.
 */
export function pickOfferLandingMedia<T extends { storedUrl: string; sourceUrl: string; name?: string }>(
  items: T[],
  productName = '',
): T[] {
  const downloaded = items.filter((m) => m.storedUrl && !isJunkLandingHost(m.sourceUrl));
  if (downloaded.length <= 1) return downloaded;
  const product = fold(productName).replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = product.split(/\s+/).filter((t) => t.length >= 5);
  const scored = downloaded.map((m) => {
    const hay = fold(`${m.sourceUrl} ${m.name || ''}`);
    let score = 1;
    if (OFFER_HOST_HINT.test(m.sourceUrl)) score += 8;
    for (const t of tokens) if (hay.includes(t)) score += 3;
    return { m, score };
  });
  const best = Math.max(...scored.map((s) => s.score));
  const picked = scored.filter((s) => s.score >= Math.max(4, best - 3)).map((s) => s.m);
  return sortLandingMediaAsOnPage(picked.length >= 3 ? picked : downloaded);
}

export function isLandingSection(v: string): v is LandingSection {
  return (LANDING_SECTIONS as readonly string[]).includes(v);
}

/** Guess the landing block an asset sat in, from nearby markup + copy. */
export function inferLandingSection(
  blob: string,
  opts?: { positionRatio?: number; kind?: LandingMediaKind },
): LandingSection {
  const text = String(blob || '').slice(0, 4000);
  if (opts?.kind === 'video') {
    const hit = SECTION_RULES.find((r) => r.section !== 'video' && r.re.test(text));
    return hit?.section || 'video';
  }
  for (const rule of SECTION_RULES) {
    if (rule.re.test(text)) return rule.section;
  }
  const ratio = opts?.positionRatio;
  if (typeof ratio === 'number') {
    if (ratio < 0.14) return 'hero';
    if (ratio > 0.82) return 'offer';
  }
  return 'other';
}

export function sectionFromNearbyHtml(
  html: string,
  index: number,
  tag = '',
  opts?: { kind?: LandingMediaKind },
): LandingSection {
  const from = Math.max(0, index - 1400);
  const to = Math.min(html.length, index + tag.length + 500);
  const chunk = html.slice(from, to);
  const ids = [...chunk.matchAll(/\b(?:id|class|data-section|data-name|aria-label)\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .join(' ');
  const headings = [...chunk.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' '))
    .join(' ');
  const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] || '';
  const text = chunk
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const ratio = html.length ? index / html.length : 0;
  return inferLandingSection(`${ids} ${headings} ${alt} ${text}`, { positionRatio: ratio, kind: opts?.kind });
}

const CONTENT_SECTIONS: LandingSection[] = [
  'hero', 'product', 'lifestyle', 'mechanism', 'benefits', 'offer', 'comparison',
];

function isContentSection(s: LandingSection): boolean {
  return CONTENT_SECTIONS.includes(s) || s === 'other';
}

/** Same role as on the offer landing: hero→hero, product→product, in landing order. */
export function matchLandingMediaToSlots<S extends { section: LandingSection; src?: string; alt?: string }>(
  slots: S[],
  media: LandingMediaItem[],
  used: Set<string>,
): Array<{ slot: S; item: LandingMediaItem | null }> {
  const pool = sortLandingMediaAsOnPage(
    media.filter((m) => !used.has(String(m.id)) && !isDecorativeMedia(m.sourceUrl, m.name, m.storedUrl)),
  );
  const take = (pred: (m: LandingMediaItem) => boolean): LandingMediaItem | null => {
    const found = pool.find((m) => !used.has(String(m.id)) && pred(m));
    if (!found) return null;
    used.add(String(found.id));
    return found;
  };
  const out: Array<{ slot: S; item: LandingMediaItem | null }> = slots.map((slot) => {
    if (isDecorativeMedia(slot.src, slot.alt)) return { slot, item: null };
    const exact =
      slot.section !== 'other'
        ? take((m) => m.section === slot.section && m.section !== 'other')
        : null;
    return { slot, item: exact };
  });
  for (const row of out) {
    if (row.item) continue;
    if (isDecorativeMedia(row.slot.src, row.slot.alt)) continue;
    const related = RELATED_SECTIONS[row.slot.section] || [];
    row.item = take((m) => related.includes(m.section));
  }
  // Only leftover CONTENT slots get leftover content photos — never dump
  // a testimonial into the hero or a packshot onto a star rating.
  for (const row of out) {
    if (row.item) continue;
    if (!isContentSection(row.slot.section)) continue;
    if (isDecorativeMedia(row.slot.src, row.slot.alt)) continue;
    row.item = take((m) => isContentSection(m.section));
  }
  return out;
}

function landingMediaOrderKey(
  m: { sourceUrl: string; name?: string; position?: number },
  html = '',
): number {
  if (typeof m.position === 'number' && Number.isFinite(m.position)) return m.position;
  if (!html) return 1e15;
  if (m.sourceUrl) {
    const exact = html.indexOf(m.sourceUrl);
    if (exact >= 0) return exact;
    const path = m.sourceUrl.split('?')[0];
    if (path.length > 12) {
      const atPath = html.indexOf(path);
      if (atPath >= 0) return atPath;
    }
  }
  const file = (m.name || m.sourceUrl.split('/').pop()?.split('?')[0] || '').trim();
  if (file.length > 4) {
    const atFile = html.indexOf(file);
    if (atFile >= 0) return atFile;
  }
  return 1e15;
}

/** Keep library order identical to the offer landing, not download time. */
export function sortLandingMediaAsOnPage<T extends { sourceUrl: string; name?: string; position?: number }>(
  items: T[],
  html = '',
): T[] {
  if (items.length < 2) return items;
  return [...items].sort((a, b) => landingMediaOrderKey(a, html) - landingMediaOrderKey(b, html));
}

/** Same order as the landing: 1st photo → 1st slot, 2nd → 2nd. No section scramble. */
export function matchLandingMediaInOrder<S>(
  slots: S[],
  media: LandingMediaItem[],
  used: Set<string>,
): Array<{ slot: S; item: LandingMediaItem | null }> {
  const unused = sortLandingMediaAsOnPage(media.filter((m) => !used.has(String(m.id))));
  return slots.map((slot, i) => {
    const item = unused[i] || null;
    if (item) used.add(String(item.id));
    return { slot, item };
  });
}

type Sb = {
  from: (table: string) => any;
  storage: { from: (bucket: string) => any; createBucket?: (...args: any[]) => any };
};

let bucketReady = false;

async function ensureBucket(sb: Sb): Promise<void> {
  if (bucketReady) return;
  try {
    await sb.storage.createBucket?.(BUCKET, { public: true, fileSizeLimit: 52_428_800 });
  } catch {
    /* exists */
  }
  bucketReady = true;
}

async function resolveOwnerUserId(sb: Sb, projectId: string, given?: string | null): Promise<string | null> {
  if (given) return given;
  const { data } = await sb.from('projects').select('owner_user_id').eq('id', projectId).maybeSingle();
  return typeof data?.owner_user_id === 'string' ? data.owner_user_id : null;
}

function pageIdFromHtmlUrl(raw: string): string {
  const s = String(raw || '');
  if (!s) return '';
  try {
    return new URL(s, 'https://wasabi.local').searchParams.get('pageId') || '';
  } catch {
    return '';
  }
}

const BUCKET = 'project-files';
const MAX_PER_PAGE = 24;
const MAX_PER_RUN = 60;
const MAX_BYTES: Record<LandingMediaKind, number> = {
  image: 8_000_000,
  gif: 12_000_000,
  video: 22_000_000,
};

const JUNK_RE = DECORATIVE_MEDIA;

function absolutize(src: string, pageUrl: string): string {
  const s = String(src || '').trim();
  if (!s || s.startsWith('data:') || s.startsWith('blob:')) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  if (!pageUrl) return '';
  try {
    return new URL(s, pageUrl).href;
  } catch {
    return '';
  }
}

export function classifyLandingAsset(url: string): LandingMediaKind | null {
  const u = url.split('#')[0].split('?')[0].toLowerCase();
  if (/\.(svg|ico|woff2?|ttf|eot)(\b|$)/.test(u)) return null;
  if (/\.(mp4|webm|mov|m4v|ogv)(\b|$)/.test(u) || /\/video\//i.test(u)) return 'video';
  if (/\.gif(\b|$)/.test(u)) return 'gif';
  if (/\.(jpe?g|png|webp|avif|bmp)(\b|$)/.test(u)) return 'image';
  if (/\.(mp3|wav|m4a|aac)(\b|$)/.test(u)) return null;
  // CDN paths without an extension — treat as image if it looks like one.
  if (/\/(image|img|media|cdn|uploads|wp-content|assets)\//i.test(u)) return 'image';
  return null;
}

function pushAsset(
  out: Array<{ url: string; kind: LandingMediaKind; section: LandingSection; position: number }>,
  seen: Set<string>,
  raw: string,
  pageUrl: string,
  html: string,
  index: number,
  tag = '',
) {
  const abs = absolutize(raw, pageUrl);
  if (!abs || seen.has(abs) || JUNK_RE.test(abs)) return;
  const kind = classifyLandingAsset(abs);
  if (!kind) return;
  seen.add(abs);
  out.push({
    url: abs,
    kind,
    section: sectionFromNearbyHtml(html, index, tag, { kind }),
    position: index,
  });
}

function largestSrcset(srcset: string): string {
  const parts = srcset.split(',').map((p) => p.trim()).filter(Boolean);
  let best = '';
  let bestW = -1;
  for (const p of parts) {
    const [u, w] = p.split(/\s+/);
    const n = parseInt(String(w || '').replace(/[^\d]/g, ''), 10) || 0;
    if (n >= bestW && u) {
      bestW = n;
      best = u;
    }
  }
  return best || (parts[0] || '').split(/\s+/)[0] || '';
}

/** Pull image / gif / video URLs out of a landing HTML document, with section. */
export function collectLandingAssetUrls(
  html: string,
  pageUrl: string,
): Array<{ url: string; kind: LandingMediaKind; section: LandingSection; position: number }> {
  const out: Array<{ url: string; kind: LandingMediaKind; section: LandingSection; position: number }> = [];
  const seen = new Set<string>();
  const h = String(html || '');
  if (!h) return out;

  const attrRe = /\b(?:src|data-src|data-lazy-src|poster)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(h)) !== null) {
    pushAsset(out, seen, m[1], pageUrl, h, m.index, m[0]);
  }

  const srcsetRe = /\bsrcset\s*=\s*["']([^"']+)["']/gi;
  while ((m = srcsetRe.exec(h)) !== null) {
    pushAsset(out, seen, largestSrcset(m[1]), pageUrl, h, m.index, m[0]);
  }

  const cssRe = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;
  while ((m = cssRe.exec(h)) !== null) {
    pushAsset(out, seen, m[1], pageUrl, h, m.index, m[0]);
  }

  return out.sort((a, b) => a.position - b.position).slice(0, MAX_PER_PAGE);
}

function encodeName(
  kind: LandingMediaKind,
  section: LandingSection,
  sourceUrl: string,
  position?: number,
): string {
  const pos = typeof position === 'number' && Number.isFinite(position) ? Math.max(0, Math.round(position)) : '';
  return `${kind}|${section}|${pos === '' ? '' : `${pos}|`}${sourceUrl}`.slice(0, 500);
}

function isKind(v: string): v is LandingMediaKind {
  return v === 'image' || v === 'gif' || v === 'video';
}

function decodeName(name: string): {
  kind: LandingMediaKind;
  section: LandingSection;
  sourceUrl: string;
  position?: number;
} {
  const parts = String(name || '').split('|');
  if (parts.length >= 4 && isKind(parts[0]) && isLandingSection(parts[1]) && /^\d+$/.test(parts[2])) {
    return {
      kind: parts[0],
      section: parts[1],
      position: Number(parts[2]),
      sourceUrl: parts.slice(3).join('|'),
    };
  }
  if (parts.length >= 3 && isKind(parts[0]) && isLandingSection(parts[1])) {
    return { kind: parts[0], section: parts[1], sourceUrl: parts.slice(2).join('|') };
  }
  if (parts.length >= 2 && isKind(parts[0])) {
    return { kind: parts[0], section: 'other', sourceUrl: parts.slice(1).join('|') };
  }
  return { kind: classifyLandingAsset(name) || 'image', section: 'other', sourceUrl: name };
}

function isRemoteUrl(path: string): boolean {
  return /^https?:\/\//i.test(path) || path.startsWith('//');
}

function displayUrl(path: string): string {
  if (!path || isRemoteUrl(path)) return '';
  return `/api/projecthub/file-proxy?path=${encodeURIComponent(path)}`;
}

export async function listLandingMedia(sb: Sb, projectId: string): Promise<LandingMediaItem[]> {
  const { data, error } = await sb
    .from('project_files')
    .select('id, file_path, original_name, created_at')
    .eq('project_id', projectId)
    .eq('file_type', LANDING_MEDIA_TYPE)
    .order('created_at', { ascending: true });
  if (error || !data) return [];
  const rows = (data as Array<{ id: number | string; file_path: string; original_name: string }>)
    .map((row) => {
      const meta = decodeName(row.original_name || '');
      return {
        id: row.id,
        kind: meta.kind,
        section: meta.section,
        sourceUrl: meta.sourceUrl,
        storedUrl: displayUrl(row.file_path),
        filePath: row.file_path,
        name: meta.sourceUrl.split('/').pop()?.split('?')[0] || meta.kind,
        position: meta.position,
      };
    });
  return sortLandingMediaAsOnPage(rows);
}

/** Only rows that have a real downloaded file (not a leftover source URL). */
export function downloadedLandingMedia(items: LandingMediaItem[]): LandingMediaItem[] {
  return items.filter((row) => !!row.storedUrl);
}

function sniffContentType(buf: Buffer, fallback: string): string {
  if (buf.length < 12) return fallback;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video/mp4';
  return fallback;
}

function looksLikeMediaBytes(buf: Buffer, contentType: string, url: string, kind: LandingMediaKind): boolean {
  if (contentType.startsWith('image/') || contentType.startsWith('video/')) return true;
  if (contentType.includes('octet-stream')) return true;
  if (/\.(jpe?g|png|webp|gif|avif|mp4|webm|mov)(\?|#|$)/i.test(url)) return true;
  if (kind === 'video' && buf.length > 1000) return true;
  return false;
}

async function fetchAssetOnce(
  url: string,
  kind: LandingMediaKind,
  headers: Record<string, string>,
): Promise<{ buf: Buffer; contentType: string } | null> {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(kind === 'video' ? 25_000 : 15_000),
    headers,
  });
  if (!res.ok) return null;
  const headerCt = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (headerCt.includes('text/html') || headerCt.includes('text/css') || headerCt.includes('javascript')) {
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 80 || buf.length > MAX_BYTES[kind]) return null;
  const contentType = sniffContentType(
    buf,
    headerCt || (kind === 'video' ? 'video/mp4' : kind === 'gif' ? 'image/gif' : 'image/jpeg'),
  );
  if (!looksLikeMediaBytes(buf, contentType, url, kind)) return null;
  return { buf, contentType };
}

const finalUrlCache = new Map<string, string>();

/** Tracking links (go.trkscaling.com, etc.) 302 to the real advertorial.
 *  Relative images must be resolved against THAT final URL, not the tracker. */
export async function resolveFinalPageUrl(url: string): Promise<string> {
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) return raw;
  const cached = finalUrlCache.get(raw);
  if (cached) return cached;
  try {
    const res = await fetch(raw, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
      headers: {
        Accept: 'text/html,image/*,*/*',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });
    const final = res.url || raw;
    finalUrlCache.set(raw, final);
    return final;
  } catch {
    finalUrlCache.set(raw, raw);
    return raw;
  }
}

export function pageDirectory(url: string): string {
  try {
    const u = new URL(url);
    let path = u.pathname || '/';
    if (!path.endsWith('/')) {
      path = /\.[a-z0-9]{2,5}$/i.test(path) ? path.replace(/\/[^/]+$/, '/') : `${path}/`;
    }
    return `${u.origin}${path}`;
  } catch {
    return url;
  }
}

function assetUrlCandidates(url: string, pageUrl: string, finalUrl: string): string[] {
  const out = [url];
  try {
    const asset = new URL(url);
    const bases = [finalUrl, pageUrl].filter(Boolean);
    for (const base of bases) {
      const dir = pageDirectory(base);
      out.push(new URL(asset.pathname.replace(/^\//, '') + asset.search, dir).href);
      const file = asset.pathname.split('/').filter(Boolean).pop();
      if (file) out.push(new URL(file + asset.search, dir).href);
    }
  } catch {
    /* keep original */
  }
  return [...new Set(out.filter(Boolean))];
}

/** Re-point tracker-absolutized assets onto the real landing after redirect. */
export function rewriteAssetsOntoPage(html: string, fromUrl: string, toUrl: string): string {
  if (!html || !fromUrl || !toUrl || fromUrl === toUrl) return html;
  let fromOrigin = '';
  try { fromOrigin = new URL(fromUrl).origin; } catch { return html; }
  const dir = pageDirectory(toUrl);
  return html.replace(/https?:\/\/[^\s"'<>)]+/gi, (abs) => {
    try {
      const u = new URL(abs);
      if (u.origin !== fromOrigin) return abs;
      return new URL(u.pathname.replace(/^\//, '') + u.search, dir).href;
    } catch {
      return abs;
    }
  });
}

async function downloadAsset(
  url: string,
  kind: LandingMediaKind,
  pageUrl = '',
): Promise<{ buf: Buffer; contentType: string } | null> {
  const finalPage = pageUrl ? await resolveFinalPageUrl(pageUrl) : pageUrl;
  const candidates = pageUrl ? assetUrlCandidates(url, pageUrl, finalPage) : [url];
  const referers = [finalPage, pageUrl, url]
    .map((u) => {
      try { return new URL(u).origin + '/'; } catch { return ''; }
    })
    .filter(Boolean);
  const base: Record<string, string> = {
    Accept: kind === 'video' ? 'video/*,*/*;q=0.8' : 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  for (const candidate of candidates) {
    const headersList: Array<Record<string, string>> = [
      ...referers.map((referer) => ({ ...base, Referer: referer, Origin: referer.replace(/\/$/, '') })),
      base,
    ];
    for (const headers of headersList) {
      try {
        const hit = await fetchAssetOnce(candidate, kind, headers);
        if (hit) return hit;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

function extFor(kind: LandingMediaKind, ct: string, url: string): string {
  if (kind === 'video') {
    if (/webm/.test(ct) || /\.webm/i.test(url)) return 'webm';
    if (/quicktime|mov/.test(ct) || /\.mov/i.test(url)) return 'mov';
    return 'mp4';
  }
  if (kind === 'gif' || /gif/.test(ct)) return 'gif';
  if (/webp/.test(ct) || /\.webp/i.test(url)) return 'webp';
  if (/png/.test(ct) || /\.png/i.test(url)) return 'png';
  return 'jpg';
}

export type LandingExtractStats = {
  saved: number;
  skipped: number;
  found: number;
  downloadFailed: number;
  uploadFailed: number;
};

/** Download one landing's assets into the project's Image landings library. */
export async function extractLandingMediaFromHtml(
  sb: Sb,
  args: {
    projectId: string;
    html: string;
    pageUrl: string;
    ownerUserId?: string | null;
    limit?: number;
  },
): Promise<LandingExtractStats> {
  const empty: LandingExtractStats = { saved: 0, skipped: 0, found: 0, downloadFailed: 0, uploadFailed: 0 };
  let html = args.html;
  let pageUrl = args.pageUrl;
  if (pageUrl) {
    const finalUrl = await resolveFinalPageUrl(pageUrl);
    if (finalUrl && finalUrl !== pageUrl) {
      html = rewriteAssetsOntoPage(html, pageUrl, finalUrl);
      pageUrl = finalUrl;
    }
  }
  const assets = collectLandingAssetUrls(html, pageUrl);
  empty.found = assets.length;
  if (!assets.length) return empty;
  const existing = await listLandingMedia(sb, args.projectId);
  const have = new Map(existing.map((e) => [e.sourceUrl, e]));
  const haveByFile = new Map(
    existing.map((e) => [e.sourceUrl.split('/').pop()?.split('?')[0] || '', e]),
  );
  const cap = Math.min(args.limit || MAX_PER_PAGE, MAX_PER_PAGE);
  const ownerUserId = await resolveOwnerUserId(sb, args.projectId, args.ownerUserId);
  await ensureBucket(sb);
  let saved = 0;
  let skipped = 0;
  let downloadFailed = 0;
  let uploadFailed = 0;

  for (const a of assets) {
    const fileName = a.url.split('/').pop()?.split('?')[0] || '';
    const prev = have.get(a.url) || (fileName ? haveByFile.get(fileName) : undefined);
    const prevIsFile = prev && prev.filePath && !isRemoteUrl(prev.filePath);
    if (prevIsFile) {
      if (a.section !== 'other' && prev.section === 'other') {
        await sb
          .from('project_files')
          .update({ original_name: encodeName(a.kind, a.section, a.url, a.position) })
          .eq('id', prev.id);
        prev.section = a.section;
      }
      skipped++;
      continue;
    }
    if (existing.length + saved >= MAX_PER_RUN || saved >= cap) break;
    const dl = await downloadAsset(a.url, a.kind, pageUrl);
    if (!dl) {
      downloadFailed++;
      skipped++;
      continue;
    }
    const ext = extFor(a.kind, dl.contentType, a.url);
    const key = `${args.projectId}/${LANDING_MEDIA_TYPE}/${Date.now()}_${saved}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await sb.storage.from(BUCKET).upload(key, new Uint8Array(dl.buf), {
      contentType: dl.contentType,
      upsert: false,
    });
    if (upErr) {
      console.warn('[landing-media] upload failed:', upErr.message, key);
      uploadFailed++;
      skipped++;
      continue;
    }
    const row: Record<string, unknown> = {
      project_id: args.projectId,
      file_type: LANDING_MEDIA_TYPE,
      file_path: key,
      original_name: encodeName(a.kind, a.section, a.url, a.position),
    };
    if (ownerUserId) row.owner_user_id = ownerUserId;
    if (prev) {
      const { error } = await sb.from('project_files').update({
        file_path: key,
        original_name: encodeName(a.kind, a.section, a.url, a.position),
      }).eq('id', prev.id);
      if (error) {
        await sb.storage.from(BUCKET).remove([key]).catch(() => undefined);
        uploadFailed++;
        skipped++;
        continue;
      }
      prev.filePath = key;
      prev.storedUrl = displayUrl(key);
    } else {
      const { error: insErr } = await sb.from('project_files').insert(row);
      if (insErr) {
        console.warn('[landing-media] insert failed:', insErr.message);
        await sb.storage.from(BUCKET).remove([key]).catch(() => undefined);
        uploadFailed++;
        skipped++;
        continue;
      }
      have.set(a.url, {
        id: `new-${saved}`,
        kind: a.kind,
        section: a.section,
        sourceUrl: a.url,
        storedUrl: displayUrl(key),
        filePath: key,
        name: a.kind,
      });
    }
    saved++;
  }
  return { saved, skipped, found: assets.length, downloadFailed, uploadFailed };
}

/** Persist a file the browser already downloaded (CORS-ok CDN, or extension). */
export async function ingestLandingMediaBytes(
  sb: Sb,
  args: {
    projectId: string;
    buf: Buffer;
    contentType: string;
    sourceUrl: string;
    kind: LandingMediaKind;
    section: LandingSection;
    position?: number;
    ownerUserId?: string | null;
  },
): Promise<LandingMediaItem | null> {
  if (!args.buf?.length || args.buf.length < 80 || args.buf.length > MAX_BYTES[args.kind]) return null;
  const existing = await listLandingMedia(sb, args.projectId);
  const prev = existing.find((e) => e.sourceUrl === args.sourceUrl);
  if (prev && prev.filePath && !isRemoteUrl(prev.filePath)) return prev;
  await ensureBucket(sb);
  const ownerUserId = await resolveOwnerUserId(sb, args.projectId, args.ownerUserId);
  const ext = extFor(args.kind, args.contentType, args.sourceUrl);
  const key = `${args.projectId}/${LANDING_MEDIA_TYPE}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error: upErr } = await sb.storage.from(BUCKET).upload(key, new Uint8Array(args.buf), {
    contentType: args.contentType || 'application/octet-stream',
    upsert: false,
  });
  if (upErr) {
    console.warn('[landing-media] ingest upload failed:', upErr.message);
    return null;
  }
  const original_name = encodeName(args.kind, args.section, args.sourceUrl, args.position);
  if (prev) {
    const { error } = await sb.from('project_files').update({ file_path: key, original_name }).eq('id', prev.id);
    if (error) {
      await sb.storage.from(BUCKET).remove([key]).catch(() => undefined);
      return null;
    }
    return { ...prev, filePath: key, storedUrl: displayUrl(key) };
  }
  const row: Record<string, unknown> = {
    project_id: args.projectId,
    file_type: LANDING_MEDIA_TYPE,
    file_path: key,
    original_name,
  };
  if (ownerUserId) row.owner_user_id = ownerUserId;
  const { error: insErr } = await sb.from('project_files').insert(row);
  if (insErr) {
    await sb.storage.from(BUCKET).remove([key]).catch(() => undefined);
    return null;
  }
  return {
    id: `new-${Date.now()}`,
    kind: args.kind,
    section: args.section,
    sourceUrl: args.sourceUrl,
    storedUrl: displayUrl(key),
    filePath: key,
    name: args.sourceUrl.split('/').pop()?.split('?')[0] || args.kind,
  };
}

/** Walk every competitor landing saved on the project and fill Image landings. */
export async function extractLandingMediaForProject(
  sb: Sb,
  projectId: string,
  ownerUserId?: string | null,
): Promise<LandingExtractStats & { pages: number }> {
  const { data: rows } = await sb
    .from('archived_funnels')
    .select('id, steps')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(80);
  const totals: LandingExtractStats & { pages: number } = {
    saved: 0,
    skipped: 0,
    found: 0,
    downloadFailed: 0,
    uploadFailed: 0,
    pages: 0,
  };
  const owner = await resolveOwnerUserId(sb, projectId, ownerUserId);
  for (const row of rows || []) {
    const steps = Array.isArray(row.steps) ? (row.steps as Array<Record<string, unknown>>) : [];
    for (const step of steps) {
      const cloned =
        step.cloned_data && typeof step.cloned_data === 'object'
          ? (step.cloned_data as Record<string, unknown>)
          : {};
      const pageUrl = String(step.url_to_swipe || cloned.source_url || '');
      const pageIds = [
        String(step.page_id || ''),
        pageIdFromHtmlUrl(String(cloned.htmlUrl || '')),
        String(row.id || ''),
      ].filter(Boolean);
      let html = '';
      for (const pageId of [...new Set(pageIds)]) {
        const { data: ph } = await sb
          .from('page_html')
          .select('html')
          .eq('page_id', pageId)
          .eq('kind', 'cloned')
          .eq('variant', 'desktop')
          .maybeSingle();
        html = typeof ph?.html === 'string' ? ph.html : '';
        if (html) break;
      }
      if (!html && typeof cloned.html === 'string' && !/^https?:\/\//i.test(cloned.html.slice(0, 12))) {
        html = cloned.html;
      }
      if (!html) continue;
      totals.pages++;
      const r = await extractLandingMediaFromHtml(sb, {
        projectId,
        html,
        pageUrl,
        ownerUserId: owner,
      });
      totals.saved += r.saved;
      totals.skipped += r.skipped;
      totals.found += r.found;
      totals.downloadFailed += r.downloadFailed;
      totals.uploadFailed += r.uploadFailed;
      if (totals.saved >= MAX_PER_RUN) return totals;
    }
  }
  return totals;
}
