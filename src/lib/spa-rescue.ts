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
 * Render a JS-only page via r.jina.ai (markdown mode = real JS rendering)
 * and convert the response into a minimal HTML payload the downstream
 * extractor can scan. Returns null when Jina is unreachable or returns
 * something useless. Timeout: 30s.
 */
export async function rescueViaJina(url: string): Promise<string | null> {
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(jinaUrl, {
      headers: {
        // Default Jina format = markdown (which DOES render the JS server
        // side). `X-Return-Format: html` returns the raw shell, useless.
        'Accept': 'text/plain',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.warn(`[spa-rescue] jina HTTP ${res.status} for ${url}`);
      return null;
    }
    const md = await res.text();
    if (!md || md.length < 200) {
      console.warn(`[spa-rescue] jina returned ${md?.length ?? 0} chars for ${url}`);
      return null;
    }
    const html = jinaMarkdownToHtml(md, url);
    if (isSpaShell(html)) {
      console.warn(`[spa-rescue] jina markdown converted but still empty for ${url}`);
      return null;
    }
    return html;
  } catch (err) {
    const e = err as { message?: string; cause?: { code?: string } };
    console.warn(`[spa-rescue] jina failed for ${url}: ${e?.message || String(err)}${e?.cause?.code ? ` (${e.cause.code})` : ''}`);
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
