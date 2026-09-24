/**
 * Clone-time inventory of everything Swipe must rewrite or restyle:
 * visible copy, images, videos, embeds, CTAs, hidden steps.
 *
 * Always runs locally (no LLM). The lander-agent may later overwrite
 * `role` / `family` after it visions an unrecognized page.
 */

import { extractAllTextsUniversal } from './universal-text-extractor';
import { collectRestyleSlots } from './restyle-slots';
import { readHealStamp } from './lander-heal';

export type SwipeTextRole =
  | 'headline'
  | 'subhead'
  | 'body'
  | 'bullet'
  | 'cta'
  | 'question'
  | 'label'
  | 'alt'
  | 'meta'
  | 'other';

export type SwipeMediaRole =
  | 'hero'
  | 'product'
  | 'lifestyle'
  | 'testimonial'
  | 'video'
  | 'logo'
  | 'other';

export type LanderFamily =
  | 'chat-quiz'
  | 'hidden-stepper'
  | 'faq'
  | 'vsl'
  | 'checkout'
  | 'advertorial'
  | 'landing'
  | 'unknown';

export type SwipeTextAsset = {
  id: number;
  text: string;
  tag: string;
  role: SwipeTextRole;
  position: number;
};

export type SwipeMediaAsset = {
  id: number;
  src: string;
  kind: 'image' | 'gif' | 'video' | 'embed';
  alt: string;
  role: string;
  poster?: string;
  domTag?: 'img' | 'video';
  domIndex?: number;
};

export type SwipeAssetMap = {
  version: 1;
  family: LanderFamily;
  understood: boolean;
  source: 'heal' | 'deterministic' | 'agent';
  texts: SwipeTextAsset[];
  images: SwipeMediaAsset[];
  videos: SwipeMediaAsset[];
  ctas: { text: string; href: string }[];
  steps: number;
  healed: string[];
};

