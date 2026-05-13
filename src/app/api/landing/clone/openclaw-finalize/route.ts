import { NextRequest, NextResponse } from 'next/server';
import { inlineExternalAssets } from '@/lib/inline-assets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/landing/clone/openclaw-finalize
 *
 * "Light half" of /api/landing/clone for the new local-fetch flow:
 * the OpenClaw worker (Neo / Morfeo) fetches the source HTML on its
 * own machine with Playwright — no Netlify timeout, no edge 504 — and
 * POSTs the raw HTML here so the server only has to do the CPU-only
 * post-processing (asset rewrite + external-asset inlining).
 *
 * Mirrors the second half of `/api/landing/clone/route.ts` exactly so
 * the worker-driven path produces output indistinguishable from the
 * Claude/synchronous path. If you change one, change the other.
 *
 * Why split:
 *   The original /api/landing/clone does fetch + clean + inline in
 *   one Netlify lambda. On heavy SPAs the fetch alone (Playwright
 *   cold start + networkidle wait) eats most of the 60s budget and
 *   the function dies. This endpoint guarantees < 60s because no
 *   fetching happens here at all.
 *
 * Body:
 *   {
 *     url: string,                // original source URL (for absolute-URL rewrites)
 *     html: string,               // raw HTML the worker fetched
 *     removeScripts?: boolean,    // default true (matches /api/landing/clone)
 *     methodUsed?: string,        // forwarded to response (audit trail)
 *     wasSpa?: boolean,
 *     attempts?: string[],
 *     fetchDurationMs?: number,
 *   }
 *
 * Returns the SAME shape as /api/landing/clone success path:
 *   { success: true, url, method_used, was_spa, html, html_preview,
 *     content_length, title, duration_seconds, attempts, env, … }
 *
 * Errors (4xx) for malformed input. 5xx only for genuine server errors.
 */
function makeAbsolute(
  path: string,
  origin: string,
  basePath: string,
  protocol: string,
): string {
  const trimmed = path.trim();
  if (!trimmed || /^(https?:\/\/|data:|#|mailto:|javascript:)/i.test(trimmed))
    return trimmed;
  if (trimmed.startsWith('//')) return protocol + trimmed;
  if (trimmed.startsWith('/')) return origin + trimmed;
  return basePath + trimmed;
}

function fixClonedHtml(html: string, sourceUrl: string): string {
  let fixed = html;
  fixed = fixed.replace(/loading=["']lazy["']/gi, 'loading="eager"');
  fixed = fixed.replace(/<img\b/gi, '<img referrerpolicy="no-referrer" ');
  fixed = fixed.replace(/<video\b/gi, '<video referrerpolicy="no-referrer" ');
  fixed = fixed.replace(/<source\b/gi, '<source referrerpolicy="no-referrer" ');
  if (fixed.includes('<head>')) {
    fixed = fixed.replace(
      '<head>',
      '<head><meta name="referrer" content="no-referrer">',
    );
  } else {
    fixed = '<meta name="referrer" content="no-referrer">' + fixed;
  }

  try {
    const urlObj = new URL(sourceUrl);
    const origin = urlObj.origin;
    const basePath = sourceUrl.substring(0, sourceUrl.lastIndexOf('/') + 1);
    const protocol = urlObj.protocol;

    fixed = fixed
      .replace(/(srcset)=(["'])(.*?)\2/gi, (_match, attr, quote, value) => {
        if (/^\s*(https?:\/\/|\/\/)/i.test(value))
          return `${attr}=${quote}${value}${quote}`;
        const parts = value.split(/,(?=\s)/).map((entry: string) => {
          const segs = entry.trim().split(/\s+/);
          if (segs.length === 0) return entry;
          segs[0] = makeAbsolute(segs[0], origin, basePath, protocol);
          return segs.join(' ');
        });
        return `${attr}=${quote}${parts.join(', ')}${quote}`;
      })
      .replace(
        /(src|href|poster|data-src|data-lazy-src)=(["'])((?!https?:\/\/|data:|#|mailto:|javascript:|\/\/).*?)\2/gi,
        (_m, attr, quote, path) =>
          `${attr}=${quote}${makeAbsolute(path, origin, basePath, protocol)}${quote}`,
      )
      .replace(
        /url\((['"]?)((?!https?:\/\/|data:|#)(?:\/[^)'"]+|[^)'"\s]+))\1\)/gi,
        (_m, quote, path) =>
          `url(${quote}${makeAbsolute(path, origin, basePath, protocol)}${quote})`,
      );
  } catch {
    /* sourceUrl parse failed — leave HTML untouched */
  }
  return fixed;
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let body: {
    url?: string;
    html?: string;
    removeScripts?: boolean;
    methodUsed?: string;
    wasSpa?: boolean;
    attempts?: string[];
    fetchDurationMs?: number;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, error: 'Body must be valid JSON' },
      { status: 400 },
    );
  }

  if (!body.url) {
    return NextResponse.json(
      { success: false, error: 'url is required' },
      { status: 400 },
    );
  }
  if (typeof body.html !== 'string' || body.html.length === 0) {
    return NextResponse.json(
      { success: false, error: 'html is required (non-empty string)' },
      { status: 400 },
    );
  }

  try {
    new URL(body.url);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid url format' },
      { status: 400 },
    );
  }

  let html = body.html;
  if (body.removeScripts !== false) {
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  }

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';

  const cleanHtml = fixClonedHtml(html, body.url);

  // External-asset inlining is the most expensive CPU step but fully
  // bound (no network for the *page* itself; only for stylesheets/
  // fonts referenced in the page, with the helper's own short timeouts).
  const selfContainedHtml = await inlineExternalAssets(cleanHtml, body.url);

  const env = {
    NETLIFY: process.env.NETLIFY ?? null,
    VERCEL: process.env.VERCEL ?? null,
    AWS_LAMBDA_FUNCTION_NAME: process.env.AWS_LAMBDA_FUNCTION_NAME ?? null,
    isServerless:
      !!process.env.VERCEL ||
      !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
      (!!process.env.NETLIFY &&
        !process.env.NETLIFY_LOCAL &&
        !process.env.NETLIFY_DEV),
  };

  return NextResponse.json({
    success: true,
    url: body.url,
    method_used: body.methodUsed ?? 'openclaw-local',
    was_spa: !!body.wasSpa,
    spa_detected: !!body.wasSpa,
    spa_attempted: !!body.wasSpa,
    spa_playwright_result: null,
    spa_jina_result: null,
    attempts: Array.isArray(body.attempts) ? body.attempts : [],
    env,
    content_length: selfContainedHtml.length,
    title,
    duration_seconds:
      ((body.fetchDurationMs ?? 0) + (Date.now() - t0)) / 1000,
    finalize_duration_ms: Date.now() - t0,
    fetch_duration_ms: body.fetchDurationMs ?? null,
    html: selfContainedHtml,
    html_preview: selfContainedHtml.substring(0, 500) + '...',
  });
}
