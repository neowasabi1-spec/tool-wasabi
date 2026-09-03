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
  'srcset', 'data-src', 'data-original', 'data-original-src', 'data-orig-src',
  'data-lazy-src', 'data-lazy', 'data-lazyload', 'data-lazy-load', 'data-url',
  'data-image-src', 'data-image', 'data-thumb', 'data-cfsrc', 'data-cmplz-src',
  'data-wf-src', 'data-echo', 'data-defer-src', 'data-hi-res-src', 'data-actual',
  'data-srcfallback', 'data-srcset', 'data-lazy-srcset', 'data-cfsrcset',
  'data-cmplz-srcset', 'data-wf-srcset',
];

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
    .slice(0, 220);
}

function guessSection(text: string): string {
  const t = text.toLowerCase();
  if (/hero|headline|above the fold/.test(t)) return 'hero';
  if (/testimonial|review|customer/.test(t)) return 'testimonials';
  if (/ingredient|formula|what's inside/.test(t)) return 'ingredients';
  if (/guarantee|refund/.test(t)) return 'guarantee';
  if (/faq|question/.test(t)) return 'faq';
  if (/before|after|compar/.test(t)) return 'comparison';
  if (/pack|bottle|jar|product/.test(t)) return 'product';
  return 'lifestyle';
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

export function collectRestyleSlots(html: string, max = 20, _pageUrl = ''): RestyleSlot[] {
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
    if (JUNK.test(src) || JUNK.test(alt)) return;
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
    if (src && out.length < max) {
      const ctx = nearby(html, m.index, tag.length);
      add(
        src,
        /\.gif(\?|#|$)/i.test(src) ? 'gif' : 'image',
        alt || ctx.slice(0, 80),
        guessSection(`${alt} ${ctx}`),
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
    add(bm[1], classifySrc(bm[1]), 'background', 'hero', 0, 0);
  }

  const metaRe = /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*>/gi;
  while ((m = metaRe.exec(html)) !== null && out.length < max) {
    const content = m[0].match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    add(content, 'image', 'og:image', 'hero', 0, 0);
  }

  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = scriptRe.exec(html)) !== null && out.length < max) {
    const attrs = sm[1] || '';
    if (/data-swipe-replacer|data-restyle-media|data-chimera/i.test(attrs)) continue;
    const body = sm[2] || '';
    const urlRe = /https?:\/\/[^\s"'\\<>]{12,400}/gi;
    let um: RegExpExecArray | null;
    while ((um = urlRe.exec(body)) !== null && out.length < max) {
      const raw = um[0].replace(/\\+\//g, '/').replace(/[,;)}\]]+$/, '');
      const kind = classifySrc(raw);
      if (!kind) continue;
      add(raw, kind, 'embedded', guessSection(nearby(html, sm.index, 80)), 0, 0);
    }
  }

  return out;
}

const LAZY_ATTR_RE = new RegExp(
  `\\s+(?:${LAZY_ATTRS.join('|')})\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`,
  'gi',
);

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
  return t;
}

/** Paint generated files onto the nth <img>/<video> — do not rely on old URL matching. */
export function applyPaintedMedia(html: string, paints: PaintedMedia[]): string {
  if (!paints.length) return html;
  return outsideSwipeReplacer(html, (raw) => {
    let out = raw;
    for (const tagName of ['img', 'video'] as const) {
      const list = paints.filter((p) => p.tag === tagName);
      if (!list.length) continue;
      let n = 0;
      const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
      out = out.replace(re, (tag) => {
        const p = list.find((x) => x.index === n);
        n += 1;
        return p ? paintMediaTag(tag, p.url, { poster: p.poster }) : tag;
      });
    }
    return out;
  });
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
  function paint(el, url, poster){
    if(!el||!url) return;
    if(el.getAttribute('data-restyled')==='1' && (el.getAttribute('src')||el.src)===url) return;
    try{ el.setAttribute('src', url); }catch(e){}
    try{ el.src = url; }catch(e2){}
    if(poster){ try{ el.setAttribute('poster', poster); el.poster=poster; }catch(e3){} }
    strip(el);
    el.setAttribute('data-restyled','1');
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
    return { primary: '#6b21a8', secondary: '#3b0764', accent: '#c084fc', background: '#faf5ff', ink: '#1e1033' };
  }
  if (/collagen|collagene|berry|cherry|pomegranate|melograno/.test(blob)) {
    return { primary: '#b42318', secondary: '#7a1b14', accent: '#f97066', background: '#fff7f6', ink: '#1f100e' };
  }
  if (/saffron|zafferano|turmeric|curcuma|gold|oro/.test(blob)) {
    return { primary: '#c45c12', secondary: '#7a1f1a', accent: '#e8b84a', background: '#fff8f2', ink: '#1a120c' };
  }
  if (/matcha|chlorophyll|green tea|tè verde/.test(blob)) {
    return { primary: '#2f6b3a', secondary: '#1a3d24', accent: '#8fbf6a', background: '#f4faf4', ink: '#122016' };
  }
  return { primary: '#c45c12', secondary: '#3f2a1d', accent: '#d4a017', background: '#faf7f2', ink: '#1a1410' };
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

function collectCssHex(css: string): string[] {
  const counts = new Map<string, number>();
  const re = /#([0-9a-f]{3}|[0-9a-f]{6})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    let h = m[0].toLowerCase();
    if (h.length === 4) h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
    if (/^#([0-9a-f])\1{5}$/i.test(h)) continue;
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h]) => h);
}

function remapHexInCss(css: string, from: string[], to: string[]): string {
  let out = css;
  from.forEach((hex, i) => {
    const next = to[i] || to[0];
    if (!hex || hex === next) return;
    const rx = new RegExp(hex.replace('#', '#?'), 'gi');
    out = out.replace(new RegExp(hex, 'gi'), next);
    void rx;
  });
  return out;
}

export function applyPalette(html: string, p: {
  primary: string; secondary: string; accent: string; background: string; ink: string;
}): string {
  const neu = [p.primary, p.secondary, p.accent, p.background, p.ink, p.primary, p.secondary, p.accent];
  return outsideScripts(html, (raw) => {
    let out = raw.replace(/<style\b[\s\S]*?<\/style>/gi, (block) => {
      const old = collectCssHex(block);
      return remapHexInCss(block, old, neu);
    });
    out = out.replace(/\bstyle\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi, (full) => {
      const old = collectCssHex(full);
      return remapHexInCss(full, old, neu);
    });
    const css = `<style data-chimera-theme>
:root,html{
  --primary:${p.primary};--color-primary:${p.primary};--brand:${p.primary};--bs-primary:${p.primary};
  --secondary:${p.secondary};--accent:${p.accent};
  --background:${p.background};--bg:${p.background};--text:${p.ink};--ink:${p.ink};
}
html,body{background:${p.background} !important;color:${p.ink} !important;}
a{color:${p.accent};}
button,input[type=submit],input[type=button],.btn,[class*="btn-primary"],[class*="cta"],[class*="CTA"]{
  background:${p.primary} !important;border-color:${p.primary} !important;color:#fff !important;
}
header,nav,[class*="navbar"],[class*="hero"],[class*="Hero"]{background:${p.secondary} !important;}
footer,[class*="footer"]{background:${p.secondary} !important;color:#fff !important;}
</style>`;
    out = out.replace(/<style\b[^>]*\bdata-chimera-theme\b[^>]*>[\s\S]*?<\/style>/gi, '');
    if (out.includes('</head>')) out = out.replace('</head>', `${css}</head>`);
    else out = css + out;
    return out;
  });
}
