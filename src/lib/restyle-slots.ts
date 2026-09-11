import { inferLandingSection, isDecorativeMedia } from './landing-media';

/** Collect replaceable media on a landing page. Does not touch text. */

export type RestyleKind = 'image' | 'gif' | 'video';

export interface RestyleSlot {
  id: number;
  src: string;
  kind: RestyleKind;
  alt: string;
  section: string;
  width: number;
  height: number;
  /** Nearby copy — used to decide people vs illustration vs product. */
  context?: string;
  /** nth <img> or <video> in the document — used to paint the new file on that tag. */
  domTag?: 'img' | 'video';
  domIndex?: number;
  /** Poster of a <video> slot — what the model can look at when the clip itself is not previewable. */
  poster?: string;
}

export type PaintedMedia = {
  tag: 'img' | 'video';
  index: number;
  url: string;
  poster?: string;
  /** `url` is a still photo that replaces a <video>: shown as poster and slowly animated. */
  motion?: boolean;
};

/**
 * Decide how a chosen file lands on a slot. A photo chosen for a <video>
 * slot becomes an animated still (there is no way to invent a clip); a video
 * never lands on an <img>.
 */
export function paintFor(
  slot: Pick<RestyleSlot, 'domTag' | 'domIndex'>,
  url: string,
  fileKind: string,
): PaintedMedia | null {
  if (!url || typeof slot.domIndex !== 'number') return null;
  const videoSlot = slot.domTag === 'video';
  if (videoSlot && fileKind !== 'video') return { tag: 'video', index: slot.domIndex, url, motion: true };
  if (!videoSlot && fileKind === 'video') return null;
  return { tag: videoSlot ? 'video' : 'img', index: slot.domIndex, url };
}

/** Safe for the browser bundle — do not import restyle-place from client code. */
export function libraryFileLabel(item: { name?: string; sourceUrl?: string; storedUrl?: string }): string {
  const fromName = String(item.name || '').split('|').pop() || '';
  const fromUrl = String(item.sourceUrl || item.storedUrl || '').split('/').pop()?.split('?')[0] || '';
  return (fromName || fromUrl || '').slice(0, 160);
}

const LAZY_ATTRS = [
  'srcset', 'sizes', 'data-src', 'data-original', 'data-original-src', 'data-orig-src',
  'data-lazy-src', 'data-lazy', 'data-lazyload', 'data-lazy-load', 'data-url',
  'data-image-src', 'data-image', 'data-thumb', 'data-cfsrc', 'data-cmplz-src',
  'data-wf-src', 'data-echo', 'data-defer-src', 'data-hi-res-src', 'data-actual',
  'data-srcfallback', 'data-srcset', 'data-lazy-srcset', 'data-cfsrcset',
  'data-cmplz-srcset', 'data-wf-srcset',
];

const FILE_PROXY_RE = /\/api\/projecthub\/file-proxy|\/storage\/v1\/object\/public\/project-files/i;
const PAINTED_TAG_RE = /data-restyled|\/api\/projecthub\/file-proxy|\/storage\/v1\/object\/public\/project-files/i;

const JUNK =
  /favicon|sprite|pixel|1x1|tracking|doubleclick|visa|mastercard|amex|paypal|klarna|apple-?pay|loader|spinner|spacer|logo\.svg|google-analytics|facebook\.com\/tr|hotjar|trustpilot|woff2?|placeholder|blank\.|lqip|star[s]?|rating|check(?:mark)?|tick|spunta/i;

/**
 * Only what the tag itself says about the file (name, class, size). The copy
 * around a photo is never used to drop it — a portrait next to "5 stars" is
 * still a portrait. Stars and ticks are recognised by the model looking at
 * the picture.
 */
function isUiChrome(src: string, alt: string, cls: string, w: number, h: number): boolean {
  if (isDecorativeMedia(src, alt, cls)) return true;
  if (JUNK.test(src) || JUNK.test(alt) || JUNK.test(cls)) return true;
  if (w > 0 && h > 0 && w < 20 && h < 20) return true;
  return false;
}

