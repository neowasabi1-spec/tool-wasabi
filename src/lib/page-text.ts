/**
 * Readable text of a live web page, for feeding a sales page (offer or
 * competitor) to the model. The research / brief / swipe steps must see what
 * the page actually says: product name, ingredients, mechanism, price,
 * guarantee, testimonials. Without this the model can only guess.
 *
 * Direct fetch first (same UA as the media extractor, which is what worked on
 * affiliate offer pages), Jina Reader as a fallback for JS-only pages.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', bull: '•',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
  return String.fromCodePoint(code);
}

/** Visible text of an HTML document, block elements on their own lines. */
export function htmlToReadableText(html: string, max = 30_000): string {
  let s = String(html || '');
  // Non-content subtrees.
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|template|iframe|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // Keep image alts: they often carry ingredient / benefit labels.
  s = s.replace(/<img\b[^>]*\balt=["']([^"']{3,120})["'][^>]*>/gi, (_, alt) => ` [image: ${alt}] `);
  // Block boundaries → newlines so headlines / bullets stay separate.
  s = s.replace(/<\/(p|div|section|article|header|footer|main|aside|nav|li|ul|ol|h[1-6]|tr|td|th|blockquote|figure|figcaption|dt|dd|summary|details|label|button)\s*>/gi, '\n');
  s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_, l) => `\n${'#'.repeat(Number(l))} `);
  // Remaining tags.
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  // Whitespace: collapse runs inside a line, drop blank-line spam, dedupe
  // consecutive identical lines (sticky headers, repeated CTAs).
  const lines: string[] = [];
  let prev = '';
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.replace(/[ \t\u00a0]+/g, ' ').trim();
    if (!line || line === prev) continue;
    lines.push(line);
    prev = line;
  }
  const out = lines.join('\n');
  return out.length > max ? out.slice(0, max) : out;
}

export type PageText = { url: string; finalUrl: string; text: string; via: 'direct' | 'jina' | 'none' };

async function fetchDirect(url: string): Promise<{ finalUrl: string; html: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': UA,
      },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (type && !/html|xml|text/i.test(type)) return null;
    const html = await res.text();
    return { finalUrl: res.url || url, html };
  } catch {
    return null;
  }
}

async function fetchJina(url: string): Promise<string> {
  try {
    const headers: Record<string, string> = { 'X-Return-Format': 'text' };
    if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
    const res = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(45_000) });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Fetch a page and return its readable text. `min` guards against
 * cookie-wall / JS-shell pages: if the direct fetch yields less than that,
 * Jina Reader (which renders) is tried.
 */
export async function fetchPageText(url: string, opts: { max?: number; min?: number } = {}): Promise<PageText> {
  const max = opts.max ?? 30_000;
  const min = opts.min ?? 600;
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return { url: clean, finalUrl: clean, text: '', via: 'none' };

  const direct = await fetchDirect(clean);
  const directText = direct ? htmlToReadableText(direct.html, max) : '';
  if (directText.length >= min) return { url: clean, finalUrl: direct!.finalUrl, text: directText, via: 'direct' };

  const jina = (await fetchJina(clean)).replace(/[ \t]+\n/g, '\n').trim();
  if (jina.length >= Math.min(min, directText.length + 1)) {
    return { url: clean, finalUrl: direct?.finalUrl || clean, text: jina.slice(0, max), via: 'jina' };
  }
  return { url: clean, finalUrl: direct?.finalUrl || clean, text: directText, via: directText ? 'direct' : 'none' };
}

/** Prompt block for a sales page: what it is + the verbatim text. */
export function pageTextBlock(label: string, page: PageText | null | undefined): string {
  if (!page?.text) return '';
  return `${label} — ${page.finalUrl}\n(verbatim readable text of the live page; product facts MUST come from here, never invented)\n"""\n${page.text}\n"""`;
}
