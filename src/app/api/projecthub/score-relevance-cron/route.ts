import { NextRequest, NextResponse } from 'next/server';
import { scoreAllProjectsUnscoredAds } from '@/lib/ads-intel/ad-relevance';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

function cronSecret(): string {
  return (process.env.CRON_SECRET || process.env.APIFY_WEBHOOK_SECRET || '').trim();
}

function siteOrigin(req: NextRequest): string {
  return (
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    req.nextUrl.origin ||
    ''
  ).replace(/\/$/, '');
}

/**
 * GET/POST /api/projecthub/score-relevance-cron?secret=...
 * Scores unscored competitor ads across all projects (Jev comparability).
 * Prefers the Netlify background worker; falls back to in-process.
 */
async function handle(req: NextRequest) {
  const url = new URL(req.url);
  const provided = url.searchParams.get('secret') || req.headers.get('x-cron-secret') || '';
  const expected = cronSecret();
  if (expected && provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const origin = siteOrigin(req);
  if (origin) {
    try {
      const kick = await fetch(`${origin}/.netlify/functions/ad-relevance-background`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(expected ? { 'x-cron-secret': expected } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8_000),
      });
      if (kick.ok || kick.status === 504 || kick.status === 502) {
        return NextResponse.json({ ok: true, worker: true, status: kick.status });
      }
    } catch {
      // fall through to inline
    }
  }

  try {
    const result = await scoreAllProjectsUnscoredAds({
      perProjectLimit: 40,
      maxProjects: 30,
      maxAds: 150,
    });
    return NextResponse.json({ ok: true, worker: false, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Score failed' },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
