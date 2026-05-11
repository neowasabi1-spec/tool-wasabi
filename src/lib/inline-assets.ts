// Self-contained asset inliner for cloned HTML.
//
// Problem: Wasabi clones a page once and stores it in the DB. The stored
// HTML still references the source's CSS/font files by URL. When the
// source site changes (Vite hash rotation), goes offline (Replit free-tier
// sleep), or its origin doesn't send CORS headers needed by Vite's
// <link crossorigin="anonymous">, the cloned preview renders without
// styles and looks completely blank.
//
// Fix: at clone time we fetch every external stylesheet referenced by
// the page server-side, recursively inline @import + font url() (woff,
// woff2, ttf, otf, eot) as data: URIs, and replace each <link
// rel="stylesheet"> with a <style> block. The resulting snapshot is
// self-contained and survives source-side changes/outages.
//
// Defensive limits:
//   - max 15 stylesheets per page
//   - max 600 KB per CSS file
//   - max 300 KB per inlined font
//   - 5 s per fetch, 15 s total budget per page
//   - 6 concurrent fetches
//   - any failure leaves the original <link> tag intact (no breakage)

const MAX_STYLESHEETS = 15;
const MAX_STYLESHEET_BYTES = 600 * 1024;
const MAX_FONT_BYTES = 300 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const TOTAL_BUDGET_MS = 15000;
const CONCURRENCY = 6;

const FONT_EXT_RE = /\.(woff2|woff|ttf|otf|eot)(\?[^"')\s]*)?$/i;
const FONT_MIME: Record<string, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
};

interface CssLinkMatch {
  full: string;
  href: string;
  media?: string;
}

function extractStylesheetLinks(html: string): CssLinkMatch[] {
  const matches: CssLinkMatch[] = [];
  const linkRegex = /<link\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null) {
    const attrs = m[1];
    if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(attrs)) continue;
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const href = hrefMatch[1].trim();
    if (!href || href.startsWith('data:') || href.startsWith('blob:') || href.startsWith('#')) continue;
    const mediaMatch = attrs.match(/\bmedia\s*=\s*["']([^"']+)["']/i);
    matches.push({ full: m[0], href, media: mediaMatch?.[1] });
    if (matches.length >= MAX_STYLESHEETS) break;
  }
  return matches;
}

async function fetchBinary(
  url: string,
  timeoutMs: number,
): Promise<{ ok: true; bytes: ArrayBuffer; contentType: string } | { ok: false }> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: '*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false };
    const bytes = await res.arrayBuffer();
    return { ok: true, bytes, contentType: res.headers.get('content-type') || '' };
  } catch {
    return { ok: false };
  }
}

function bufferToBase64(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('base64');
}

function escapeForStyleBlock(css: string): string {
  // Defensive: a stylesheet could contain "</style>" inside a string literal
  // or a comment. Escaping just the closing tag is enough to keep parser sane.
  return css.replace(/<\/style>/gi, '<\\/style>');
}

async function inlineFontsInCss(cssText: string, cssBaseUrl: string, deadline: number): Promise<string> {
  const fontUrls = new Set<string>();
  const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = urlPattern.exec(cssText)) !== null) {
    const u = m[2].trim();
    if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('#')) continue;
    if (!FONT_EXT_RE.test(u)) continue;
    try {
      fontUrls.add(new URL(u, cssBaseUrl).toString());
    } catch {
      /* skip malformed */
    }
  }
  if (fontUrls.size === 0) return cssText;

  const list = Array.from(fontUrls).slice(0, 12);
  const dataUriMap = new Map<string, string>();
  await Promise.all(
    list.map(async (fontUrl) => {
      if (Date.now() > deadline) return;
      const remaining = Math.max(800, deadline - Date.now());
      const result = await fetchBinary(fontUrl, Math.min(FETCH_TIMEOUT_MS, remaining));
      if (!result.ok) return;
      if (result.bytes.byteLength > MAX_FONT_BYTES) return;
      const extMatch = fontUrl.match(FONT_EXT_RE);
      if (!extMatch) return;
      const mime = FONT_MIME[extMatch[1].toLowerCase()] || 'application/octet-stream';
      dataUriMap.set(fontUrl, `data:${mime};base64,${bufferToBase64(result.bytes)}`);
    }),
  );
  if (dataUriMap.size === 0) return cssText;

  return cssText.replace(urlPattern, (full, _quote, url) => {
    const u = String(url).trim();
    if (u.startsWith('data:')) return full;
    if (!FONT_EXT_RE.test(u)) return full;
    try {
      const abs = new URL(u, cssBaseUrl).toString();
      const dataUri = dataUriMap.get(abs);
      if (dataUri) return `url("${dataUri}")`;
    } catch {
      /* skip */
    }
    return full;
  });
}

