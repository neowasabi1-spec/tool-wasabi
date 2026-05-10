import { NextRequest, NextResponse } from 'next/server';
import { getCoreKnowledge } from '@/knowledge/copywriting';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Cached at module init — read once per server process. ~28K tokens.
let _kbCache: string | null = null;
function getKb(): string {
  if (_kbCache === null) {
    try {
      _kbCache = getCoreKnowledge();
    } catch (err) {
      console.warn('[clone-funnel] knowledge base load failed:', err);
      _kbCache = '';
    }
  }
  return _kbCache;
}

const IS_SERVERLESS = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

async function getBrowser() {
  const { getSingletonBrowser } = await import('@/lib/get-browser');
  return getSingletonBrowser();
}

/**
 * Tries multiple strategies to fetch a remote HTML page from a serverless env.
 *   1) native fetch with a realistic browser UA
 *   2) native fetch with a Googlebot UA (bypasses some anti-bot walls)
 *   3) r.jina.ai proxy (returns readable content) — last resort
 */
/**
 * Heuristic: detect when an HTML payload is a JS-rendered SPA shell with
 * essentially no server-rendered text. Catches Vite/CRA/React-Router/Vue/
 * Svelte builds that ship "<div id='root'></div>" and inject everything
 * client-side. We compute the visible text inside <body> after stripping
 * scripts/styles/svgs/tags — if there are fewer than 200 chars of human
 * text, the fetch is useless and we should fall through to the next
 * attempt (chrome → googlebot → r.jina.ai which renders the JS for us).
 */
