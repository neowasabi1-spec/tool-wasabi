// SPA rescue: detect when an HTML payload is a JS-rendered SPA shell with
// no server-rendered text, and reach into r.jina.ai to obtain the post-
// render content as markdown, then convert back into a minimal HTML that
// the rewrite extractor can scan.
//
// Used by:
//   - /api/clone-funnel        (server-side fallback inside fetchPageWithFallbacks)
//   - /api/funnel-swap-proxy   (defence in depth: rescues `renderedHtml`
//     before forwarding to the Supabase Edge Function so the Edge Function
//     never sees an empty SPA shell)
//
// Pure functions, no Next.js / Supabase deps — safe to import from any
// route handler or library code.

/**
 * Detect when an HTML payload is a JS-rendered SPA shell with essentially
 * no server-rendered text. Catches Vite/CRA/React-Router/Vue/Svelte/Nuxt
 * static-only builds that ship "<div id=root></div>" and inject everything
 * client-side. Strips scripts/styles/svgs/tags from <body> and checks the
 * residual visible text — less than ~200 chars = empty SPA shell.
 */
export function isSpaShell(html: string): boolean {
  if (!html || html.length < 100) return true;
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const visibleText = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return visibleText.length < 200;
}

/**
 * Render a JS-only page via r.jina.ai. Tries two strategies in order so
 * that we ALWAYS prefer the highest-fidelity output available:
 *
 *   1) `X-Engine: browser` + `X-Return-Format: html`
 *      Jina spins up a real headless Chromium, executes the JS, then
 *      serialises the post-render DOM. The result preserves images,
 *      CSS classes, attributes and the original tag structure — i.e. it
 *      looks like a Playwright snapshot. Slower (10-30s) but allows the
 *      downstream rewrite to keep the visual identity of the page.
 *
 *   2) Markdown fallback (default Jina mode)
 *      If the browser-engine attempt fails (rate-limited, timeout,
 *      Jina free-tier limits, etc.) we fall back to the markdown reader
 *      which is fast and reliable but text-only. We then convert that
 *      markdown into a minimal HTML so the rewrite extractor still
 *      finds <h1>/<p>/<li>/... — the user gets the COPY but loses the
 *      design (no images, no original layout).
 *
 * Returns null when both strategies fail. Optionally pass an
 * `apiKey` (or set JINA_API_KEY env var) to lift Jina's free-tier rate
 * limits and unlock faster browser-mode renders.
 */
export async function rescueViaJina(url: string): Promise<string | null> {
  const apiKey = process.env.JINA_API_KEY?.trim() || '';
  const html = await tryJinaBrowserHtml(url, apiKey);
  if (html) return html;
  const md = await tryJinaMarkdown(url, apiKey);
  if (md) return md;
  return null;
}

/**
 * Strategy 1: Real browser render → full post-render HTML.
 * Preserves visual identity (images, CSS classes, structure).
 */
async function tryJinaBrowserHtml(url: string, apiKey: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = {
      'Accept': 'text/html',
      'X-Return-Format': 'html',
      // Force a real headless Chromium server-side. Without this header
      // Jina uses a "direct" fetch which returns the raw SPA shell.
      'X-Engine': 'browser',
      // Bypass cache so we always get a fresh render — competitors update
      // pricing, dates and offers daily and we want the latest copy.
      'X-No-Cache': 'true',
      // Auto-generate alt text for images so the downstream extractor can
      // pick up image-only content too (testimonial photos, badges, ...).
      'X-With-Generated-Alt': 'true',
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers,
      redirect: 'follow',
      // Real browser renders are slow — give them up to 60s before we
      // fall back to the markdown path (which is much faster).
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      console.warn(`[spa-rescue] jina browser-html HTTP ${res.status} for ${url}`);
      return null;
    }
    const html = await res.text();
    if (!html || html.length < 1000) {
      console.warn(`[spa-rescue] jina browser-html returned ${html?.length ?? 0} chars for ${url}`);
      return null;
    }
    if (isSpaShell(html)) {
      console.warn(`[spa-rescue] jina browser-html still SPA shell (${html.length} chars) for ${url} — JS likely failed to execute`);
      return null;
    }

    // Critical post-processing: rewrite all relative URLs (img src,
    // href, srcset, CSS url(), style="background-image:url(...)") to
    // absolute URLs pointing back to the original origin. Without this,
    // when we publish the cloned page on a different domain the browser
    // tries to load /figmaAssets/*.png from OUR domain → 404 → layout
    // collapses. Doing it server-side once is cheaper than a runtime
    // <base href> tag (which would also redirect <a href> clicks back
    // to the competitor — undesirable).
    const absolutized = absolutizeUrlsInHtml(html, url);
    console.log(`[spa-rescue] jina browser-html OK: ${absolutized.length} chars for ${url}`);
    return absolutized;
  } catch (err) {
    const e = err as { message?: string; cause?: { code?: string } };
    console.warn(`[spa-rescue] jina browser-html failed for ${url}: ${e?.message || String(err)}${e?.cause?.code ? ` (${e.cause.code})` : ''}`);
    return null;
  }
}

