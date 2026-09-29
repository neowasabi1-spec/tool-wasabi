import { NextRequest, NextResponse } from 'next/server';
import {
  scoreAllProjectsUnscoredAds,
  scoreProjectAdsRelevance,
} from '@/lib/ads-intel/ad-relevance';

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
 * Optional body/query: inline=1, force=1, projectId=..., limit=...
 * Prefers the Netlify background worker; falls back to in-process.
 */
async function handle(req: NextRequest) {
  const url = new URL(req.url);
  const body = req.method === 'POST' ? await req.json().catch(() => ({} as Record<string, unknown>)) : {};
  const provided =
    url.searchParams.get('secret') ||
    req.headers.get('x-cron-secret') ||
    (typeof body.secret === 'string' ? body.secret : '') ||
    '';
  const expected = cronSecret();
  if (expected && provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const inline =
    url.searchParams.get('inline') === '1' ||
    body.inline === true ||
    body.inline === 1 ||
    body.inline === '1';
  const force =
    url.searchParams.get('force') === '1' ||
    body.force === true ||
    body.force === 1 ||
    body.force === '1';
  const projectId = (
    url.searchParams.get('projectId') ||
    (typeof body.projectId === 'string' ? body.projectId : '')
  ).trim();
  const limitRaw = url.searchParams.get('limit') ?? body.limit;
  const limit = limitRaw != null ? Number(limitRaw) : undefined;

  if (inline || projectId) {
    try {
      if (projectId) {
        const result = await scoreProjectAdsRelevance(projectId, {
          limit: Number.isFinite(limit) ? Number(limit) : 40,
          force,
        });
        return NextResponse.json({ ok: true, worker: false, projectId, ...result });
      }
      const result = await scoreAllProjectsUnscoredAds({
        perProjectLimit: Number.isFinite(limit) ? Number(limit) : 40,
        maxProjects: 30,
        maxAds: 150,
        force,
      });
      return NextResponse.json({ ok: true, worker: false, ...result });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Score failed' },
        { status: 500 },
      );
    }
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
        body: JSON.stringify({ force, projectId: projectId || undefined, limit }),
        signal: AbortSignal.timeout(8_000),
      });
      if (kick.ok || kick.status === 202 || kick.status === 504 || kick.status === 502) {
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
      force,
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