const MAX_TEXTS = 350;
const EMBED_RE =
  /<(?:iframe|embed)\b[^>]*(?:src|data-src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
const EMBED_HOST =
  /youtube|youtu\.be|vimeo|wistia|fast\.wistia|loom\.com|player\.|vidalytics|vturb|converteai|smartplayer|hyros|vsl|bunnycdn|cloudflarestream/i;

function tagOf(context: string): string {
  if (context.startsWith('tag:')) return context.slice(4);
  if (context.startsWith('mixed:')) return context.slice(6);
  if (context.startsWith('attr:')) return context;
  if (context === 'title') return 'title';
  if (context.startsWith('meta:')) return context;
  return context || 'p';
}

function roleForText(tag: string, text: string): SwipeTextRole {
  const t = tag.replace(/^(tag:|mixed:)/, '');
  if (t === 'title' || t.startsWith('meta')) return 'meta';
  if (t === 'h1') return 'headline';
  if (/^h[2-6]$/.test(t)) return 'subhead';
  if (t === 'button') return 'cta';
  if (t === 'a' && text.length < 56) return 'cta';
  if (t === 'li') return 'bullet';
  if (t === 'label') return 'label';
  if (/attr:alt/.test(tag)) return 'alt';
  if (/\?$/.test(text.trim()) || /question|quiz-option/i.test(tag)) return 'question';
  return 'body';
}

function inferFamily(html: string, healed: string[], videos: number, steps: number): LanderFamily {
  if (healed.includes('chat-quiz')) return 'chat-quiz';
  if (healed.includes('generic-step')) return 'hidden-stepper';
  if (healed.includes('accordion')) return 'faq';
  const lower = html.slice(0, 80_000).toLowerCase();
  if (/\b(stripe|paypal|checkout|order-summary|card-number|payment)\b/.test(lower)) return 'checkout';
  if (videos > 0 || EMBED_HOST.test(lower)) return 'vsl';
  if (steps >= 2) return 'hidden-stepper';
  const paras = (html.match(/<p[\s>]/gi) || []).length;
  if (paras >= 8) return 'advertorial';
  if ((html.match(/<h1[\s>]/i) || []).length || (html.match(/<img[\s>]/gi) || []).length >= 2) {
    return 'landing';
  }
  return 'unknown';
}

function collectEmbeds(html: string): SwipeMediaAsset[] {
  const out: SwipeMediaAsset[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  EMBED_RE.lastIndex = 0;
  while ((m = EMBED_RE.exec(html)) !== null) {
    const src = String(m[1] || '').trim();
    if (!src || seen.has(src) || src.startsWith('about:')) continue;
    if (!EMBED_HOST.test(src) && !/\.mp4|\.webm|\.m3u8/i.test(src)) continue;
    seen.add(src);
    out.push({
      id: out.length,
      src,
      kind: 'embed',
      alt: '',
      role: 'video',
    });
  }
  return out;
}

function collectCtas(html: string): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  const seen = new Set<string>();
  const re = /<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 40) {
    const attrs = m[2] || '';
    const text = m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 2 || text.length > 80) continue;
    const href = attrs.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1] || '';
    const cls = attrs.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] || '';
    const isCta =
      m[1].toLowerCase() === 'button' ||
      /btn|cta|button|submit|buy|order|next|continue/i.test(cls) ||
      (href && !/^#|^javascript:/i.test(href) && text.length < 48);
    if (!isCta) continue;
    const key = `${text}::${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, href });
  }
  return out;
}

function countSteps(html: string): number {
  const ids = new Set<string>();
  const re = /\b(?:data-step|data-form-step-reply|data-slide)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  const panels = (html.match(/\bquiz-panel\b/gi) || []).length;
  return Math.max(ids.size, panels);
}

export function buildSwipeAssetMap(html: string): SwipeAssetMap {
  const { applied } = readHealStamp(html);
  const healed = applied;

  const seenText = new Set<string>();
  const texts: SwipeTextAsset[] = [];
  for (const u of extractAllTextsUniversal(html)) {
    const text = u.text.trim();
    if (text.length < 2 || text.length > 4000) continue;
    if (!/[a-zA-Z]/.test(text)) continue;
    if (seenText.has(text)) continue;
    seenText.add(text);
    const tag = tagOf(u.context);
    texts.push({
      id: texts.length,
      text,
      tag,
      role: roleForText(tag, text),
      position: u.position,
    });
    if (texts.length >= MAX_TEXTS) break;
  }

  const slots = collectRestyleSlots(html, 40);
  const images: SwipeMediaAsset[] = [];
  const videos: SwipeMediaAsset[] = [];
  for (const s of slots) {
    const item: SwipeMediaAsset = {
      id: s.id,
      src: s.src,
      kind: s.kind === 'gif' ? 'gif' : s.kind === 'video' ? 'video' : 'image',
      alt: s.alt || '',
      role: s.section || 'other',
      poster: s.poster,
      domTag: s.domTag,
      domIndex: s.domIndex,
    };
    if (item.kind === 'video') videos.push(item);
    else images.push(item);
  }
  let nextMediaId = Math.max(-1, ...images.map((m) => m.id), ...videos.map((m) => m.id)) + 1;
  for (const embed of collectEmbeds(html)) {
    if (videos.some((v) => v.src === embed.src)) continue;
    videos.push({ ...embed, id: nextMediaId++ });
  }

  const steps = countSteps(html);
  const family = inferFamily(html, healed, videos.length, steps);

  return {
    version: 1,
    family,
    understood: family !== 'unknown',
    source: healed.length ? 'heal' : 'deterministic',
    texts,
    images,
    videos,
    ctas: collectCtas(html),
    steps,
    healed,
  };
}

export function textsFromSwipeMap(
  map: SwipeAssetMap | null | undefined,
): Array<{ original: string; tag: string; position: number }> {
  if (!map?.texts?.length) return [];
  return map.texts.map((t) => ({
    original: t.text,
    tag: t.tag || 'p',
    position: t.position || 0,
  }));
}

export function summarizeSwipeMap(map: SwipeAssetMap | null | undefined): string {
  if (!map) return '';
  const bits = [
    `${map.texts.length} texts`,
    `${map.images.length} images`,
    `${map.videos.length} videos`,
  ];
  if (map.ctas.length) bits.push(`${map.ctas.length} CTAs`);
  if (map.family && map.family !== 'unknown') bits.push(map.family);
  if (map.source === 'agent') bits.push('understood');
  return `; mapped ${bits.join(', ')}`;
}

export function compactSwipeMap(map: SwipeAssetMap): SwipeAssetMap {
  return {
    ...map,
    texts: map.texts.map((t) => ({
      id: t.id,
      text: t.text.slice(0, 800),
      tag: t.tag,
      role: t.role,
      position: t.position,
    })),
    images: map.images.map((m) => ({
      id: m.id,
      src: m.src.slice(0, 500),
      kind: m.kind,
      alt: (m.alt || '').slice(0, 120),
      role: m.role,
      poster: m.poster?.slice(0, 500),
      domTag: m.domTag,
      domIndex: m.domIndex,
    })),
    videos: map.videos.map((m) => ({
      id: m.id,
      src: m.src.slice(0, 500),
      kind: m.kind,
      alt: (m.alt || '').slice(0, 120),
      role: m.role,
      poster: m.poster?.slice(0, 500),
      domTag: m.domTag,
      domIndex: m.domIndex,
    })),
    ctas: map.ctas.slice(0, 40),
  };
}
