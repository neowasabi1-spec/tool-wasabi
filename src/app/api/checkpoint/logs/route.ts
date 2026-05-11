import { NextRequest, NextResponse } from 'next/server';
import { listRecentRuns } from '@/lib/checkpoint-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/checkpoint/logs
 * Optional query: ?limit=200
 *
 * Returns: { entries: CheckpointLogEntry[] }
 *
 * Powers the "Log" modal on the Checkpoint list page — global audit
 * trail of every "Run Checkpoint" execution across all funnels.
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get('limit');
    const limit = Math.max(1, Math.min(1000, Number(limitRaw) || 200));
    const entries = await listRecentRuns(limit);
    return NextResponse.json({ entries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/checkpoint/logs GET]', msg);
    return NextResponse.json(
      { error: 'Failed to load logs', detail: msg },
      { status: 500 },
    );
  }
}