/**
 * Rewrite every relative URL in `html` to an absolute URL using
 * `originUrl` as the base. Operates on:
 *   - src=  on <img>, <script>, <source>, <video>, <audio>, <iframe>, <embed>
 *   - href= on <a>, <link>, <area>, <use>
 *   - srcset= on <img> and <source>  (comma-separated descriptors)
 *   - url(...) inside <style>...</style>
 *   - url(...) inside inline style="..." attributes
 *   - data-bg, data-src, data-image, data-original (lazy-load conventions)
 *
 * Skips URLs that are already absolute (http://, https://, //), data:,
 * blob:, mailto:, tel:, javascript:, or pure anchors (#xxx).
 *
 * Exported because the same logic is useful for any cloned-HTML pipeline
 * (e.g. /api/clone-funnel could opt in for non-SPA pages too if needed).
 */
export function absolutizeUrlsInHtml(html: string, originUrl: string): string {
  let base: URL;
  try { base = new URL(originUrl); } catch { return html; }

  const out = html
    // src= on common asset-bearing tags
    .replace(
      /(<(?:img|script|source|video|audio|iframe|embed|track|input)\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi,
      (_m, prefix: string, q: string, val: string) => `${prefix}${q}${absolutize(val, base)}${q}`,
    )
    // href= on link/anchor/area/use/base
    .replace(
      /(<(?:a|link|area|use|base|form)\b[^>]*?\bhref\s*=\s*)(["'])([^"']+)\2/gi,
      (_m, prefix: string, q: string, val: string) => `${prefix}${q}${absolutize(val, base)}${q}`,
    )
    // <form action="...">
    .replace(
      /(<form\b[^>]*?\baction\s*=\s*)(["'])([^"']+)\2/gi,
      (_m, prefix: string, q: string, val: string) => `${prefix}${q}${absolutize(val, base)}${q}`,
    )
    // srcset="x.png 1x, y.png 2x"
    .replace(
      /(<(?:img|source)\b[^>]*?\bsrcset\s*=\s*)(["'])([^"']+)\2/gi,
      (_m, prefix: string, q: string, val: string) => {
        const fixed = val.split(',').map((part) => {
          const trimmed = part.trim();
          if (!trimmed) return part;
          const segments = trimmed.split(/\s+/);
          const u = segments[0];
          const rest = segments.slice(1);
          return [absolutize(u, base), ...rest].join(' ');
        }).join(', ');
        return `${prefix}${q}${fixed}${q}`;
      },
    )
    // url(...) inside <style>...</style>
    .replace(
      /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
      (_m, attrs: string, css: string) => `<style${attrs}>${rewriteCssUrls(css, base)}</style>`,
    )
    // url(...) inside inline style="" attributes
    .replace(
      /(\bstyle\s*=\s*)(["'])([^"']*)\2/gi,
      (_m, prefix: string, q: string, val: string) => `${prefix}${q}${rewriteCssUrls(val, base)}${q}`,
    )
    // Lazy-load attributes: data-src, data-bg, data-image, data-original,
    // data-lazy-src — covers the most common JS lazy-loaders.
    .replace(
      /(\bdata-(?:src|bg|image|original|lazy-src)\s*=\s*)(["'])([^"']+)\2/gi,
      (_m, prefix: string, q: string, val: string) => `${prefix}${q}${absolutize(val, base)}${q}`,
    );

  return out;
}

function rewriteCssUrls(css: string, base: URL): string {
  return css.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/g,
    (_m, q: string, u: string) => `url(${q}${absolutize(u, base)}${q})`,
  );
}

function absolutize(u: string, base: URL): string {
  if (!u) return u;
  const trimmed = u.trim();
  // Already absolute, protocol-relative, data/blob/mailto/tel/js, or pure anchor
  if (/^(?:https?:\/\/|\/\/|data:|blob:|mailto:|tel:|javascript:|#)/i.test(trimmed)) return u;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return u;
  }
}

/**
 * Strategy 2: Markdown fallback → text-only HTML. Used when the browser
 * render times out or hits rate limits. Loses design but keeps the copy.
 */
async function tryJinaMarkdown(url: string, apiKey: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = {
      'Accept': 'text/plain',
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.warn(`[spa-rescue] jina markdown HTTP ${res.status} for ${url}`);
      return null;
    }
    const md = await res.text();
    if (!md || md.length < 200) {
      console.warn(`[spa-rescue] jina markdown returned ${md?.length ?? 0} chars for ${url}`);
      return null;
    }
    const html = jinaMarkdownToHtml(md, url);
    if (isSpaShell(html)) {
      console.warn(`[spa-rescue] jina markdown converted but still empty for ${url}`);
      return null;
    }
    console.log(`[spa-rescue] jina markdown fallback: ${md.length} md → ${html.length} html for ${url}`);
    return html;
  } catch (err) {
    const e = err as { message?: string; cause?: { code?: string } };
    console.warn(`[spa-rescue] jina markdown failed for ${url}: ${e?.message || String(err)}${e?.cause?.code ? ` (${e.cause.code})` : ''}`);
    return null;
  }
}

/**
 * Convert r.jina.ai markdown output into minimal HTML that the rewrite
 * extractor can scan. Tiny, dependency-free converter — we only need
 * structural tags (h1..h6, p, ul/li, ol/li, blockquote) so the extractor
 * finds the texts.
 *
 * Jina's response begins with a small header block (Title / URL Source /
 * Published Time / Markdown Content:) which we strip before converting.
 */
export function jinaMarkdownToHtml(md: string, url: string): string {
  const startIdx = md.indexOf('Markdown Content:');
  const body = startIdx >= 0 ? md.slice(startIdx + 'Markdown Content:'.length) : md;
  const lines = body.split(/\r?\n/);

  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let paragraphBuf: string[] = [];

  function flushParagraph() {
    if (paragraphBuf.length === 0) return;
    const text = paragraphBuf.join(' ').trim();
    if (text) out.push(`<p>${escapeHtml(stripMdInline(text))}</p>`);
    paragraphBuf = [];
  }
  function closeList() {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    // Drop standalone images: ![alt](url)
    if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(line)) continue;

    // Headers
    const hMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (hMatch) {
      flushParagraph();
      closeList();
      const level = hMatch[1].length;
      out.push(`<h${level}>${escapeHtml(stripMdInline(hMatch[2]))}</h${level}>`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^[-*+]\s+(.+?)\s*$/);
    if (ulMatch) {
      flushParagraph();
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${escapeHtml(stripMdInline(ulMatch[1]))}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\d+)[.)]\s+(.+?)\s*$/);
    if (olMatch) {
      flushParagraph();
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${escapeHtml(stripMdInline(olMatch[2]))}</li>`);
      continue;
    }

    // Blockquote
    const bqMatch = line.match(/^>\s?(.*)$/);
    if (bqMatch) {
      flushParagraph();
      closeList();
      out.push(`<blockquote>${escapeHtml(stripMdInline(bqMatch[1]))}</blockquote>`);
      continue;
    }

    // Horizontal rule — drop
    if (/^[-*_]{3,}\s*$/.test(line)) {
      flushParagraph();
      closeList();
      continue;
    }

    closeList();
    paragraphBuf.push(line.trim());
  }

  flushParagraph();
  closeList();

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    `<title>${escapeHtml(stripMdInline(extractFirstHeading(body) || url))}</title>`,
    '</head>',
    '<body>',
    out.join('\n'),
    '</body>',
    '</html>',
  ].join('\n');
}

function extractFirstHeading(md: string): string {
  const m = md.match(/^#{1,6}\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

function stripMdInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