async function inlineImportsInCss(cssText: string, cssBaseUrl: string, deadline: number, depth = 0): Promise<string> {
  if (depth >= 2) return cssText;
  const importRe = /@import\s+(?:url\(\s*)?["']?([^"')]+)["']?\s*\)?\s*([^;]*);/gi;
  const imports: { full: string; url: string; media: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(cssText)) !== null) {
    const url = m[1].trim();
    if (!url || url.startsWith('data:')) continue;
    try {
      const abs = new URL(url, cssBaseUrl).toString();
      imports.push({ full: m[0], url: abs, media: (m[2] || '').trim() });
    } catch {
      /* skip */
    }
  }
  if (imports.length === 0) return cssText;

  const replacements = new Map<string, string>();
  await Promise.all(
    imports.slice(0, 8).map(async (imp) => {
      if (Date.now() > deadline) return;
      const remaining = Math.max(800, deadline - Date.now());
      const result = await fetchBinary(imp.url, Math.min(FETCH_TIMEOUT_MS, remaining));
      if (!result.ok) return;
      if (result.bytes.byteLength > MAX_STYLESHEET_BYTES) return;
      let nested = new TextDecoder().decode(result.bytes);
      try {
        nested = await inlineImportsInCss(nested, imp.url, deadline, depth + 1);
      } catch {
        /* nested import failure: keep CSS without those imports */
      }
      try {
        nested = await inlineFontsInCss(nested, imp.url, deadline);
      } catch {
        /* font failure inside import: keep CSS without font inlining */
      }
      const wrapped = imp.media
        ? `@media ${imp.media} {\n${nested}\n}`
        : nested;
      replacements.set(imp.full, `\n/* inlined: ${imp.url} */\n${wrapped}\n`);
    }),
  );
  if (replacements.size === 0) return cssText;
  let out = cssText;
  for (const [orig, repl] of replacements) {
    out = out.split(orig).join(repl);
  }
  return out;
}

export async function inlineExternalAssets(html: string, baseUrl: string): Promise<string> {
  try {
    const links = extractStylesheetLinks(html);
    if (links.length === 0) return html;

    const startedAt = Date.now();
    const deadline = startedAt + TOTAL_BUDGET_MS;

    const resolved = links.map((link) => {
      let absUrl: string | null = null;
      try {
        absUrl = new URL(link.href, baseUrl).toString();
      } catch {
        /* skip malformed */
      }
      return { link, absUrl };
    });

    const replacements = new Map<string, string>();
    let cursor = 0;
    const runWorker = async () => {
      while (cursor < resolved.length) {
        const idx = cursor++;
        const { link, absUrl } = resolved[idx];
        if (!absUrl) continue;
        if (Date.now() > deadline) continue;
        const remaining = Math.max(800, deadline - Date.now());
        const result = await fetchBinary(absUrl, Math.min(FETCH_TIMEOUT_MS, remaining));
        if (!result.ok) continue;
        if (result.bytes.byteLength > MAX_STYLESHEET_BYTES) continue;

        let css = new TextDecoder().decode(result.bytes);
        try {
          css = await inlineImportsInCss(css, absUrl, deadline);
        } catch {
          /* import inlining failure: keep external @imports as-is */
        }
        try {
          css = await inlineFontsInCss(css, absUrl, deadline);
        } catch {
          /* font inlining failure: keep external url() references */
        }
        const mediaAttr = link.media ? ` media="${link.media}"` : '';
        const styleTag = `<style data-inlined-from="${absUrl}"${mediaAttr}>\n${escapeForStyleBlock(css)}\n</style>`;
        replacements.set(link.full, styleTag);
      }
    };
    const workers: Promise<void>[] = [];
    const workerCount = Math.min(CONCURRENCY, resolved.length);
    for (let k = 0; k < workerCount; k++) workers.push(runWorker());
    await Promise.all(workers);

    if (replacements.size === 0) {
      console.log(`[inline-assets] no stylesheets could be inlined for ${baseUrl} (${links.length} candidates)`);
      return html;
    }

    let out = html;
    for (const [orig, repl] of replacements) {
      out = out.split(orig).join(repl);
    }
    const elapsed = Date.now() - startedAt;
    console.log(
      `[inline-assets] inlined ${replacements.size}/${links.length} stylesheets (+ fonts/imports) in ${elapsed}ms for ${baseUrl}`,
    );
    return out;
  } catch (err) {
    console.warn(`[inline-assets] unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
    return html;
  }
}
