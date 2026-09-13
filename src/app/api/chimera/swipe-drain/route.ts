import { NextRequest, NextResponse } from 'next/server';
import { drainStalledSwipes } from '@/lib/chimera-swipe-resume';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/** POST /api/chimera/swipe-drain — cron / secret. Restarts stalled swipe workers. */
export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
    || req.headers.get('x-cron-secret')
    || '';
  const expected = process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';
  if (expected && secret !== expected) {
    const body = await req.json().catch(() => ({})) as { secret?: string };
    if (String(body.secret || '') !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  const out = await drainStalledSwipes({ maxProjects: 4 });
  return NextResponse.json({ ok: true, ...out });
}
