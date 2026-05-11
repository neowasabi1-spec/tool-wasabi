import { NextRequest, NextResponse } from 'next/server';
import { fetchHtmlSmart } from '@/lib/fetch-html-smart';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/checkpoint/diagnose-fetch
 *
 * Body: { url: string }
 *
 * Quick visual diagnostic for the SPA fallback chain. Returns the
 * full FetchHtmlResult (source, wasSpa, attempts, durationMs) plus
 * a 1KB preview of the HTML so the user can see what the audit
 * pipeline will actually receive — without having to dig through
 * Netlify Function logs.
 */
export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = (await req.json()) as { url?: string };
  } catch {
    return NextResponse.json({ error: 'Body JSON non valido.' }, { status: 400 });
  }
  const url = (body.url ?? '').trim();
  if (!url) {
    return NextResponse.json({ error: 'URL mancante.' }, { status: 400 });
  }

  const t0 = Date.now();
  const fetched = await fetchHtmlSmart(url, {
    mode: 'full',
    fetchTimeoutMs: 20000,
    playwrightTimeoutMs: 45000,
  });

  // Surface env-level info so the user can see, from the UI, whether
  // they are hitting a Netlify Function vs local dev — and which
  // Chromium-related env vars are set.
  const env = {
    NETLIFY: process.env.NETLIFY ?? null,
    VERCEL: process.env.VERCEL ?? null,
    AWS_LAMBDA_FUNCTION_NAME: process.env.AWS_LAMBDA_FUNCTION_NAME ?? null,
    NODE_VERSION: process.version,
    isServerless:
      !!process.env.VERCEL ||
      !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
      (!!process.env.NETLIFY &&
        !process.env.NETLIFY_LOCAL &&
        !process.env.NETLIFY_DEV),
  };

  return NextResponse.json({
    ok: fetched.ok,
    source: fetched.source,
    wasSpa: fetched.wasSpa,
    htmlLength: fetched.html.length,
    durationMs: Date.now() - t0,
    attempts: fetched.attempts,
    error: fetched.error ?? null,
    htmlPreview: fetched.html.slice(0, 1500),
    env,
  });
}
