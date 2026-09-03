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
}

const JUNK =
  /favicon|sprite|pixel|1x1|tracking|doubleclick|visa|mastercard|amex|paypal|klarna|apple-?pay|loader|spinner|spacer|logo\.svg/i;

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

export function collectRestyleSlots(html: string, max = 20): RestyleSlot[] {
  const out: RestyleSlot[] = [];
  const seen = new Set<string>();
  const add = (src: string, kind: RestyleKind, alt: string, section: string, w: number, h: number) => {
    if (!src || src.startsWith('data:') || seen.has(src)) return;
    if (/\.svg(\?|#|$)/i.test(src)) return;
    if (JUNK.test(src) || JUNK.test(alt)) return;
    seen.add(src);
    out.push({ id: out.length, src, kind, alt, section, width: w, height: h });
  };

  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null && out.length < max) {
    const tag = m[0];
    const src =
      tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]
      || tag.match(/\bdata-src\s*=\s*["']([^"']+)["']/i)?.[1]
      || tag.match(/\bdata-lazy-src\s*=\s*["']([^"']+)["']/i)?.[1]
      || tag.match(/\bdata-original\s*=\s*["']([^"']+)["']/i)?.[1]
      || '';
    const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] || '';
    const w = Number.parseInt(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] || '0', 10);
    const h = Number.parseInt(tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] || '0', 10);
    if ((w && w < 40) || (h && h < 40)) continue;
    const ctx = nearby(html, m.index, tag.length);
    const kind: RestyleKind = /\.gif(\?|#|$)/i.test(src) ? 'gif' : 'image';
    add(src, kind, alt || ctx.slice(0, 80), guessSection(`${alt} ${ctx}`), w, h);
  }

  const videoRe = /<video\b[\s\S]*?<\/video>/gi;
  while ((m = videoRe.exec(html)) !== null && out.length < max) {
    const block = m[0];
    const src =
      block.match(/\bsrc\s*=\s*["']([^"']+\.(?:mp4|webm|mov|m4v)[^"']*)["']/i)?.[1]
      || block.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]
      || '';
    const poster = block.match(/\bposter\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    const ctx = nearby(html, m.index, block.length);
    if (src) add(src, 'video', ctx.slice(0, 80), 'video', 0, 0);
    else if (poster) add(poster, 'image', 'video poster', 'video', 0, 0);
  }

  const bgRe = /background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  let bm: RegExpExecArray | null;
  while ((bm = bgRe.exec(html)) !== null && out.length < max) {
    add(bm[1], /\.gif(\?|#|$)/i.test(bm[1]) ? 'gif' : 'image', 'background', 'hero', 0, 0);
  }

  return out;
}

export function replaceMediaUrl(html: string, from: string, to: string): string {
  if (!from || !to || from === to) return html;
  let out = html.split(from).join(to);
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    if (!tag.includes(to)) return tag;
    return tag.replace(/\s+srcset\s*=\s*("[^"]*"|'[^']*')/i, '');
  });
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