function isChromePaintTag(tag: string): boolean {
  const w = Number.parseInt(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] || '0', 10);
  const h = Number.parseInt(tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] || '0', 10);
  const cls = tag.match(/\bclass\s*=\s*["']([^"']+)/i)?.[1] || '';
  const src = tag.match(/\bsrc\s*=\s*["']([^"']+)/i)?.[1] || '';
  if (JUNK.test(cls) || JUNK.test(src) || isDecorativeMedia(src, cls)) return true;
  return w > 0 && h > 0 && w < 20 && h < 20;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/');
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

function isPlaceholder(src: string): boolean {
  return !src || src.startsWith('data:') || src.startsWith('blob:') || /placeholder|spacer|blank\.|1x1|pixel|lqip/i.test(src);
}

function classifySrc(src: string): RestyleKind | null {
  const u = src.split('#')[0].split('?')[0].toLowerCase();
  if (/\.(svg|ico|woff2?|ttf|eot)(\b|$)/.test(u)) return null;
  if (/\.(mp4|webm|mov|m4v|ogv)(\b|$)/.test(u) || /\/video\//i.test(u)) return 'video';
  if (/\.gif(\b|$)/.test(u)) return 'gif';
  if (/\.(jpe?g|png|webp|avif|bmp)(\b|$)/.test(u)) return 'image';
  if (/\/(image|img|media|cdn|uploads|wp-content|assets|files)\//i.test(u)) return 'image';
  return null;
}

/** Readable copy around a tag: no half-cut tags, no CSS/JS spilling in from a window edge. */
function nearby(html: string, index: number, tagLen: number): string {
  const from = Math.max(0, index - 900);
  const to = Math.min(html.length, index + tagLen + 900);
  let s = html.slice(from, to);
  const firstGt = s.indexOf('>');
  const firstLt = s.indexOf('<');
  if (firstGt >= 0 && (firstLt < 0 || firstGt < firstLt)) s = s.slice(firstGt + 1);
  const lastLt = s.lastIndexOf('<');
  if (lastLt > s.lastIndexOf('>')) s = s.slice(0, lastLt);
  s = s.replace(/^[\s\S]*?<\/(?:style|script)>/i, (m) => (/<(?:style|script)\b/i.test(m) ? m : ' '));
  s = s.replace(/<(?:style|script)\b[\s\S]*$/i, (m) => (/<\/(?:style|script)>/i.test(m) ? m : ' '));
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

function slotSection(text: string, index: number, htmlLen: number, kind?: RestyleKind): string {
  return inferLandingSection(text, {
    positionRatio: htmlLen ? index / htmlLen : 0,
    kind: kind === 'gif' ? 'image' : kind,
  });
}

function imgSection(
  alt: string,
  cls: string,
  ctx: string,
  index: number,
  htmlLen: number,
  kind: RestyleKind,
): string {
  return slotSection(`${alt} ${cls} ${ctx}`, index, htmlLen, kind);
}

function pickImgSrc(tag: string): string {
  const lazy =
    tag.match(/\bdata-src\s*=\s*["']([^"']+)["']/i)?.[1]
    || tag.match(/\bdata-lazy-src\s*=\s*["']([^"']+)["']/i)?.[1]
    || tag.match(/\bdata-original\s*=\s*["']([^"']+)["']/i)?.[1]
    || tag.match(/\bdata-bg\s*=\s*["']([^"']+)["']/i)?.[1]
    || tag.match(/\bdata-image\s*=\s*["']([^"']+)["']/i)?.[1]
    || '';
  const srcset =
    tag.match(/\bsrcset\s*=\s*["']([^"']+)["']/i)?.[1]
    || tag.match(/\bdata-srcset\s*=\s*["']([^"']+)["']/i)?.[1]
    || '';
  const fromSet = srcset ? largestSrcset(srcset) : '';
  const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] || '';
  return [lazy, fromSet, src].map(decodeEntities).find((u) => u && !isPlaceholder(u)) || '';
}

export function collectRestyleSlots(html: string, max = 40, _pageUrl = ''): RestyleSlot[] {
  const out: RestyleSlot[] = [];
  const seen = new Set<string>();
  const add = (
    raw: string,
    kind: RestyleKind | null,
    alt: string,
    context: string,
    section: string,
    w: number,
    h: number,
    dom?: { tag: 'img' | 'video'; index: number },
  ) => {
    const src = decodeEntities(String(raw || '').trim());
    if (!src || isPlaceholder(src) || seen.has(src)) return;
    const resolved = classifySrc(src);
    const useKind = kind || resolved;
    if (!useKind) return;
    seen.add(src);
    out.push({
      id: out.length,
      src,
      kind: useKind,
      alt,
      section,
      width: w,
      height: h,
      context: (alt ? `${alt} ${context}` : context).slice(0, 520),
      domTag: dom?.tag,
      domIndex: dom?.index,
    });
  };

  // Videos first: there are few and the cap must never push them out.
  const videoRe = /<video\b[\s\S]*?<\/video>/gi;
  let m: RegExpExecArray | null;
  let videoIndex = 0;
  const videoAt: number[] = [];
  while ((m = videoRe.exec(html)) !== null) {
    const block = m[0];
    const src =
      block.match(/\bsrc\s*=\s*["']([^"']+\.(?:mp4|webm|mov|m4v)[^"']*)["']/i)?.[1]
      || block.match(/\bdata-src\s*=\s*["']([^"']+)["']/i)?.[1]
      || block.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]
      || '';
    const poster = block.match(/\bposter\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    const ctx = nearby(html, m.index, block.length);
    if (out.length < max) {
      const dom = { tag: 'video' as const, index: videoIndex };
      const before = out.length;
      if (src) add(decodeEntities(src), 'video', '', ctx, 'video', 0, 0, dom);
      else if (poster) add(decodeEntities(poster), 'video', 'video poster', ctx, 'video', 0, 0, dom);
      if (out.length > before) {
        if (poster) out[out.length - 1].poster = decodeEntities(poster);
        videoAt.push(m.index);
      }
    }
    videoIndex++;
  }

  const imgRe = /<img\b[^>]*>/gi;
  let imgIndex = 0;
  const imgAt: number[] = [];
  const imgStart = out.length;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const src = pickImgSrc(tag);
    const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] || '';
    const w = Number.parseInt(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] || '0', 10);
    const h = Number.parseInt(tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] || '0', 10);
    const cls = tag.match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    const ctx = nearby(html, m.index, tag.length);
    if (isUiChrome(src, alt, cls, w, h)) {
      imgIndex++;
      continue;
    }
    if (src && out.length < max) {
      const kind: RestyleKind = /\.gif(\?|#|$)/i.test(src) ? 'gif' : 'image';
      const before = out.length;
      add(
        src,
        kind,
        alt,
        ctx,
        imgSection(alt, cls, ctx, m.index, html.length, kind),
        w,
        h,
        { tag: 'img', index: imgIndex },
      );
      if (out.length > before) imgAt.push(m.index);
    }
    imgIndex++;
  }

  // Back to document order so the model reads the page top to bottom.
  const at = [...videoAt, ...imgAt];
  const ordered = out
    .map((slot, i) => ({ slot, at: at[i] ?? (i < imgStart ? -1 : Number.MAX_SAFE_INTEGER) }))
    .sort((a, b) => a.at - b.at)
    .map(({ slot }, i) => ({ ...slot, id: i }));
  return ordered;
}

const LAZY_ATTR_RE = new RegExp(
  `\\s+(?:${LAZY_ATTRS.join('|')})\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`,
  'gi',
);

function mergeObjectFit(tag: string): string {
  const extra = 'object-fit:cover;max-width:100%';
  if (/\bstyle\s*=/i.test(tag)) {
    return tag.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i, (_full, q: string, css: string) => {
      let next = String(css || '').trim();
      if (next && !next.endsWith(';')) next += ';';
      if (!/object-fit\s*:/i.test(next)) next += 'object-fit:cover;';
      if (!/max-width\s*:/i.test(next)) next += 'max-width:100%;';
      return `style=${q}${next}${q}`;
    });
  }
  return tag.replace(/<(img|video)\b/i, `<$1 style="${extra}"`);
}

/** Set src on a media tag and drop every lazy-load attr (same as VisualHtmlEditor). */
export function paintMediaTag(tag: string, url: string, extra?: { poster?: string }): string {
  LAZY_ATTR_RE.lastIndex = 0;
  let t = tag.replace(LAZY_ATTR_RE, '');
  if (/\bsrc\s*=/i.test(t)) {
    t = t.replace(/\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, `src="${url}"`);
  } else if (/^<video\b/i.test(t)) {
    t = t.replace(/<video\b/i, `<video src="${url}"`);
  } else {
    t = t.replace(/<(img|source|image)\b/i, `<$1 src="${url}"`);
  }
  if (extra?.poster && /^<video\b/i.test(t)) {
    if (/\bposter\s*=/i.test(t)) {
      t = t.replace(/\bposter\s*=\s*("[^"]*"|'[^']*')/i, `poster="${extra.poster}"`);
    } else {
      t = t.replace(/<video\b/i, `<video poster="${extra.poster}"`);
    }
  }
  if (!/\bdata-restyled\s*=/i.test(t)) {
    t = t.replace(/<(img|video)\b/i, `<$1 data-restyled="1"`);
  }
  return mergeObjectFit(t);
}

/** Drop leftover <source>, srcset, and parent backgrounds so old media cannot sit under the new file. */
export function sealPaintedHtml(html: string): string {
  return outsideSwipeReplacer(html, (raw) => {
    let out = raw;
    out = out.replace(/<picture\b[\s\S]*?<\/picture>/gi, (pic) => {
      if (!PAINTED_TAG_RE.test(pic)) return pic;
      return pic.replace(/<source\b[^>]*>/gi, '');
    });
    out = out.replace(/<video\b[\s\S]*?<\/video>/gi, (block) => {
      if (!PAINTED_TAG_RE.test(block)) return block;
      return block.replace(/<source\b[^>]*>/gi, '');
    });
    out = out.replace(/<(img|video|source)\b[^>]*>/gi, (tag) => {
      if (!PAINTED_TAG_RE.test(tag)) return tag;
      return tag
        .replace(/\s+srcset\s*=\s*("[^"]*"|'[^']*')/gi, '')
        .replace(/\s+sizes\s*=\s*("[^"]*"|'[^']*')/gi, '')
        .replace(/\s+data-srcset\s*=\s*("[^"]*"|'[^']*')/gi, '');
    });
    out = out.replace(
      /<([a-z][a-z0-9-]*)\b([^>]*\bstyle\s*=\s*["'][^"']*background(?:-image)?\s*:\s*url\([^)]+\)[^"']*["'][^>]*)>(\s*<(?:img|video)\b[^>]*>)/gi,
      (full, tag: string, attrs: string, child: string) => {
        if (!PAINTED_TAG_RE.test(child)) return full;
        if (FILE_PROXY_RE.test(attrs) && !/background(?:-image)?\s*:\s*url\((?!['"]?[^)]*(?:file-proxy|project-files))/i.test(attrs)) {
          return full;
        }
        const newAttrs = attrs
          .replace(
            /(\bstyle\s*=\s*["'])([^"']*)(["'])/i,
            (_s, a: string, css: string, b: string) =>
              `${a}${css.replace(/background-image\s*:\s*url\([^)]+\)\s*;?/gi, 'background-image:none;')}${b}`,
          )
          .replace(/\s+data-(?:bg|bgset|background|background-image|bg-src|lazy-bg)\s*=\s*("[^"]*"|'[^']*')/gi, '');
        return `<${tag}${newAttrs}>${child}`;
      },
    );
    return out;
  });
}

/** Paint generated files onto the nth <img>/<video> — do not rely on old URL matching. */
export function applyPaintedMedia(html: string, paints: PaintedMedia[]): string {
  if (!paints.length) return html;
  const sealed = outsideSwipeReplacer(html, (raw) => {
    let out = raw;
    const imgs = paints.filter((p) => p.tag === 'img');
    if (imgs.length) {
      let n = 0;
      out = out.replace(/<img\b[^>]*>/gi, (tag) => {
        const p = imgs.find((x) => x.index === n);
        n += 1;
        if (!p || isChromePaintTag(tag)) return tag;
        return paintMediaTag(tag, p.url, { poster: p.poster });
      });
    }
    const videos = paints.filter((p) => p.tag === 'video');
    if (videos.length) {
      let n = 0;
      out = out.replace(/<video\b[\s\S]*?<\/video>/gi, (block) => {
        const p = videos.find((x) => x.index === n);
        n += 1;
        if (!p) return block;
        if (p.motion) return motionStillFromVideo(block, p.url);
        const open = block.match(/^<video\b[^>]*>/i)?.[0] || block;
        const painted = paintMediaTag(open.replace(/\/\s*>$/, '>'), p.url, { poster: p.poster });
        if (!/<\/video>/i.test(block)) return painted.endsWith('>') ? painted : `${painted}>`;
        const inner = block.replace(/^<video\b[^>]*>/i, '').replace(/<\/video>\s*$/i, '');
        const cleaned = inner.replace(/<source\b[^>]*>/gi, '');
        return `${painted}${cleaned}</video>`;
      });
    }
    return out;
  });
  const withCss = paints.some((p) => p.motion) ? ensureMotionCss(sealed) : sealed;
  return sealPaintedHtml(withCss);
}

const MOTION_STYLE =
  'object-fit:cover;max-width:100%;animation:restyleMotion 18s ease-in-out infinite alternate;transform-origin:50% 50%;will-change:transform';

/** Keyframes for animated stills — one copy per document. */
export function ensureMotionCss(html: string): string {
  if (/data-restyle-motion-css/i.test(html)) return html;
  const css = '<style data-restyle-motion-css>@keyframes restyleMotion{from{transform:scale(1) translate(0,0)}to{transform:scale(1.08) translate(-1.5%,1%)}}[data-restyle-motion-wrap]{overflow:hidden;display:block;max-width:100%;line-height:0}</style>';
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${css}</head>`);
  return css + html;
}

/**
 * Keep the <video> element (so nth-video indexes stay valid) but make it show
 * a still: poster = our photo, no sources, slow zoom/pan. Wrapped so the zoom
 * cannot bleed outside the original box.
 */
function motionStillFromVideo(block: string, url: string): string {
  let open = (block.match(/^<video\b[^>]*>/i)?.[0] || '<video>').replace(/\/\s*>$/, '>');
  LAZY_ATTR_RE.lastIndex = 0;
  open = open
    .replace(LAZY_ATTR_RE, '')
    .replace(/\s+(?:src|poster|autoplay|loop|controls|preload)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:autoplay|loop|controls)(?=[\s>])/gi, '')
    .replace(/<video\b/i, `<video poster="${url}" preload="none" muted playsinline data-restyle-motion="1"`);
  if (/\bstyle\s*=/i.test(open)) {
    open = open.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i, (_f, q: string, css: string) => {
      let next = String(css || '').trim();
      if (next && !next.endsWith(';')) next += ';';
      return `style=${q}${next}${MOTION_STYLE}${q}`;
    });
  } else {
    open = open.replace(/<video\b/i, `<video style="${MOTION_STYLE}"`);
  }
  return `<div data-restyle-motion-wrap="1">${open}</video></div>`;
}

/** Every spelling the same photo URL can have in saved HTML. */
export function mediaUrlVariants(from: string, pageUrl = ''): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const t = String(s || '').trim();
    if (t.length > 4) out.add(t);
  };
  add(from);
  add(decodeEntities(from));
  add(from.replace(/&/g, '&amp;'));
  add(from.replace(/\//g, '\\/'));
  try { add(decodeURIComponent(from)); } catch { /* ignore */ }
  if (from.startsWith('//')) add(`https:${from}`);
  if (pageUrl) {
    try {
      const abs = new URL(from, pageUrl).href;
      add(abs);
      add(abs.replace(/&/g, '&amp;'));
    } catch { /* ignore */ }
  }
  return [...out];
}

export function replaceMediaUrl(html: string, from: string, to: string, pageUrl = ''): string {
  if (!from || !to || from === to) return html;
  return outsideSwipeReplacer(html, (raw) => {
    const repeats = mediaUrlVariants(from, pageUrl).reduce(
      (n, v) => n + (v.length > 8 ? raw.split(v).length - 1 : 0),
      0,
    );
    if (repeats >= 2) return raw;
    let next = raw;
    for (const v of mediaUrlVariants(from, pageUrl)) {
      if (next.includes(v)) next = next.split(v).join(to);
    }
    next = next.replace(/<(img|source|video)\b[^>]*>/gi, (tag) => {
      if (!tag.includes(to)) return tag;
      return tag
        .replace(/\s+srcset\s*=\s*("[^"]*"|'[^']*')/i, '')
        .replace(/\s+sizes\s*=\s*("[^"]*"|'[^']*')/i, '')
        .replace(/\s+data-srcset\s*=\s*("[^"]*"|'[^']*')/i, '');
    });
    return next;
  });
}

/** Paints already injected so later batches merge instead of wiping them. */
export function readRestylePaints(html: string): PaintedMedia[] {
  const m = html.match(/data-restyle-media[\s\S]*?var paints = (\[[\s\S]*?\]);\s*var LAZY/i);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]) as PaintedMedia[];
    return Array.isArray(arr)
      ? arr.filter((p) => p && p.url && (p.tag === 'img' || p.tag === 'video') && typeof p.index === 'number')
      : [];
  } catch {
    return [];
  }
}

/** Same idea as Clone/Swipe texts: paint by index so SPA hydration cannot restore old src. */
export function injectRestyleMediaScript(html: string, paints: PaintedMedia[]): string {
  const clean = paints.filter((p) => p.url && (p.tag === 'img' || p.tag === 'video') && p.index >= 0);
  if (!clean.length) return html;
  const json = JSON.stringify(clean)
    .replace(/<\/(script|style)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const lazyJson = JSON.stringify(LAZY_ATTRS);
  const script = `<script data-restyle-media>
(function(){
  var paints = ${json};
  var LAZY = ${lazyJson};
  function strip(el){
    if(!el||!el.removeAttribute) return;
    for(var i=0;i<LAZY.length;i++) el.removeAttribute(LAZY[i]);
    if(el.parentElement && el.parentElement.tagName==='PICTURE'){
      var srcs=el.parentElement.querySelectorAll('source');
      for(var s=0;s<srcs.length;s++) srcs[s].remove();
    }
  }
  function clearUnder(el){
    if(!el) return;
    if((el.tagName||'')==='VIDEO'){
      var vs=el.querySelectorAll('source');
      for(var s=0;s<vs.length;s++) vs[s].remove();
    }
    var node=el;
    for(var d=0;d<4 && node;d++){
      try{
        var hasPainted=node===el || (node.querySelector && node.querySelector('img[data-restyled],video[data-restyled]'));
        if(hasPainted && node.style && node.style.backgroundImage && node.style.backgroundImage.indexOf('url')>=0){
          node.style.setProperty('background-image','none','important');
        }
      }catch(e0){}
      node=node.parentElement;
    }
  }
  function isChromeEl(el){
    try{
      var r=el.getBoundingClientRect();
      if(r.width>0 && r.height>0 && r.width<20 && r.height<20) return true;
    }catch(eC){}
    return false;
  }
  function motion(el, url){
    if(!el||!url) return;
    if(el.getAttribute('data-restyle-motion')==='1' && el.getAttribute('poster')===url){ clearUnder(el); return; }
    try{ el.removeAttribute('src'); el.removeAttribute('autoplay'); el.removeAttribute('loop'); el.removeAttribute('controls'); }catch(e0){}
    var vs=el.querySelectorAll('source');
    for(var s=0;s<vs.length;s++) vs[s].remove();
    strip(el);
    try{ el.setAttribute('poster', url); el.poster=url; el.preload='none'; el.muted=true; }catch(e1){}
    try{ el.pause(); }catch(e2){}
    try{
      el.style.objectFit='cover';
      if(!el.style.maxWidth) el.style.maxWidth='100%';
      if(!el.style.animation) el.style.animation='restyleMotion 18s ease-in-out infinite alternate';
      el.style.transformOrigin='50% 50%';
    }catch(e3){}
    el.setAttribute('data-restyle-motion','1');
    el.setAttribute('data-restyled','1');
    clearUnder(el);
  }
  function paint(el, url, poster){
    if(!el||!url) return;
    if(isChromeEl(el)) return;
    if(el.getAttribute('data-restyled')==='1' && (el.getAttribute('src')||el.src)===url){
      clearUnder(el);
      return;
    }
    try{ el.setAttribute('src', url); }catch(e){}
    try{ el.src = url; }catch(e2){}
    if(poster){ try{ el.setAttribute('poster', poster); el.poster=poster; }catch(e3){} }
    strip(el);
    try{
      el.style.objectFit='cover';
      if(!el.style.maxWidth) el.style.maxWidth='100%';
    }catch(eFit){}
    el.setAttribute('data-restyled','1');
    clearUnder(el);
    if((el.tagName||'')==='VIDEO'){
      el.muted=true; el.playsInline=true; el.loop=true; el.autoplay=true;
    }
  }
  var painting=false;
  function apply(){
    if(painting) return;
    painting=true;
    try{
    var imgs=document.querySelectorAll('img');
    var videos=document.querySelectorAll('video');
    for(var i=0;i<paints.length;i++){
      var p=paints[i];
      var el=p.tag==='video'?videos[p.index]:imgs[p.index];
      if(!el) continue;
      if(p.motion) motion(el, p.url);
      else paint(el, p.url, p.poster);
    }
    }finally{ painting=false; }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
  setTimeout(apply, 50);
  setTimeout(apply, 400);
  setTimeout(apply, 1500);
  setTimeout(apply, 4000);
  if(window.MutationObserver && document.documentElement){
    var obs=new MutationObserver(apply);
    obs.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','srcset','poster','style']});
    setTimeout(function(){ obs.disconnect(); }, 25000);
  }
})();
<\/script>`;
  let out = html.replace(/<script\b[^>]*\bdata-restyle-media\b[^>]*>[\s\S]*?<\/script>/gi, '');
  if (clean.some((p) => p.motion)) out = ensureMotionCss(out);
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, (m) => script + m);
  else out += script;
  return out;
}

function outsideSwipeReplacer(html: string, fn: (h: string) => string): string {
  const held: string[] = [];
  let out = html.replace(/<script\b[^>]*\bdata-swipe-replacer\b[^>]*>[\s\S]*?<\/script>/gi, (m) => {
    held.push(m);
    return `<!--RS_SWIPE_${held.length - 1}-->`;
  });
  out = fn(out);
  held.forEach((s, i) => { out = out.replace(`<!--RS_SWIPE_${i}-->`, () => s); });
  return out;
}

export type Palette = {
  primary: string; secondary: string; accent: string; background: string; ink: string;
};

export type PaletteMap = Array<{ from: string; to: string }>;

/**
 * Neutral palette used only when the AI palette call fails. No product
 * guessing here: the real palette is designed by the model from the product.
 */
export function fallbackPalette(_productName = '', _brief = ''): Palette {
  return { primary: '#1f2937', secondary: '#111827', accent: '#374151', background: '#ffffff', ink: '#111111' };
}

/**
 * The page's brand colours: saturated hexes that are neither near-black nor
 * near-white, most used first. This is what the model is asked to remap.
 */
export function topSaturatedHex(html: string, limit = 14): string[] {
  const counts = new Map<string, number>();
  const body = html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  for (const m of body.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const c = parseCssColor(m[0]);
    if (!c) continue;
    const L = luminance(c);
    if (!isSaturated(c) || L < 0.04 || L > 0.93) continue;
    const key = normalizeHex(m[0]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);
}

export function normalizeHex(raw: string): string {
  const s = String(raw || '').trim().toLowerCase();
  const m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return '';
  const h = m[1].length === 3 ? m[1].split('').map((ch) => ch + ch).join('') : m[1];
  return `#${h}`;
}

/** Swap brand hexes for the new ones, everywhere except inside <script>. */
function remapBrandColors(html: string, map: PaletteMap): string {
  const pairs = map
    .map((p) => ({ from: normalizeHex(p.from), to: normalizeHex(p.to) }))
    .filter((p) => p.from && p.to && p.from !== p.to)
    .filter((p) => {
      const c = parseCssColor(p.from);
      if (!c) return false;
      const L = luminance(c);
      return isSaturated(c) && L >= 0.04 && L <= 0.93;
    });
  if (!pairs.length) return html;
  const lookup = new Map(pairs.map((p) => [p.from, p.to]));
  return html.replace(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi, (hex) => {
    const to = lookup.get(normalizeHex(hex));
    return to || hex;
  });
}

/** Never rewrite <script> (Clone/Swipe replacer lives there). */
function outsideScripts(html: string, fn: (h: string) => string): string {
  const held: string[] = [];
  let out = html.replace(/<script\b[\s\S]*?<\/script>/gi, (m) => {
    held.push(m);
    return `<!--RS_SCRIPT_${held.length - 1}-->`;
  });
  out = fn(out);
  held.forEach((s, i) => { out = out.replace(`<!--RS_SCRIPT_${i}-->`, () => s); });
  return out;
}

const NAMED_RGB: Record<string, [number, number, number]> = {
  black: [17, 17, 17], white: [255, 255, 255], red: [220, 38, 38],
  yellow: [250, 204, 21], gold: [234, 179, 8], orange: [234, 88, 12],
  maroon: [127, 29, 29], crimson: [185, 28, 28], tomato: [239, 68, 68],
};

function parseCssColor(raw: string): { r: number; g: number; b: number } | null {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'inherit' || s === 'currentcolor') return null;
  if (NAMED_RGB[s]) return { r: NAMED_RGB[s][0], g: NAMED_RGB[s][1], b: NAMED_RGB[s][2] };
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
  return null;
}

function lin(v: number): number {
  const x = v / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function luminance(c: { r: number; g: number; b: number }): number {
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function contrastRatio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function readableOn(bg: { r: number; g: number; b: number }): string {
  const black = { r: 17, g: 17, b: 17 };
  const white = { r: 255, g: 255, b: 255 };
  return contrastRatio(black, bg) >= contrastRatio(white, bg) ? '#111111' : '#ffffff';
}

function isSaturated(c: { r: number; g: number; b: number }): boolean {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  return max - min > 40 && max > 80;
}

function isLight(c: { r: number; g: number; b: number }): boolean {
  return luminance(c) > 0.72;
}

function isBrightHighlight(c: { r: number; g: number; b: number }): boolean {
  const L = luminance(c);
  const yellowish = c.r > 180 && c.g > 160 && c.b < 180;
  return isSaturated(c) && (L > 0.28 || yellowish);
}

function muteHighlight(c: { r: number; g: number; b: number }): string {
  const t = 0.86;
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${hex(c.r * (1 - t) + 255 * t)}${hex(c.g * (1 - t) + 248 * t)}${hex(c.b * (1 - t) + 230 * t)}`;
}

function cssProp(css: string, name: string): string {
  const re = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i');
  return css.match(re)?.[1]?.trim() || '';
}

function setCssProp(css: string, name: string, value: string): string {
  const re = new RegExp(`((?:^|;)\\s*)${name}\\s*:\\s*[^;]*`, 'i');
  if (re.test(css)) return css.replace(re, `$1${name}:${value}`);
  return `${css}${css.trim() && !css.trim().endsWith(';') ? ';' : ''}${name}:${value}`;
}

function looksLikeControlSel(sel: string): boolean {
  return /btn|cta|button|submit|navbar|footer|\bnav\b/i.test(sel);
}

function rewriteColorDecl(decl: string, forceInk = true): string {
  return decl.replace(/(^|[;\s{])color\s*:\s*([^;}{]+)/gi, (full, pre: string, val: string) => {
    const v = val.trim();
    if (/^#111|^#000|^black|^inherit|^transparent|^currentcolor/i.test(v)) return full;
    if (/var\(--(?:primary|brand|accent|color-primary|bs-primary|secondary)/i.test(v)) {
      return `${pre}color:#111111`;
    }
    const parsed = parseCssColor(v.split(/\s+/)[0] || v);
    if (parsed && isSaturated(parsed) && isLight(parsed) === false && luminance(parsed) < 0.25 && !forceInk) {
      return full;
    }
    if (parsed && !isSaturated(parsed) && luminance(parsed) < 0.35) return `${pre}color:#111111`;
    if (parsed && isSaturated(parsed)) return `${pre}color:#111111`;
    if (/red|orange|crimson|tomato|maroon|gold|yellow|coral|#([0-9a-f]{0,2}[c-f][0-9a-f]{0,2}[0-6])/i.test(v)) {
      return `${pre}color:#111111`;
    }
    return `${pre}color:#111111`;
  });
}

function rewriteBgDecl(decl: string): string {
  return decl.replace(/(^|[;\s{])background(?:-color)?\s*:\s*([^;}{]+)/gi, (full, pre: string, val: string) => {
    const first = val.trim().replace(/^.*?(#(?:[0-9a-f]{3,8})|rgba?\([^)]+\)|[a-z]+).*$/i, '$1');
    const parsed = parseCssColor(first);
    if (parsed && isBrightHighlight(parsed)) {
      const prop = /background-color/i.test(full) ? 'background-color' : 'background';
      return `${pre}${prop}:${muteHighlight(parsed)}`;
    }
    return full;
  });
}

function normalizeCssBlock(css: string): string {
  return css.replace(/([^{}]+)\{([^}]+)\}/g, (full, sel: string, body: string) => {
    if (looksLikeControlSel(sel)) return full;
    return `${sel}{${rewriteBgDecl(rewriteColorDecl(body))}}`;
  });
}

/** Body copy stays black. Neon highlight washes become a pale cream. */
export function ensureReadableText(html: string): string {
  let out = html;
  out = out.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (full, attrs: string, css: string) => {
    if (/\bdata-chimera-theme\b/i.test(attrs) || /\bdata-chimera-theme\b/i.test(full)) return full;
    return `<style${attrs}>${normalizeCssBlock(css)}</style>`;
  });
  out = out.replace(/\bstyle\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi, (_full, quoted: string) => {
    const q = quoted[0];
    let css = rewriteBgDecl(rewriteColorDecl(quoted.slice(1, -1)));
    const bgRaw = cssProp(css, 'background-color') || cssProp(css, 'background');
    const bg = parseCssColor((bgRaw.split(/\s+/)[0] || bgRaw).replace(/url\([^)]*\)/g, '').trim());
    const fg = parseCssColor(cssProp(css, 'color'));
    if (bg && isBrightHighlight(bg)) {
      css = setCssProp(css, /background-color/i.test(css) ? 'background-color' : 'background', muteHighlight(bg));
      css = setCssProp(css, 'color', '#111111');
    } else if (bg && luminance(bg) < 0.28 && isSaturated(bg)) {
      css = setCssProp(css, 'color', `${readableOn(bg)}`);
    } else if (fg && isSaturated(fg) && (!bg || isLight(bg))) {
      css = setCssProp(css, 'color', '#111111');
    }
    return `style=${q}${css}${q}`;
  });
  out = out.replace(/\s(?:color|bgcolor)\s*=\s*("|')([^"']+)\1/gi, (full, q: string, val: string) => {
    if (/bgcolor/i.test(full)) {
      const parsed = parseCssColor(val);
      if (parsed && isBrightHighlight(parsed)) return ` bgcolor=${q}${muteHighlight(parsed)}${q}`;
      return full;
    }
    return ` color=${q}#111111${q}`;
  });
  return out;
}

export function applyPalette(html: string, p: Palette, map: PaletteMap = []): string {
  const ink = '#111111';
  const wash = lightTintHex(p.primary, 0.14);
  const parsedBg = parseCssColor(p.background);
  const background = !parsedBg || luminance(parsedBg) > 0.93 ? lightTintHex(p.primary, 0.10) : p.background;
  const navInk = readableOn(parseCssColor(p.secondary) || { r: 63, g: 42, b: 29 });
  const heading = p.secondary || ink;
  return outsideScripts(html, (raw) => {
    let out = ensureReadableText(remapBrandColors(raw, map));
    const css = `<style data-chimera-theme>
:root,html{
  --text:${ink};--ink:${ink};--color-text:${ink};--text-color:${ink};--body-color:${ink};
  --primary:${p.primary};--color-primary:${p.primary};--brand:${p.primary};--bs-primary:${p.primary};
  --secondary:${p.secondary};--color-secondary:${p.secondary};
  --accent:${p.accent};--brand-color:${p.primary};
  --background:${background};--bg:${background};--surface:${background};
  --heading-color:${heading};
  --highlight:${wash};--marker:${wash};
}
html,body{background:${background} !important;color:${ink} !important;}
html body h1,html body h2,html body h3,html body h4{color:${heading} !important;}
mark{color:${ink} !important;background:${wash} !important;}
button,input[type=submit],input[type=button],.btn,[class*="btn-primary"],[class*="cta"],[class*="CTA"],[class*="order-now"],[class*="OrderNow"]{
  background:${p.primary} !important;border-color:${p.primary} !important;color:#fff !important;
}
button *,[class*="btn"] *,[class*="cta"] *,[class*="CTA"] *{color:#fff !important;}
header,nav,[class*="navbar"]{background:${background} !important;}
footer,[class*="footer"],[class*="Footer"]{
  background:${p.secondary} !important;color:${navInk} !important;
}
footer *,[class*="footer"] *,[class*="Footer"] *{color:${navInk} !important;}
</style>`;
    out = out.replace(/<style\b[^>]*\bdata-chimera-theme\b[^>]*>[\s\S]*?<\/style>/gi, '');
    if (out.includes('</head>')) out = out.replace('</head>', `${css}</head>`);
    else out = css + out;
    return out;
  });
}

function lightTintHex(hex: string, mix = 0.10): string {
  const c = parseCssColor(hex);
  if (!c) return '#fff8f5';
  const ch = (n: number) => Math.round(n * mix + 255 * (1 - mix)).toString(16).padStart(2, '0');
  return `#${ch(c.r)}${ch(c.g)}${ch(c.b)}`;
}

/**
 * Claude often returns only a few from→to pairs. Fill every leftover
 * saturated page hex so competitor brand colours actually become ours:
 * light → pack wash, dark → secondary, mid → primary.
 */
export function expandPaletteMap(oldHex: string[], p: Palette, existing: PaletteMap = []): PaletteMap {
  const out: PaletteMap = [];
  const seen = new Set<string>();
  for (const pair of existing) {
    const from = normalizeHex(pair.from);
    const to = normalizeHex(pair.to);
    if (!from || !to || from === to || seen.has(from)) continue;
    seen.add(from);
    out.push({ from, to });
  }
  for (const raw of oldHex) {
    const from = normalizeHex(raw);
    if (!from || seen.has(from)) continue;
    const c = parseCssColor(from);
    if (!c) continue;
    const L = luminance(c);
    if (L < 0.04 || L > 0.93) continue;
    let to = p.primary;
    if (L > 0.78) to = p.background || lightTintHex(p.primary, 0.10);
    else if (L < 0.18) to = p.secondary;
    else if (L > 0.52) to = lightTintHex(p.primary, 0.42);
    const toN = normalizeHex(to);
    if (!toN || from === toN) continue;
    seen.add(from);
    out.push({ from, to: toN });
  }
  return out;
}
