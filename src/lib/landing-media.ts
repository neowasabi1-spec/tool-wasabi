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

/** Pair target slots with source media: same section first, then related, then leftovers. */
export function matchLandingMediaToSlots<S extends { section: LandingSection }>(
  slots: S[],
  media: LandingMediaItem[],
  used: Set<string>,
): Array<{ slot: S; item: LandingMediaItem | null }> {
  const take = (pred: (m: LandingMediaItem) => boolean): LandingMediaItem | null => {
    const found = media.find((m) => !used.has(String(m.id)) && pred(m));
    if (!found) return null;
    used.add(String(found.id));
    return found;
  };
  const out: Array<{ slot: S; item: LandingMediaItem | null }> = slots.map((slot) => {
    const exact = take((m) => m.section === slot.section);
    return { slot, item: exact };
  });
  for (const row of out) {
    if (row.item) continue;
    const related = RELATED_SECTIONS[row.slot.section] || [];
    row.item = take((m) => related.includes(m.section));
  }
  for (const row of out) {
    if (row.item) continue;
    row.item = take(() => true);
  }
  return out;
}

type Sb = {
  from: (table: string) => any;
  storage: { from: (bucket: string) => any };
};

const BUCKET = 'project-files';
const MAX_PER_PAGE = 24;
const MAX_PER_RUN = 60;
const MAX_BYTES: Record<LandingMediaKind, number> = {
  image: 8_000_000,
  gif: 12_000_000,
  video: 22_000_000,
};

const JUNK_RE =
  /logo|icon|favicon|sprite|pixel|1x1|tracking|analytics|doubleclick|facebook\.com\/tr|google-analytics|hotjar|badge|payment|visa|mastercard|amex|paypal|klarna|apple-?pay|g-?pay|emoji|loader|spinner|spacer|blank\.|placeholder|trustpilot|cookie/i;

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

function encodeName(kind: LandingMediaKind, section: LandingSection, sourceUrl: string): string {
  return `${kind}|${section}|${sourceUrl}`.slice(0, 500);
}

function isKind(v: string): v is LandingMediaKind {
  return v === 'image' || v === 'gif' || v === 'video';
}

function decodeName(name: string): { kind: LandingMediaKind; section: LandingSection; sourceUrl: string } {
  const parts = String(name || '').split('|');
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
  return (data as Array<{ id: number | string; file_path: string; original_name: string }>)
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
      };
    })
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

async function downloadAsset(
  url: string,
  kind: LandingMediaKind,
  pageUrl = '',
): Promise<{ buf: Buffer; contentType: string } | null> {
  try {
    const referer = pageUrl || (() => {
      try { return new URL(url).origin + '/'; } catch { return ''; }
    })();
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(kind === 'video' ? 25_000 : 15_000),
      headers: {
        Accept: kind === 'video' ? 'video/*,*/*' : 'image/avif,image/webp,image/*,*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        ...(referer ? { Referer: referer } : {}),
      },
    });
    if (!res.ok) return null;
    const headerCt = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200 || buf.length > MAX_BYTES[kind]) return null;
    const contentType = sniffContentType(
      buf,
      headerCt || (kind === 'video' ? 'video/mp4' : kind === 'gif' ? 'image/gif' : 'image/jpeg'),
    );
    if (kind === 'video' && !contentType.startsWith('video/') && !contentType.includes('octet-stream')) return null;
    if (kind !== 'video' && !contentType.startsWith('image/') && !contentType.includes('octet-stream')) return null;
    return { buf, contentType };
  } catch {
    return null;
  }
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
): Promise<{ saved: number; skipped: number }> {
  const assets = collectLandingAssetUrls(args.html, args.pageUrl);
  if (!assets.length) return { saved: 0, skipped: 0 };
  const existing = await listLandingMedia(sb, args.projectId);
  const have = new Map(existing.map((e) => [e.sourceUrl, e]));
  const cap = Math.min(args.limit || MAX_PER_PAGE, MAX_PER_PAGE);
  let saved = 0;
  let skipped = 0;

  for (const a of assets) {
    const prev = have.get(a.url);
    const prevIsFile = prev && prev.filePath && !isRemoteUrl(prev.filePath);
    if (prevIsFile) {
      if (a.section !== 'other' && prev.section === 'other') {
        await sb
          .from('project_files')
          .update({ original_name: encodeName(a.kind, a.section, a.url) })
          .eq('id', prev.id);
        prev.section = a.section;
      }
      skipped++;
      continue;
    }
    if (existing.length + saved >= MAX_PER_RUN || saved >= cap) break;
    const dl = await downloadAsset(a.url, a.kind, args.pageUrl);
    if (!dl) {
      skipped++;
      continue;
    }
    const ext = extFor(a.kind, dl.contentType, a.url);
    const key = `${args.projectId}/${LANDING_MEDIA_TYPE}/${Date.now()}_${saved}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await sb.storage.from(BUCKET).upload(key, dl.buf, {
      contentType: dl.contentType,
      upsert: false,
    });
    if (upErr) {
      skipped++;
      continue;
    }
    const row: Record<string, unknown> = {
      project_id: args.projectId,
      file_type: LANDING_MEDIA_TYPE,
      file_path: key,
      original_name: encodeName(a.kind, a.section, a.url),
    };
    if (args.ownerUserId) row.owner_user_id = args.ownerUserId;
    if (prev) {
      const { error } = await sb.from('project_files').update({ file_path: key }).eq('id', prev.id);
      if (error) {
        await sb.storage.from(BUCKET).remove([key]).catch(() => undefined);
        skipped++;
        continue;
      }
      prev.filePath = key;
      prev.storedUrl = displayUrl(key);
    } else {
      const { error: insErr } = await sb.from('project_files').insert(row);
      if (insErr) {
        await sb.storage.from(BUCKET).remove([key]).catch(() => undefined);
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
  return { saved, skipped };
}

/** Walk every competitor landing saved on the project and fill Image landings. */
export async function extractLandingMediaForProject(
  sb: Sb,
  projectId: string,
  ownerUserId?: string | null,
): Promise<{ saved: number; skipped: number; pages: number }> {
  const { data: rows } = await sb
    .from('archived_funnels')
    .select('id, steps')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(80);
  let saved = 0;
  let skipped = 0;
  let pages = 0;
  for (const row of rows || []) {
    const steps = Array.isArray(row.steps) ? (row.steps as Array<Record<string, unknown>>) : [];
    for (const step of steps) {
      const pageId = String(step.page_id || row.id || '');
      const cloned =
        step.cloned_data && typeof step.cloned_data === 'object'
          ? (step.cloned_data as Record<string, unknown>)
          : {};
      const pageUrl = String(step.url_to_swipe || cloned.source_url || '');
      let html = '';
      if (pageId) {
        const { data: ph } = await sb
          .from('page_html')
          .select('html')
          .eq('page_id', pageId)
          .eq('kind', 'cloned')
          .eq('variant', 'desktop')
          .maybeSingle();
        html = typeof ph?.html === 'string' ? ph.html : '';
      }
      if (!html && typeof cloned.html === 'string') html = cloned.html;
      if (!html) continue;
      pages++;
      const r = await extractLandingMediaFromHtml(sb, {
        projectId,
        html,
        pageUrl,
        ownerUserId,
      });
      saved += r.saved;
      skipped += r.skipped;
      if (saved >= MAX_PER_RUN) return { saved, skipped, pages };
    }
  }
  return { saved, skipped, pages };
}
