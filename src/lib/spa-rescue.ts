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

    // Critical post-processing: stabilize the HTML so it renders
    // correctly when served from a different origin (Netlify clone vs.
    // tsl.burnfatfrequency.com). See stabilizeClonedHtml for the three
    // layers (absolutize URLs + <base href> + neutralize <a> links).
    const stabilized = stabilizeClonedHtml(html, url);
    console.log(`[spa-rescue] jina browser-html OK: ${stabilized.length} chars for ${url} (stabilized)`);
    return stabilized;
  } catch (err) {
    const e = err as { message?: string; cause?: { code?: string } };
    console.warn(`[spa-rescue] jina browser-html failed for ${url}: ${e?.message || String(err)}${e?.cause?.code ? ` (${e.cause.code})` : ''}`);
    return null;
  }
}

/**
 * One-shot stabilizer for cloned HTML that will be served from a
 * different origin than the source page (typical when publishing a
 * Wasabi-rewritten clone on Netlify).
 *
 * Three layers, in order:
 *
 *   1. Absolutize every relative URL (img/css/js/srcset/url()/data-*).
 *      Without this, /figmaAssets/*.png → 404 from cute-cupcake.netlify.app.
 *
 *   2. Inject <base href="https://origin/"> as a safety net so URLs
 *      created at runtime by the bundle JS (Vite/React/Next dynamic
 *      imports, lazy <picture>, fetch('/api/...')) also resolve to the
 *      original origin. The static absolutize covers ~95%; <base>
 *      catches the rest for free.
 *
 *   3. Neutralize <a href> so a visitor clicking on the published
 *      clone doesn't get hijacked to the competitor site. The original
 *      href is preserved in data-original-href so the editor / a future
 *      "Replace CTAs" step can pick them up. Anchors (#…),
 *      javascript:, mailto:, tel: are left alone.
 *
 * Idempotent: running it twice is a no-op (already-absolute URLs are
 * detected, an existing <base> is replaced, neutralized anchors keep
 * their data-original-href).
 */
export function stabilizeClonedHtml(html: string, originUrl: string): string {
  let out = absolutizeUrlsInHtml(html, originUrl);
  out = injectBaseHref(out, originUrl);
  out = neutralizeAnchorHrefs(out);
  out = unlockPageScroll(out);
  return out;
}

/**
 * Marketing SPAs frequently lock body scroll on mount (bootstrap modals,
 * body-scroll-lock library, exit-intent popups, cookie banners, video
 * lightboxes…). When Jina captures the post-render snapshot the lock
 * state is frozen into the HTML — the published clone inherits a body
 * stuck at `overflow:hidden` and the visitor can't scroll past the
 * first viewport.
 *
 * Two-step defence:
 *   1. Strip `overflow:*` and `position:fixed` declarations from any
 *      inline `style=""` on the <html> or <body> root tag (the most
 *      common vector — a modal library typically does this with
 *      `document.body.style.overflow = 'hidden'`).
 *   2. Inject a final <style> at the end of <head> with !important
 *      overrides so any stylesheet rule (including ones we can't
 *      easily parse) loses the cascade against ours.
 *
 * We deliberately avoid touching `position` on body (some legitimate
 * layouts rely on it). Overflow alone unlocks ~95% of cases.
 */
function unlockPageScroll(html: string): string {
  let out = html;

  // Strip blocking inline overflow on <html> / <body>.
  out = out.replace(
    /(<(?:html|body)\b[^>]*?\bstyle\s*=\s*)(["'])([^"']*)\2/gi,
    (_full, prefix: string, q: string, val: string) => {
      const cleaned = val
        // overflow / overflow-x / overflow-y declarations
        .replace(/(?:^|;)\s*overflow(?:-x|-y)?\s*:[^;]+;?/gi, ';')
        // position:fixed (would prevent normal page flow scroll on root)
        .replace(/(?:^|;)\s*position\s*:\s*fixed\b[^;]*;?/gi, ';')
        // height / max-height that would clip the document
        .replace(/(?:^|;)\s*(?:max-)?height\s*:\s*100(?:vh|%)\s*;?/gi, ';')
        .replace(/;{2,}/g, ';')
        .replace(/^\s*;|;\s*$/g, '')
        .trim();
      return cleaned ? `${prefix}${q}${cleaned}${q}` : '';
    },
  );

  // Inject an !important override as the LAST rule in <head> so it
  // wins the cascade against the page's own stylesheets.
  const fixStyle =
    '<style id="wasabi-scroll-fix">' +
    'html,body{overflow:visible!important;overflow-x:hidden!important;' +
    'overflow-y:auto!important;height:auto!important;' +
    'min-height:100vh!important}' +
    'body{position:static!important}' +
    '</style>';

  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, `${fixStyle}</head>`);
  } else if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/(<head\b[^>]*>)/i, `$1${fixStyle}`);
  } else {
    out = `<head>${fixStyle}</head>${out}`;
  }
  return out;
}

/**
 * Inject `<base href="https://origin/">` into <head> (after <meta charset>
 * if present so it doesn't fight with byte-order-mark detection). If the
 * page already has a <base> we replace it. If <head> is missing we
 * synthesise a minimal one. Without an explicit trailing slash the
 * browser may treat the base as a file rather than a directory, so we
 * always end with `/`.
 */
function injectBaseHref(html: string, originUrl: string): string {
  let baseHref: string;
  try {
    const u = new URL(originUrl);
    baseHref = `${u.origin}/`;
  } catch {
    return html;
  }
  const tag = `<base href="${baseHref}">`;

  // Replace any existing <base ...> tag.
  if (/<base\b[^>]*>/i.test(html)) {
    return html.replace(/<base\b[^>]*>/i, tag);
  }
  // Inject right after <head> (preserving whatever attributes head has).
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/(<head\b[^>]*>)/i, `$1\n  ${tag}`);
  }
  // No <head> at all — wrap the whole thing.
  return `<head>${tag}</head>${html}`;
}

/**
 * Replace every `<a href="…">` (or `<a … href='…'>`) whose href would
 * navigate the visitor away from our domain with a neutralized version:
 *
 *   <a href="#" data-original-href="https://competitor.com/buy" data-cloned-cta="1" …>
 *
 * Skips:
 *   - Anchors (`#section`) — same-page navigation, harmless.
 *   - `mailto:`, `tel:`, `javascript:` — non-navigational protocols.
 *   - Already-neutralized anchors (idempotent re-runs).
 *
 * The `data-original-href` lets a future "Replace CTAs" step in the
 * editor surface every external link the user needs to swap. The
 * `data-cloned-cta` flag makes them queryable from one selector.
 */
function neutralizeAnchorHrefs(html: string): string {
  return html.replace(
    /<a\b([^>]*?)\bhref\s*=\s*(["'])([^"']+)\2([^>]*)>/gi,
    (full, pre: string, q: string, href: string, post: string) => {
      const hrefTrim = href.trim();
      // Keep harmless / non-navigational hrefs as-is.
      if (
        !hrefTrim ||
        hrefTrim === '#' ||
        /^(?:#|mailto:|tel:|javascript:)/i.test(hrefTrim)
      ) {
        return full;
      }
      // Already neutralized? skip.
      if (/\bdata-original-href\s*=/.test(pre + post)) return full;
      const safeHref = hrefTrim.replace(/"/g, '&quot;');
      return `<a${pre}href="#" data-original-href="${safeHref}" data-cloned-cta="1"${post}>`;
    },
  );
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
