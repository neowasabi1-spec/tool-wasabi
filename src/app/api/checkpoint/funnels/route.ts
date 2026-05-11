import { NextRequest, NextResponse } from 'next/server';
import {
  loadUnifiedFunnels,
  attachLastCheckpoint,
} from '@/lib/checkpoint-sources';
import type { CheckpointSourceTable } from '@/types/checkpoint';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/checkpoint/funnels
 *
 * Query params:
 *   - sources    comma-separated subset of:
 *                funnel_pages,post_purchase_pages,archived_funnels
 *                (default: all three)
 *   - projectId  filter by project
 *   - limit      per-source row limit (default 100, capped at 250)
 *
 * Returns: { funnels: UnifiedFunnel[] } with last_checkpoint
 * attached when a checkpoint exists for that source row.
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const sourcesParam = url.searchParams.get('sources');
    const projectId = url.searchParams.get('projectId') ?? undefined;
    const limitParam = url.searchParams.get('limit');

    const allowedSources: CheckpointSourceTable[] = [
      'funnel_pages',
      'post_purchase_pages',
      'archived_funnels',
    ];
    const sources = sourcesParam
      ? (sourcesParam
          .split(',')
          .map((s) => s.trim())
          .filter((s): s is CheckpointSourceTable =>
            (allowedSources as string[]).includes(s),
          ) as CheckpointSourceTable[])
      : undefined;

    const perSourceLimit = Math.min(
      Math.max(1, Number(limitParam) || 100),
      250,
    );

    const base = await loadUnifiedFunnels({
      sources,
      projectId,
      perSourceLimit,
    });
    const enriched = await attachLastCheckpoint(base);

    return NextResponse.json({ funnels: enriched });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/checkpoint/funnels]', msg);
    return NextResponse.json(
      { error: 'Failed to load funnels', detail: msg },
      { status: 500 },
    );
  }
}
