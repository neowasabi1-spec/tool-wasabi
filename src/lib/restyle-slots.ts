import { inferLandingSection, isDecorativeMedia } from '@/lib/landing-media';

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
}

export type PaintedMedia = {
  tag: 'img' | 'video';
  index: number;
  url: string;
  poster?: string;
};

const LAZY_ATTRS = [
  'srcset', 'sizes', 'data-src', 'data-original', 'data-original-src', 'data-orig-src',
  'data-lazy-src', 'data-lazy', 'data-lazyload', 'data-lazy-load', 'data-url',
  'data-image-src', 'data-image', 'data-thumb', 'data-cfsrc', 'data-cmplz-src',
  'data-wf-src', 'data-echo', 'data-defer-src', 'data-hi-res-src', 'data-actual',
  'data-srcfallback', 'data-srcset', 'data-lazy-srcset', 'data-cfsrcset',
  'data-cmplz-srcset', 'data-wf-srcset',
];

const FILE_PROXY_RE = /\/api\/projecthub\/file-proxy/i;

const JUNK =
  /favicon|sprite|pixel|1x1|tracking|doubleclick|visa|mastercard|amex|paypal|klarna|apple-?pay|loader|spinner|spacer|logo\.svg|google-analytics|facebook\.com\/tr|hotjar|trustpilot|woff2?|placeholder|blank\.|lqip/i;

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

function nearby(html: string, index: number, tagLen: number): string {
  const from = Math.max(0, index - 500);
  const to = Math.min(html.length, index + tagLen + 500);
  return html
    .slice(from, to)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 360);
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
    section: string,
    w: number,
    h: number,
    dom?: { tag: 'img' | 'video'; index: number },
  ) => {
    const src = decodeEntities(String(raw || '').trim());
    if (!src || isPlaceholder(src) || seen.has(src)) return;
    if (JUNK.test(src) || JUNK.test(alt) || isDecorativeMedia(src, alt)) return;
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
      context: alt,
      domTag: dom?.tag,
      domIndex: dom?.index,
    });
  };

  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  let imgIndex = 0;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const src = pickImgSrc(tag);
    const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] || '';
    const w = Number.parseInt(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] || '0', 10);
    const h = Number.parseInt(tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] || '0', 10);
    const cls = tag.match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    const ctx = nearby(html, m.index, tag.length);
    const hasCopy = `${alt} ${ctx}`.replace(/\s+/g, ' ').trim().length >= 24;
    if (w > 0 && h > 0 && w < 72 && h < 72 && !hasCopy) {
      imgIndex++;
      continue;
    }
    if (src && out.length < max && !isDecorativeMedia(src, alt, cls, tag.slice(0, 200))) {
      const kind: RestyleKind = /\.gif(\?|#|$)/i.test(src) ? 'gif' : 'image';
      add(
        src,
        kind,
        (alt ? `${alt} ${ctx}` : ctx).slice(0, 280),
        imgSection(alt, cls, ctx, m.index, html.length, kind),
        w,
        h,
        { tag: 'img', index: imgIndex },
      );
    }
    imgIndex++;
  }

  const videoRe = /<video\b[\s\S]*?<\/video>/gi;
  let videoIndex = 0;
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
      if (src) add(decodeEntities(src), 'video', ctx.slice(0, 80), 'video', 0, 0, { tag: 'video', index: videoIndex });
      else if (poster) add(decodeEntities(poster), 'image', 'video poster', 'video', 0, 0, { tag: 'video', index: videoIndex });
    }
    videoIndex++;
  }

  if (out.length >= max) return out;

  const bgRe = /background(?:-image)?\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  let bm: RegExpExecArray | null;
  while ((bm = bgRe.exec(html)) !== null && out.length < max) {
    if (isDecorativeMedia(bm[1])) continue;
    add(
      bm[1],
      classifySrc(bm[1]),
      'background',
      slotSection('hero banner background', bm.index, html.length, 'image'),
      0,
      0,
    );
  }

  return out;
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
  return mergeObjectFit(t);
}

