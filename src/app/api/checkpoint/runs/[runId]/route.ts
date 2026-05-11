import { NextRequest, NextResponse } from 'next/server';
import { getRun } from '@/lib/checkpoint-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/checkpoint/runs/[runId]
 *
 * Returns: { run: CheckpointRun } | { error }
 *
 * Used by the live dashboard for polling-based progress updates.
 * Each `persistCategory` call inside the run handler updates this
 * row's JSONB `results` column, so successive polls surface the bot's
 * progress one step at a time.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { runId: string } | Promise<{ runId: string }> },
) {
  const { runId } = params instanceof Promise ? await params : params;
  if (!runId) {
    return NextResponse.json({ error: 'Missing runId' }, { status: 400 });
  }
  const run = await getRun(runId);
  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }
  return NextResponse.json({ run });
}