function isSpaShell(html: string): boolean {
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

async function fetchPageWithFallbacks(url: string): Promise<
  | { ok: true; html: string; method: string }
  | { ok: false; error: string; details: string[] }
> {
  const details: string[] = [];
  const attempts: Array<{ name: string; run: () => Promise<Response> }> = [
    {
      name: 'chrome-desktop',
      run: () => fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'max-age=0',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      }),
    },
    {
      name: 'googlebot',
      run: () => fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      }),
    },
  ];

  for (const attempt of attempts) {
    try {
      const res = await attempt.run();
      if (res.ok) {
        const html = await res.text();
        if (html && html.length > 50) {
          // Reject SPA shells (e.g. Vite/CRA pages with empty <body>) so the
          // loop falls through to r.jina.ai which renders the JS for us.
          if (isSpaShell(html)) {
            details.push(`${attempt.name}: SPA shell detected (${html.length} chars, no body text) — falling through to JS-rendering proxy`);
            console.warn(`[clone-funnel] ${attempt.name} returned SPA shell for ${url} — trying next attempt`);
          } else {
            return { ok: true, html, method: attempt.name };
          }
        } else {
          details.push(`${attempt.name}: empty response (${html.length} chars)`);
        }
      } else {
        details.push(`${attempt.name}: HTTP ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      const e = err as { message?: string; cause?: { code?: string; message?: string; errno?: number } };
      const msg = e?.message || String(err);
      const causeCode = e?.cause?.code || e?.cause?.message || '';
      details.push(`${attempt.name}: ${msg}${causeCode ? ` (cause: ${causeCode})` : ''}`);
      console.error(`[clone-funnel] attempt ${attempt.name} failed:`, msg, 'cause:', e?.cause);
    }
  }

  // Final fallback: r.jina.ai returns the JS-rendered page content as
  // markdown. We then convert the markdown to a minimal pseudo-HTML so the
  // downstream extractor (which scans <h1>..<h6>/<p>/<li>/<button>/<a>...)
  // still works without any change.
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(jinaUrl, {
      headers: {
        // Default Jina format = markdown (which DOES render the JS server
        // side). Asking for `X-Return-Format: html` returns the raw shell,
        // which is useless for SPAs — that's the original bug we're fixing.
        'Accept': 'text/plain',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const md = await res.text();
      if (md && md.length > 200) {
        const html = jinaMarkdownToHtml(md, url);
        if (html && !isSpaShell(html)) {
          console.log(`[clone-funnel] jina-proxy rescued SPA: ${md.length} md → ${html.length} html`);
          return { ok: true, html, method: 'jina-proxy' };
        }
        details.push(`jina-proxy: markdown converted but still empty`);
      } else {
        details.push(`jina-proxy: empty response (${md.length} chars)`);
      }
    } else {
      details.push(`jina-proxy: HTTP ${res.status}`);
    }
  } catch (err) {
    const e = err as { message?: string; cause?: { code?: string } };
    details.push(`jina-proxy: ${e?.message || String(err)}${e?.cause?.code ? ` (${e.cause.code})` : ''}`);
  }

  return { ok: false, error: details[0] || 'all fetch attempts failed', details };
}

/**
 * Convert r.jina.ai markdown output into minimal HTML that
 * `extractTextsFromHtml` can scan. We deliberately keep the converter
 * tiny — no markdown library — because all we need is structural tags
 * (h1..h6, p, ul/li, ol/li, a, button) so the extractor finds the texts.
 *
 * Jina's response begins with a small header block (Title / URL Source /
 * Published Time / Markdown Content:) which we strip before converting.
 */
function jinaMarkdownToHtml(md: string, url: string): string {
  // Strip Jina header block
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

    // Blank line → end of paragraph / list
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    // Strip standalone image lines: ![alt](url)  (we don't extract images)
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

    // Horizontal rule — ignore
    if (/^[-*_]{3,}\s*$/.test(line)) {
      flushParagraph();
      closeList();
      continue;
    }

    // Default: append to current paragraph buffer (next blank line flushes it)
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
    // images first (so we don't keep the alt text as a link)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // links: keep text only
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // bold / italic / code markers
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

interface ExtractedText {
  index: number;
  originalText: string;
  rawText?: string;
  tagName: string;
  fullTag: string;
  classes: string;
  attributes: string;
  context: string;
  position: number;
}

function extractTextsFromHtml(html: string): ExtractedText[] {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '');

  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : cleaned;

  const texts: ExtractedText[] = [];
  const extracted = new Set<string>();
  let idx = 0;

  const textTags = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'li', 'td', 'th', 'dt', 'dd',
    'button', 'a', 'label', 'figcaption', 'caption',
    'blockquote', 'summary', 'legend',
  ];

  const blockTags = new Set([
    'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'blockquote', 'figure', 'figcaption', 'form', 'fieldset',
    'button', 'details', 'summary',
  ]);

  for (const tag of textTags) {
    const regex = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let match;
    while ((match = regex.exec(bodyHtml)) !== null) {
      const attrs = match[1] || '';
      const innerHTML = match[2];
      const plainText = innerHTML.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

      if (plainText.length < 2 || !/[a-zA-Z]/.test(plainText)) continue;
      if (extracted.has(plainText)) continue;
      if (plainText.includes('{') && plainText.includes('}') && plainText.includes('=>')) continue;

      const hasBlockChild = Array.from(innerHTML.matchAll(/<(div|section|article|p|h[1-6]|ul|ol|li|table|tr|td|th|blockquote|form|button)[^>]*>/gi))
        .some((m) => {
          const childTag = m[1].toLowerCase();
          if (!blockTags.has(childTag)) return false;
          const childContent = innerHTML.slice(m.index! + m[0].length);
          const closeIdx = childContent.indexOf(`</${childTag}`);
          if (closeIdx === -1) return false;
          const childText = childContent.slice(0, closeIdx).replace(/<[^>]*>/g, '').trim();
          return childText.length >= 2;
        });
      if (hasBlockChild) continue;

      extracted.add(plainText);

      const classMatch = attrs.match(/class=["']([^"']*)["']/i);
      const idMatch = attrs.match(/id=["']([^"']*)["']/i);
      const cls = classMatch ? classMatch[1] : '';
      const id = idMatch ? idMatch[1] : '';

      texts.push({
        index: idx++,
        originalText: plainText,
        rawText: innerHTML !== plainText && innerHTML.length <= 5000 ? innerHTML : undefined,
        tagName: tag,
        fullTag: `<${tag}${id ? ` id="${id}"` : ''}${cls ? ` class="${cls}"` : ''}>`,
        classes: cls,
        attributes: attrs.trim().substring(0, 200),
        context: tag,
        position: match.index || 0,
      });
    }
  }

  const spanDivRegex = /<(span|div|strong|em|b|i)([^>]*)>([^<]{3,500})<\/\1>/gi;
  let sdMatch;
  while ((sdMatch = spanDivRegex.exec(bodyHtml)) !== null) {
    const tag = sdMatch[1].toLowerCase();
    const attrs = sdMatch[2] || '';
    const text = sdMatch[3].replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 3 || !/[a-zA-Z]/.test(text) || extracted.has(text)) continue;
    extracted.add(text);

    const classMatch = attrs.match(/class=["']([^"']*)["']/i);
    const cls = classMatch ? classMatch[1] : '';

    texts.push({
      index: idx++,
      originalText: text,
      tagName: tag,
      fullTag: `<${tag}${cls ? ` class="${cls}"` : ''}>`,
      classes: cls,
      attributes: attrs.trim().substring(0, 200),
      context: tag,
      position: sdMatch.index || 0,
    });
  }

  const attrRegex = /(alt|title|placeholder|aria-label)=["']([^"']{3,200})["']/gi;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(bodyHtml)) !== null) {
    const attrName = attrMatch[1];
    const val = attrMatch[2].trim();
    if (val.length < 3 || !/[a-zA-Z]/.test(val) || extracted.has(val) || val.startsWith('http')) continue;
    extracted.add(val);

    texts.push({
      index: idx++,
      originalText: val,
      tagName: '',
      fullTag: `${attrName}="${val}"`,
      classes: '',
      attributes: `${attrName}="${val}"`,
      context: `attr:${attrName}`,
      position: 0,
    });
  }

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    const titleText = titleMatch[1].trim();
    if (titleText.length >= 3 && /[a-zA-Z]/.test(titleText) && !extracted.has(titleText)) {
      extracted.add(titleText);
      texts.push({
        index: idx++,
        originalText: titleText,
        tagName: 'title',
        fullTag: '<title>',
        classes: '',
        attributes: '',
        context: 'title',
        position: -1,
      });
    }
  }

  return texts;
}

// Fetch a CORS-blocked stylesheet via Playwright's network context
async function fetchCssViaPage(page: import('playwright-core').Page, href: string): Promise<string | null> {
  try {
    const css = await page.evaluate(async (url: string) => {
      try {
        const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (!res.ok) return null;
        return await res.text();
      } catch {
        return null;
      }
    }, href);
    return css;
  } catch {
    return null;
  }
}

// Clone a page using Playwright headless browser - renders JS, captures full DOM + CSS
async function cloneWithBrowser(url: string, viewport: 'desktop' | 'mobile' = 'desktop', keepScripts = false): Promise<{
  html: string;
  title: string;
  renderedSize: number;
  cssCount: number;
  imgCount: number;
  isJsRendered: boolean;
}> {
  const isMobile = viewport === 'mobile';
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: isMobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile,
    hasTouch: isMobile,
    ignoreHTTPSErrors: true,
    bypassCSP: true,
  });

  const page = await context.newPage();

  try {
    // Try networkidle first (best for SPA), fallback to load
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      await page.goto(url, { waitUntil: 'load', timeout: 25000 });
    }

    // Wait for JS frameworks to finish rendering (React, Vue, Angular hydration)
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        if (document.readyState === 'complete') {
          resolve();
        } else {
          window.addEventListener('load', () => resolve());
        }
      });
    });
    await page.waitForTimeout(3000);

    // Wait for common SPA selectors to appear
    try {
      await page.waitForSelector('main, #app, #root, [data-page], .page-wrapper, article, .container, section', { timeout: 5000 });
    } catch { /* OK if not found */ }

    // Slow scroll to trigger ALL lazy-loading (images, videos, animations)
    await page.evaluate(async () => {
      const scrollStep = Math.floor(window.innerHeight * 0.7);
      const maxScroll = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      for (let y = 0; y <= maxScroll; y += scrollStep) {
        window.scrollTo({ top: y, behavior: 'instant' });
        await new Promise(r => setTimeout(r, 400));
        // Trigger intersection observers by dispatching scroll event
        window.dispatchEvent(new Event('scroll'));
      }
      // Scroll back to top
      window.scrollTo({ top: 0, behavior: 'instant' });
      await new Promise(r => setTimeout(r, 500));

      // Second pass — sometimes lazy loaders need two scrolls
      for (let y = 0; y <= maxScroll; y += scrollStep * 2) {
        window.scrollTo({ top: y, behavior: 'instant' });
        await new Promise(r => setTimeout(r, 200));
      }
      window.scrollTo({ top: 0, behavior: 'instant' });
    });

    // Wait for images to finish loading after scroll
    await page.waitForTimeout(2000);

    // Force ALL lazy images to load by promoting data-src → src on the LIVE page
    await page.evaluate(() => {
      document.querySelectorAll('img').forEach(img => {
        const lazySources = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-ll-src', 'data-image', 'data-wf-src'];
        for (const attr of lazySources) {
          const val = img.getAttribute(attr);
          if (val && val.length > 5) {
            const curSrc = img.getAttribute('src') || '';
            const isPlaceholder = !curSrc || curSrc.length < 100 && (
              curSrc.includes('data:image') || curSrc.includes('placeholder') ||
              curSrc.includes('blank') || curSrc.includes('pixel') ||
              curSrc.includes('spacer') || curSrc.includes('grey') ||
              curSrc.includes('gray') || curSrc.includes('1x1') ||
              curSrc === '#' || curSrc === '' || curSrc.includes('transparent')
            );
            if (isPlaceholder || !curSrc) {
              img.setAttribute('src', val);
            }
          }
        }
        img.removeAttribute('loading');
      });
    });
    await page.waitForTimeout(1500);

    await page.evaluate(async () => {
      const imgs = Array.from(document.querySelectorAll('img'));
      await Promise.allSettled(
        imgs.filter(img => !img.complete).map(img =>
          new Promise<void>(resolve => {
            img.onload = () => resolve();
            img.onerror = () => resolve();
            setTimeout(resolve, 3000);
          })
        )
      );
    });

    // Capture the actual rendered image sources from the live DOM
    const liveImageSources: Record<number, string> = await page.evaluate(() => {
      const sources: Record<number, string> = {};
      document.querySelectorAll('img').forEach((img, i) => {
        const realSrc = (img as HTMLImageElement).currentSrc || img.getAttribute('src') || '';
        if (realSrc && !realSrc.startsWith('data:image') && realSrc.length > 10) {
          sources[i] = realSrc;
        }
      });
      return sources;
    });

    // Collect CORS-blocked stylesheet URLs for server-side fetch
    const corsBlockedUrls: string[] = await page.evaluate(() => {
      const blocked: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        if (sheet.href) {
          try { sheet.cssRules; } catch { blocked.push(sheet.href); }
        }
      }
      return blocked;
    });

    // Fetch CORS-blocked CSS from within the page context (same origin fetch)
    const corsFixedCss: Record<string, string> = {};
    for (const href of corsBlockedUrls) {
      const css = await fetchCssViaPage(page, href);
      if (css) corsFixedCss[href] = css;
    }

    // Extract the FULL rendered page with all CSS inlined
    const result = await page.evaluate((args: { pageUrl: string; corsFixedCss: Record<string, string>; keepScripts: boolean; liveImgSrc: Record<number, string> }) => {
      const { pageUrl, corsFixedCss: fetchedCss, keepScripts: preserveScripts, liveImgSrc } = args;

      function abs(relative: string): string {
        if (!relative || relative.startsWith('data:') || relative.startsWith('blob:') || 
            relative.startsWith('#') || relative.startsWith('mailto:') || relative.startsWith('tel:') ||
            relative.startsWith('javascript:')) return relative;
        if (relative.startsWith('http://') || relative.startsWith('https://')) return relative;
        try { return new URL(relative, pageUrl).href; } catch { return relative; }
      }

      function fixCssUrls(cssText: string, baseUrl: string): string {
        return cssText.replace(/url\(\s*["']?(?!data:|https?:|blob:)([^"')]+)["']?\s*\)/gi, (_m: string, u: string) => {
          try { return `url("${new URL(u.trim(), baseUrl).href}")`; } catch { return `url("${u}")`; }
        });
      }

      // 1. Collect ALL CSS
      const allCss: string[] = [];
      const corsBlockedLinks: string[] = [];

      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const rules = Array.from(sheet.cssRules || []);
          let cssText = rules.map(r => r.cssText).join('\n');
          cssText = fixCssUrls(cssText, sheet.href || pageUrl);
          if (cssText.trim()) {
            const source = sheet.href ? `/* From: ${sheet.href.substring(0, 120)} */\n` : '';
            allCss.push(source + cssText);
          }
        } catch {
          if (sheet.href) {
            // Check if we fetched this CSS server-side
            if (fetchedCss[sheet.href]) {
              let css = fetchedCss[sheet.href];
              css = fixCssUrls(css, sheet.href);
              allCss.push(`/* Fetched: ${sheet.href.substring(0, 120)} */\n` + css);
            } else {
              corsBlockedLinks.push(sheet.href);
            }
          }
        }
      }

      // Also grab <style> tags in the body
      document.querySelectorAll('body style').forEach(s => {
        const text = s.textContent || '';
        if (text.trim()) allCss.push('/* Inline body style */\n' + fixCssUrls(text, pageUrl));
      });

      // 2. Get the rendered DOM
      const docClone = document.documentElement.cloneNode(true) as HTMLElement;

      // 3. Remove scripts (unless keepScripts for quiz pages)
      if (!preserveScripts) {
        docClone.querySelectorAll('script').forEach(s => s.remove());
        docClone.querySelectorAll('noscript').forEach(s => s.remove());

        // 4. Remove inline event handlers
        docClone.querySelectorAll('*').forEach(el => {
          const attrs = Array.from(el.attributes);
          attrs.forEach(attr => {
            if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
          });
        });
      } else {
        // keepScripts=true: preserviamo gli <script> di runtime (Swiper init,
        // FAQ accordion, sticky bar, image gallery, ...) ma rimuoviamo comunque:
        //  - <noscript> (mostrano messaggi "Activate JavaScript")
        //  - inline event handlers (onclick=, onerror=, ...) per ridurre la
        //    superficie di attacco senza buttare il JS sano della pagina.
        docClone.querySelectorAll('noscript').forEach(s => s.remove());
        docClone.querySelectorAll('*').forEach(el => {
          const attrs = Array.from(el.attributes);
          attrs.forEach(attr => {
            if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
          });
        });
      }

      // 5. Handle stylesheet links
      docClone.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
        const href = link.getAttribute('href');
        if (href && corsBlockedLinks.includes(href)) {
          link.setAttribute('href', abs(href));
        } else {
          link.remove();
        }
      });

      // 6. Fix ALL lazy-loaded images — promote data attributes to src
      const allImgs = docClone.querySelectorAll('img');
      allImgs.forEach((img, idx) => {
        const lazySources = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-ll-src', 'data-srcset', 'data-image', 'data-wf-src'];

        // First: if we captured a real currentSrc from the live DOM, use it
        const liveSrc = liveImgSrc[idx];
        const curSrc = img.getAttribute('src') || '';
        const isPlaceholder = !curSrc || curSrc.startsWith('data:image') ||
          /placeholder|blank|pixel|spacer|grey|gray|1x1|transparent/i.test(curSrc) ||
          curSrc === '#';

        if (liveSrc && (isPlaceholder || !curSrc)) {
          img.setAttribute('src', abs(liveSrc));
        }

        for (const attr of lazySources) {
          const val = img.getAttribute(attr);
          if (!val) continue;
          const currentSrc = img.getAttribute('src') || '';
          const stillPlaceholder = !currentSrc || currentSrc.startsWith('data:image') ||
            /placeholder|blank|pixel|spacer|grey|gray|1x1|transparent/i.test(currentSrc) ||
            currentSrc === '#';

          if (stillPlaceholder) {
            img.setAttribute('src', abs(val));
          }
          img.setAttribute(attr, abs(val));
        }

        // Force eager loading
        img.removeAttribute('loading');
        img.setAttribute('loading', 'eager');
        // Fix existing src
        const src = img.getAttribute('src');
        if (src) img.setAttribute('src', abs(src));
        // Fix srcset
        const srcset = img.getAttribute('srcset');
        if (srcset) {
          img.setAttribute('srcset', srcset.split(',').map((e: string) => {
            const parts = e.trim().split(/\s+/);
            if (parts[0]) parts[0] = abs(parts[0]);
            return parts.join(' ');
          }).join(', '));
        }
      });

      // 6b. Handle <picture> elements — ensure <source> srcset is absolute
      docClone.querySelectorAll('picture source').forEach(source => {
        const srcset = source.getAttribute('srcset');
        if (srcset) {
          source.setAttribute('srcset', srcset.split(',').map((e: string) => {
            const parts = e.trim().split(/\s+/);
            if (parts[0]) parts[0] = abs(parts[0]);
            return parts.join(' ');
          }).join(', '));
        }
        const dataSrcset = source.getAttribute('data-srcset');
        if (dataSrcset && !srcset) {
          source.setAttribute('srcset', dataSrcset.split(',').map((e: string) => {
            const parts = e.trim().split(/\s+/);
            if (parts[0]) parts[0] = abs(parts[0]);
            return parts.join(' ');
          }).join(', '));
        }
      });

      // 7. Fix all other URLs
      docClone.querySelectorAll('[src],[href],[poster],[action]').forEach(el => {
        ['src', 'href', 'poster', 'action'].forEach(attr => {
          const val = el.getAttribute(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('blob:') && !val.startsWith('#') && !val.startsWith('mailto:') && !val.startsWith('tel:') && !val.startsWith('javascript:')) {
            el.setAttribute(attr, abs(val));
          }
        });
      });

      // 8. Fix background-image in inline styles & data-bg
      docClone.querySelectorAll('[style]').forEach(el => {
        const style = el.getAttribute('style') || '';
        if (style.includes('url(')) {
          el.setAttribute('style', fixCssUrls(style, pageUrl));
        }
      });
      docClone.querySelectorAll('[data-bg]').forEach(el => {
        const bg = el.getAttribute('data-bg');
        if (bg) {
          const absBg = abs(bg);
          el.setAttribute('data-bg', absBg);
          const existing = el.getAttribute('style') || '';
          el.setAttribute('style', `${existing}; background-image: url("${absBg}");`);
        }
      });

      // 9. Capture computed styles for elements that might lose styling from CORS CSS
      if (corsBlockedLinks.length > 0) {
        const critical = docClone.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,button,img,div[class],section[class],span[class]');
        const liveEls = document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,button,img,div[class],section[class],span[class]');
        const criticalProps = ['color','background-color','background-image','font-size','font-weight','font-family',
          'padding','margin','border','border-radius','display','flex-direction','justify-content','align-items',
          'text-align','width','max-width','height','gap','line-height','text-decoration','box-shadow','opacity','position'];

        critical.forEach((el, i) => {
          if (i >= liveEls.length) return;
          const live = liveEls[i];
          const cs = getComputedStyle(live);
          const styles: string[] = [];
          for (const prop of criticalProps) {
            const val = cs.getPropertyValue(prop);
            if (val && val !== 'none' && val !== 'normal' && val !== '0px' && val !== 'auto' && val !== 'rgba(0, 0, 0, 0)') {
              styles.push(`${prop}:${val}`);
            }
          }
          if (styles.length > 0) {
            const existing = el.getAttribute('style') || '';
            el.setAttribute('style', existing + ';' + styles.join(';'));
          }
        });
      }

      // 10. Build final HTML with inlined CSS
      const head = docClone.querySelector('head');
      if (head) {
        head.querySelectorAll('style').forEach(s => s.remove());
        if (allCss.length > 0) {
          const styleEl = document.createElement('style');
          styleEl.textContent = allCss.filter(c => !c.includes('CORS blocked')).join('\n\n');
          const firstChild = head.querySelector('meta[charset]')?.nextSibling || head.firstChild;
          if (firstChild) { head.insertBefore(styleEl, firstChild); } else { head.appendChild(styleEl); }
        }
        // Remove ALL existing CSP meta tags (they block resources when served from different origin)
        head.querySelectorAll('meta[http-equiv="Content-Security-Policy"], meta[http-equiv="content-security-policy"]').forEach(m => m.remove());
        // Remove existing referrer meta
        head.querySelectorAll('meta[name="referrer"]').forEach(m => m.remove());

        // Inject no-referrer so CDNs with hotlink protection serve images
        const refMeta = document.createElement('meta');
        refMeta.setAttribute('name', 'referrer');
        refMeta.setAttribute('content', 'no-referrer');
        head.insertBefore(refMeta, head.firstChild);
      }

      const finalHtml = '<!DOCTYPE html>\n' + docClone.outerHTML;

      return {
        html: finalHtml,
        title: document.title || '',
        cssCount: allCss.length,
        imgCount: docClone.querySelectorAll('img').length,
        corsLinks: corsBlockedLinks,
      };
    }, { pageUrl: url, corsFixedCss, keepScripts, liveImgSrc: liveImageSources });

    return {
      html: result.html,
      title: result.title,
      renderedSize: result.html.length,
      cssCount: result.cssCount,
      imgCount: result.imgCount,
      isJsRendered: false,
    };
  } finally {
    await context.close();
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    try {
      body = await request.json();
    } catch (jsonErr) {
      return NextResponse.json({ error: `Invalid JSON body: ${jsonErr instanceof Error ? jsonErr.message : 'parse error'}` }, { status: 400 });
    }
    const { cloneMode, url } = body as { cloneMode?: string; url?: string };
    const viewport: 'desktop' | 'mobile' | 'both' = (body.viewport as 'desktop' | 'mobile' | 'both') || 'desktop';
    const keepScriptsFlag: boolean = !!body.keepScripts;
    console.log(`[clone-funnel] request: mode=${cloneMode}, url=${url}, viewport=${viewport}, serverless=${IS_SERVERLESS}`);

    // IDENTICAL MODE: use Playwright headless browser for full page rendering
    if (cloneMode === 'identical' && url) {
      if (IS_SERVERLESS) {
        console.log(`⚠️ Serverless detected, using direct fetch for clone: ${url}`);
        const cleanUrl = String(url).trim();
        if (!/^https?:\/\//i.test(cleanUrl)) {
          return NextResponse.json({ error: `Invalid URL (must start with http:// or https://): ${cleanUrl}` }, { status: 400 });
        }

        const result = await fetchPageWithFallbacks(cleanUrl);
        if (!result.ok) {
          return NextResponse.json(
            { error: `Unable to clone the page: ${result.error}`, details: result.details },
            { status: 502 }
          );
        }

        return NextResponse.json({
          success: true,
          content: result.html,
          mobileContent: null,
          format: 'html',
          mode: 'identical',
          originalSize: result.html.length,
          finalSize: result.html.length,
          cssInlined: false,
          jsRendered: false,
          method: result.method,
          title: result.html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '',
        });
      }

      console.log(`🔄 Clone IDENTICAL with Playwright (${viewport}${keepScriptsFlag ? ', keepScripts' : ''}): ${url}`);

      try {
        const result = await cloneWithBrowser(url, 'desktop', keepScriptsFlag);
        
        console.log(`✅ Desktop clone completed: ${result.renderedSize.toLocaleString()} chars, ${result.cssCount} CSS, ${result.imgCount} images`);

        let mobileResult = null;
        if (viewport === 'mobile' || viewport === 'both') {
          try {
            console.log(`📱 Clone MOBILE with Playwright: ${url}`);
            mobileResult = await cloneWithBrowser(url, 'mobile', keepScriptsFlag);
            console.log(`✅ Mobile clone completed: ${mobileResult.renderedSize.toLocaleString()} chars`);
          } catch (mobileErr) {
            console.error('⚠️ Mobile clone failed, desktop only:', mobileErr);
          }
        }

        return NextResponse.json({
          success: true,
          content: viewport === 'mobile' && mobileResult ? mobileResult.html : result.html,
          mobileContent: mobileResult?.html || null,
          format: 'html',
          mode: 'identical',
          originalSize: result.renderedSize,
          finalSize: result.html.length,
          mobileFinalSize: mobileResult?.html.length || null,
          cssInlined: true,
          cssCount: result.cssCount,
          imgCount: result.imgCount,
          jsRendered: false,
          title: result.title,
        });
      } catch (playwrightErr) {
        console.error('❌ Playwright error:', playwrightErr);
        
        // Fallback: simple fetch if Playwright fails
        console.log('⚠️ Fallback to simple fetch...');
        try {
          const htmlResponse = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(15000),
          });

          if (!htmlResponse.ok) {
            return NextResponse.json(
              { error: `Download error: HTTP ${htmlResponse.status}` },
              { status: 502 }
            );
          }

          const fallbackHTML = await htmlResponse.text();
          return NextResponse.json({
            success: true,
            content: fallbackHTML,
            mobileContent: null,
            format: 'html',
            mode: 'identical',
            originalSize: fallbackHTML.length,
            finalSize: fallbackHTML.length,
            cssInlined: false,
            jsRendered: true,
            warning: 'Browser rendering not available. HTML downloaded without JS rendering - may be incomplete.',
          });
        } catch (fetchErr) {
          return NextResponse.json(
            { error: `Unable to clone the page: ${fetchErr instanceof Error ? fetchErr.message : 'unknown error'}` },
            { status: 502 }
          );
        }
      }
    }

    // REWRITE EXTRACT PHASE: render with Playwright, extract texts locally, save to Supabase DB
    if (cloneMode === 'rewrite' && body.phase === 'extract' && url) {
      if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        return NextResponse.json({ error: 'Supabase not configured.' }, { status: 500 });
      }

      if (IS_SERVERLESS) {
        console.log(`⚠️ Serverless detected, using fetch fallback for rewrite extract: ${url}`);
        const fetchResult = await fetchPageWithFallbacks(url.trim());
        if (!fetchResult.ok) {
          return NextResponse.json({ error: `Unable to fetch page: ${fetchResult.error}`, details: fetchResult.details }, { status: 502 });
        }
        let rawHtml = fetchResult.html;
        rawHtml = rawHtml.replace(/"\s*==\s*\$\d+/g, '"').replace(/\s*==\s*\$\d+/g, '');

        const fetchExtractResult = extractTextsFromHtml(rawHtml);
        if (fetchExtractResult.length === 0) {
          return NextResponse.json({ error: 'No text found on the page.' }, { status: 400 });
        }

        const { createClient } = await import('@supabase/supabase-js');
        const supa = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);

        const { data: job, error: jobError } = await supa
          .from('cloning_jobs')
          .insert({
            user_id: body.userId || '00000000-0000-0000-0000-000000000001',
            url,
            clone_mode: 'rewrite',
            product_name: body.productName || '',
            product_description: body.productDescription || '',
            framework: body.framework || null,
            target: body.target || null,
            custom_prompt: body.customPrompt || null,
            original_html: rawHtml,
            total_texts: fetchExtractResult.length,
            status: 'ready',
          })
          .select()
          .single();

        if (jobError || !job) {
          return NextResponse.json({ error: `Job creation error: ${jobError?.message}` }, { status: 500 });
        }

        const textsToInsert = fetchExtractResult.map((t) => ({
          job_id: job.id, index: t.index, original_text: t.originalText,
          raw_text: t.rawText || null, tag_name: t.tagName, full_tag: t.fullTag,
          classes: t.classes, attributes: t.attributes, context: t.context,
          position: t.position, processed: false,
        }));

        for (let i = 0; i < textsToInsert.length; i += 500) {
          const batch = textsToInsert.slice(i, i + 500);
          const { error: insertError } = await supa.from('cloning_texts').insert(batch);
          if (insertError) {
            await supa.from('cloning_jobs').delete().eq('id', job.id);
            return NextResponse.json({ error: `Text saving error: ${insertError.message}` }, { status: 500 });
          }
        }

        return NextResponse.json({
          success: true, phase: 'extract', jobId: job.id,
          totalTexts: fetchExtractResult.length,
          message: 'Texts extracted via serverless fetch and saved.',
        });
      }

      console.log(`🔄 Rewrite EXTRACT with Playwright: ${url}`);

      try {
        // Step 1: Render the page with Playwright
        const browser = await getBrowser();
        const context = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          viewport: { width: 1440, height: 900 },
          ignoreHTTPSErrors: true,
        });
        const pwPage = await context.newPage();

        await pwPage.goto(url, { waitUntil: 'load', timeout: 20000 });
        await pwPage.waitForTimeout(3000);

        await pwPage.evaluate(async () => {
          const step = window.innerHeight;
          const max = document.body.scrollHeight;
          for (let y = 0; y < max; y += step) {
            window.scrollTo(0, y);
            await new Promise(r => setTimeout(r, 200));
          }
          window.scrollTo(0, 0);
        });
        await pwPage.waitForTimeout(1500);

        // Step 2: Extract texts directly from the rendered DOM via Playwright
        const extractResult = await pwPage.evaluate(() => {
          const skipTags: Record<string, boolean> = {
            SCRIPT:true, STYLE:true, NOSCRIPT:true, IFRAME:true, SVG:true, META:true, LINK:true, BR:true, HR:true, IMG:true
          };
          const formTags: Record<string, boolean> = {
            INPUT:true, SELECT:true, TEXTAREA:true, OPTION:true
          };
          const blockTags: Record<string, boolean> = {
            DIV:true, SECTION:true, ARTICLE:true, MAIN:true, ASIDE:true, HEADER:true, FOOTER:true, NAV:true,
            H1:true, H2:true, H3:true, H4:true, H5:true, H6:true, P:true,
            UL:true, OL:true, LI:true, DL:true, DT:true, DD:true,
            TABLE:true, THEAD:true, TBODY:true, TFOOT:true, TR:true, TD:true, TH:true,
            BLOCKQUOTE:true, FIGCAPTION:true, FIGURE:true, DETAILS:true, SUMMARY:true,
            FORM:true, FIELDSET:true, LEGEND:true, DIALOG:true, PRE:true, ADDRESS:true,
            BUTTON:true
          };
          const texts: Array<{
            index: number; originalText: string; tagName: string; fullTag: string;
            classes: string; attributes: string; context: string; position: number; rawText?: string;
          }> = [];
          let idx = 0;
          const extracted = new Set<string>();

          const allEls = document.body.querySelectorAll('*');
          allEls.forEach((el) => {
            if (skipTags[el.tagName] || formTags[el.tagName]) return;
            const rect = el.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) return;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

            // Full text including inline children (<strong>, <em>, <a>, <span>)
            const fullText = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (fullText.length < 2 || !fullText.match(/[a-zA-Z]/)) return;

            // Skip elements with block-level children — those children will be extracted separately
            const hasBlockChildWithText = Array.from(el.children).some(child => {
              if (skipTags[child.tagName] || formTags[child.tagName]) return false;
              const childText = (child.textContent || '').trim();
              return blockTags[child.tagName] && childText.length >= 2;
            });
            if (hasBlockChildWithText) return;

            if (extracted.has(fullText)) return;
            if (fullText.includes('{') && fullText.includes('}') && fullText.includes('=>')) return;
            if (fullText.startsWith('http') || fullText.startsWith('//')) return;

            extracted.add(fullText);
            const tag = el.tagName.toLowerCase();
            const cls = el.getAttribute('class') || '';
            const id = el.getAttribute('id') || '';
            const innerHTML = el.innerHTML;
            const attrs = Array.from(el.attributes).map(a => `${a.name}="${a.value}"`).join(' ').substring(0, 200);

            texts.push({
              index: idx++,
              originalText: fullText,
              rawText: innerHTML && innerHTML !== fullText && innerHTML.length <= 5000 ? innerHTML : undefined,
              tagName: tag,
              fullTag: `<${tag}${id ? ` id="${id}"` : ''}${cls ? ` class="${cls}"` : ''}>`,
              classes: cls,
              attributes: attrs,
              context: tag,
              position: Math.round(rect.top),
            });
          });

          // Also extract alt/title/placeholder attributes
          document.querySelectorAll('[alt],[title],[placeholder],[aria-label]').forEach(el => {
            ['alt', 'title', 'placeholder', 'aria-label'].forEach(attr => {
              const val = el.getAttribute(attr);
              if (val && val.length >= 3 && val.match(/[a-zA-Z]/) && !extracted.has(val) && !val.startsWith('http')) {
                extracted.add(val);
                texts.push({
                  index: idx++,
                  originalText: val,
                  tagName: '',
                  fullTag: `${attr}="${val}"`,
                  classes: '',
                  attributes: `${attr}="${val}"`,
                  context: `attr:${attr}`,
                  position: 0,
                });
              }
            });
          });

          // Extract <title> tag text (often contains brand name)
          const titleEl = document.querySelector('title');
          if (titleEl) {
            const titleText = (titleEl.textContent || '').trim();
            const titleHtml = titleEl.innerHTML;
            if (titleText.length >= 3 && titleText.match(/[a-zA-Z]/) && !extracted.has(titleText)) {
              extracted.add(titleText);
              texts.push({
                index: idx++,
                originalText: titleText,
                rawText: titleHtml !== titleText ? titleHtml : undefined,
                tagName: 'title',
                fullTag: '<title>',
                classes: '',
                attributes: '',
                context: 'title',
                position: -1,
              });
            }
          }

          return texts;
        });

        // Step 2b: Get clean HTML with CSS inlined and URLs fixed (same logic as cloneWithBrowser)
        const renderedHTML = await pwPage.evaluate((pageUrl: string) => {
          function abs(relative: string): string {
            if (!relative || relative.startsWith('data:') || relative.startsWith('blob:') ||
                relative.startsWith('#') || relative.startsWith('mailto:') || relative.startsWith('tel:') ||
                relative.startsWith('javascript:')) return relative;
            if (relative.startsWith('http://') || relative.startsWith('https://')) return relative;
            try { return new URL(relative, pageUrl).href; } catch { return relative; }
          }

          // Collect all CSS from loaded stylesheets
          const allCss: string[] = [];
          for (const sheet of Array.from(document.styleSheets)) {
            try {
              const rules = Array.from(sheet.cssRules || []);
              let cssText = rules.map(r => r.cssText).join('\n');
              cssText = cssText.replace(/url\(\s*["']?(?!data:|https?:|blob:)([^"')]+)["']?\s*\)/gi, (_m: string, u: string) => {
                const baseUrl = sheet.href || pageUrl;
                try { return `url("${new URL(u.trim(), baseUrl).href}")`; } catch { return `url("${u}")`; }
              });
              if (cssText.trim()) allCss.push(cssText);
            } catch { /* CORS - skip */ }
          }

          const docClone = document.documentElement.cloneNode(true) as HTMLElement;
          // Remove scripts
          docClone.querySelectorAll('script').forEach(s => s.remove());
          // Remove event handlers
          docClone.querySelectorAll('*').forEach(el => {
            Array.from(el.attributes).forEach(attr => {
              if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
            });
          });
          // Remove stylesheet links (CSS is inlined)
          docClone.querySelectorAll('link[rel="stylesheet"]').forEach(l => l.remove());
          // Fix all URLs to absolute
          docClone.querySelectorAll('[src],[href],[poster],[data-src],[data-lazy-src],[data-original],[data-bg],[action]').forEach(el => {
            ['src', 'href', 'poster', 'data-src', 'data-lazy-src', 'data-original', 'data-bg', 'action'].forEach(attr => {
              const val = el.getAttribute(attr);
              if (val && !val.startsWith('data:') && !val.startsWith('blob:') && !val.startsWith('#') && !val.startsWith('mailto:')) {
                el.setAttribute(attr, abs(val));
              }
            });
            const srcset = el.getAttribute('srcset');
            if (srcset) {
              el.setAttribute('srcset', srcset.split(',').map((e: string) => {
                const p = e.trim().split(/\s+/); if (p[0]) p[0] = abs(p[0]); return p.join(' ');
              }).join(', '));
            }
          });
          // Fix inline style url()
          docClone.querySelectorAll('[style]').forEach(el => {
            const s = el.getAttribute('style') || '';
            if (s.includes('url(')) {
              el.setAttribute('style', s.replace(/url\(\s*["']?(?!data:|https?:|blob:)([^"')]+)["']?\s*\)/gi,
                (_m: string, u: string) => `url("${abs(u.trim())}")`));
            }
          });
          // Inject consolidated CSS
          const head = docClone.querySelector('head');
          if (head && allCss.length > 0) {
            head.querySelectorAll('style').forEach(s => s.remove());
            const styleEl = document.createElement('style');
            styleEl.textContent = allCss.join('\n\n');
            const after = head.querySelector('meta[charset]')?.nextSibling || head.firstChild;
            if (after) head.insertBefore(styleEl, after); else head.appendChild(styleEl);
          }
          return '<!DOCTYPE html>\n' + docClone.outerHTML;
        }, url);

        await context.close();

        console.log(`✅ Playwright: ${renderedHTML.length} chars (CSS inlined), ${extractResult.length} texts extracted`);

        if (extractResult.length === 0) {
          return NextResponse.json({ error: 'No text found in the rendered page.' }, { status: 400 });
        }

        // Step 3: Save job and texts to Supabase DB directly
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);

        const { data: job, error: jobError } = await supabase
          .from('cloning_jobs')
          .insert({
            user_id: body.userId || '00000000-0000-0000-0000-000000000001',
            url,
            clone_mode: 'rewrite',
            product_name: body.productName || '',
            product_description: body.productDescription || '',
            framework: body.framework || null,
            target: body.target || null,
            custom_prompt: body.customPrompt || null,
            original_html: renderedHTML,
            total_texts: extractResult.length,
            status: 'ready',
          })
          .select()
          .single();

        if (jobError || !job) {
          console.error('❌ Job creation error:', jobError);
          return NextResponse.json({ error: `Job creation error: ${jobError?.message}` }, { status: 500 });
        }

        // Insert texts in batches
        const textsToInsert = extractResult.map(t => ({
          job_id: job.id,
          index: t.index,
          original_text: t.originalText,
          raw_text: t.rawText || null,
          tag_name: t.tagName,
          full_tag: t.fullTag,
          classes: t.classes,
          attributes: t.attributes,
          context: t.context,
          position: t.position,
          processed: false,
        }));

        for (let i = 0; i < textsToInsert.length; i += 500) {
          const batch = textsToInsert.slice(i, i + 500);
          const { error: insertError } = await supabase.from('cloning_texts').insert(batch);
          if (insertError) {
            await supabase.from('cloning_jobs').delete().eq('id', job.id);
            return NextResponse.json({ error: `Text saving error: ${insertError.message}` }, { status: 500 });
          }
        }

        console.log(`✅ Job ${job.id} created with ${extractResult.length} texts (Playwright + direct Supabase)`);

        return NextResponse.json({
          success: true,
          phase: 'extract',
          jobId: job.id,
          totalTexts: extractResult.length,
          message: 'Texts extracted with Playwright and saved. Proceed with process phase.',
        });
      } catch (err) {
        console.error('❌ Playwright rewrite extract error:', err);
        console.log('⚠️ Fallback: extracting texts via fetch + regex (no browser)...');

        try {
          const htmlResponse = await fetch(url.trim(), {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(20000),
          });

          if (!htmlResponse.ok) {
            return NextResponse.json(
              { error: `Unable to fetch page: HTTP ${htmlResponse.status}` },
              { status: 502 }
            );
          }

          let rawHtml = await htmlResponse.text();
          rawHtml = rawHtml.replace(/"\s*==\s*\$\d+/g, '"').replace(/\s*==\s*\$\d+/g, '');

          const extractResult = extractTextsFromHtml(rawHtml);

          if (extractResult.length === 0) {
            return NextResponse.json({ error: 'No text found on the page.' }, { status: 400 });
          }

          const { createClient } = await import('@supabase/supabase-js');
          const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);

          const { data: job, error: jobError } = await supabase
            .from('cloning_jobs')
            .insert({
              user_id: body.userId || '00000000-0000-0000-0000-000000000001',
              url,
              clone_mode: 'rewrite',
              product_name: body.productName || '',
              product_description: body.productDescription || '',
              framework: body.framework || null,
              target: body.target || null,
              custom_prompt: body.customPrompt || null,
              original_html: rawHtml,
              total_texts: extractResult.length,
              status: 'ready',
            })
            .select()
            .single();

          if (jobError || !job) {
            return NextResponse.json({ error: `Job creation error: ${jobError?.message}` }, { status: 500 });
          }

          const textsToInsert = extractResult.map((t) => ({
            job_id: job.id,
            index: t.index,
            original_text: t.originalText,
            raw_text: t.rawText || null,
            tag_name: t.tagName,
            full_tag: t.fullTag,
            classes: t.classes,
            attributes: t.attributes,
            context: t.context,
            position: t.position,
            processed: false,
          }));

          for (let i = 0; i < textsToInsert.length; i += 500) {
            const batch = textsToInsert.slice(i, i + 500);
            const { error: insertError } = await supabase.from('cloning_texts').insert(batch);
            if (insertError) {
              await supabase.from('cloning_jobs').delete().eq('id', job.id);
              return NextResponse.json({ error: `Text saving error: ${insertError.message}` }, { status: 500 });
            }
          }

          console.log(`✅ Job ${job.id} created with ${extractResult.length} texts (fetch fallback)`);

          return NextResponse.json({
            success: true,
            phase: 'extract',
            jobId: job.id,
            totalTexts: extractResult.length,
            message: 'Texts extracted via fetch fallback and saved. Proceed with process phase.',
          });
        } catch (fallbackErr) {
          console.error('❌ Fetch fallback also failed:', fallbackErr);
          return NextResponse.json(
            { error: `Extract failed: ${fallbackErr instanceof Error ? fallbackErr.message : 'unknown error'}` },
            { status: 502 }
          );
        }
      }
    }

    // ALL OTHER MODES: proxy to Supabase Edge Function
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return NextResponse.json(
        { error: 'Supabase not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local' },
        { status: 500 }
      );
    }

    const edgeFunctionUrl = `${SUPABASE_URL}/functions/v1/smooth-responder`;

    // Inject the copywriting knowledge base into the request body so the Edge
    // Function can pass it to Claude as a cached system block (cache_control:
    // ephemeral). Only meaningful for AI rewrite/translate phases — for other
    // calls (extract, status checks) it's harmless extra payload, so we only
    // add it when the call is actually going to hit Claude.
    const willCallClaude =
      (body.cloneMode === 'rewrite' && body.phase === 'process') ||
      body.cloneMode === 'translate';

    const enrichedBody: Record<string, unknown> = { ...body };
    if (willCallClaude) {
      const kb = getKb();
      if (kb && !enrichedBody.system_kb) {
        enrichedBody.system_kb = kb;
      }
    }

    const response = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(enrichedBody),
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      return NextResponse.json(
        { error: `Edge function error (${response.status}): ${text.substring(0, 300)}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const errMsg = error instanceof Error
      ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack.substring(0, 500)}` : ''}`
      : String(error);
    console.error('Clone funnel API error:', errMsg, { body });
    return NextResponse.json(
      { error: error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error', body_received: body },
      { status: 500 }
    );
  }
}