/** Drop leftover <source>, srcset, and parent backgrounds so old media cannot sit under the new file. */
export function sealPaintedHtml(html: string): string {
  return outsideSwipeReplacer(html, (raw) => {
    let out = raw;
    out = out.replace(/<picture\b[\s\S]*?<\/picture>/gi, (pic) => {
      if (!FILE_PROXY_RE.test(pic)) return pic;
      return pic.replace(/<source\b[^>]*>/gi, '');
    });
    out = out.replace(/<video\b[\s\S]*?<\/video>/gi, (block) => {
      if (!FILE_PROXY_RE.test(block)) return block;
      return block.replace(/<source\b[^>]*>/gi, '');
    });
    out = out.replace(/<(img|video|source)\b[^>]*>/gi, (tag) => {
      if (!FILE_PROXY_RE.test(tag)) return tag;
      return tag
        .replace(/\s+srcset\s*=\s*("[^"]*"|'[^']*')/gi, '')
        .replace(/\s+sizes\s*=\s*("[^"]*"|'[^']*')/gi, '')
        .replace(/\s+data-srcset\s*=\s*("[^"]*"|'[^']*')/gi, '');
    });
    out = out.replace(
      /<([a-z][a-z0-9-]*)\b([^>]*\bstyle\s*=\s*["'][^"']*background(?:-image)?\s*:\s*url\([^)]+\)[^"']*["'][^>]*)>(\s*<(?:img|video)\b[^>]*>)/gi,
      (full, tag: string, attrs: string, child: string) => {
        if (!FILE_PROXY_RE.test(child)) return full;
        if (FILE_PROXY_RE.test(attrs) && !/background(?:-image)?\s*:\s*url\((?!['"]?[^)]*file-proxy)/i.test(attrs)) {
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
        return p ? paintMediaTag(tag, p.url, { poster: p.poster }) : tag;
      });
    }
    const videos = paints.filter((p) => p.tag === 'video');
    if (videos.length) {
      let n = 0;
      out = out.replace(/<video\b[\s\S]*?<\/video>/gi, (block) => {
        const p = videos.find((x) => x.index === n);
        n += 1;
        if (!p) return block;
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
  return sealPaintedHtml(sealed);
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
  function paint(el, url, poster){
    if(!el||!url) return;
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
  function tooSmall(el){
    try{
      var r=el.getBoundingClientRect();
      if(r.width>0 && r.height>0 && (r.width<32||r.height<32)) return true;
    }catch(e){}
    return false;
  }
  var painting=false;
  function apply(){
    if(painting) return;
    painting=true;
    try{
    var imgs=document.querySelectorAll('img');
    var videos=document.querySelectorAll('video');
    var extras=[];
    for(var i=0;i<paints.length;i++){
      var p=paints[i];
      var el=p.tag==='video'?videos[p.index]:imgs[p.index];
      if(!el){ extras.push(p); continue; }
      paint(el, p.url, p.poster);
    }
    var ei=0;
    for(var k=0;k<imgs.length && ei<extras.length;k++){
      if(imgs[k].getAttribute('data-restyled')) continue;
      if(tooSmall(imgs[k])) continue;
      paint(imgs[k], extras[ei].url, extras[ei].poster);
      ei++;
    }
    var bgs=document.querySelectorAll('[style*="background"]');
    for(var b=0;b<bgs.length && ei<extras.length;b++){
      if(bgs[b].getAttribute('data-restyled')) continue;
      if(bgs[b].querySelector && bgs[b].querySelector('img,video,picture')) continue;
      try{
        bgs[b].style.setProperty('background-image','url("'+extras[ei].url+'")','important');
        bgs[b].setAttribute('data-restyled','1');
        ei++;
      }catch(e4){}
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

export function fallbackPalette(productName: string, brief = ''): {
  primary: string; secondary: string; accent: string; background: string; ink: string;
} {
  const blob = `${productName} ${brief}`.toLowerCase();
  if (/nad|nmn|purple|viola|violet/.test(blob)) {
    return { primary: '#6b21a8', secondary: '#3b0764', accent: '#7c3aed', background: '#ffffff', ink: '#111111' };
  }
  if (/collagen|collagene|berry|cherry|pomegranate|melograno/.test(blob)) {
    return { primary: '#b42318', secondary: '#7a1b14', accent: '#c2410c', background: '#ffffff', ink: '#111111' };
  }
  if (/saffron|zafferano|turmeric|curcuma|gold|oro/.test(blob)) {
    return { primary: '#c45c12', secondary: '#3f2a1d', accent: '#b45309', background: '#ffffff', ink: '#111111' };
  }
  if (/matcha|chlorophyll|green tea|tè verde/.test(blob)) {
    return { primary: '#2f6b3a', secondary: '#1a3d24', accent: '#3f7a4a', background: '#ffffff', ink: '#111111' };
  }
  return { primary: '#c45c12', secondary: '#3f2a1d', accent: '#b45309', background: '#ffffff', ink: '#111111' };
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

export function applyPalette(html: string, p: {
  primary: string; secondary: string; accent: string; background: string; ink: string;
}): string {
  const ink = '#111111';
  const wash = '#f3efe4';
  const navInk = readableOn(parseCssColor(p.secondary) || { r: 63, g: 42, b: 29 });
  return outsideScripts(html, (raw) => {
    let out = ensureReadableText(raw);
    const css = `<style data-chimera-theme>
:root,html{
  --text:${ink};--ink:${ink};--color-text:${ink};--text-color:${ink};--body-color:${ink};
  --heading-color:${ink};--bs-body-color:${ink};--font-color:${ink};
  --primary:${ink};--color-primary:${ink};--brand:${ink};--bs-primary:${ink};--accent:${ink};
  --background:${p.background};--bg:${p.background};
  --highlight:${wash};--marker:${wash};
}
html,body{background:${p.background} !important;color:${ink} !important;}
html body,html body p,html body li,html body td,html body th,html body span,html body div,
html body font,html body label,html body small,html body em,html body i,html body u,
html body strong,html body b,html body a,html body h1,html body h2,html body h3,
html body h4,html body h5,html body h6,html body blockquote,html body figcaption{
  color:${ink} !important;
}
mark{color:${ink} !important;background:${wash} !important;}
button,input[type=submit],input[type=button],.btn,[class*="btn-primary"],[class*="cta"],[class*="CTA"]{
  background:${p.primary} !important;border-color:${p.primary} !important;color:#fff !important;
}
button *,[class*="btn"] *,[class*="cta"] *,[class*="CTA"] *{color:#fff !important;}
nav,[class*="navbar"],footer,[class*="footer"]{
  background:${p.secondary} !important;color:${navInk} !important;
}
nav *,footer *,[class*="navbar"] *,[class*="footer"] *{color:${navInk} !important;}
</style>`;
    out = out.replace(/<style\b[^>]*\bdata-chimera-theme\b[^>]*>[\s\S]*?<\/style>/gi, '');
    if (out.includes('</head>')) out = out.replace('</head>', `${css}</head>`);
    else out = css + out;
    return out;
  });
}
