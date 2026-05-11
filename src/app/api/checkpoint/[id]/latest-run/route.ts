import { NextRequest, NextResponse } from 'next/server';
import { getLatestRunForFunnel } from '@/lib/checkpoint-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/checkpoint/[id]/latest-run
 *
 * Returns: { run: CheckpointRun | null }
 *
 * Used by the client right after clicking "Run" — the POST handler
 * inserts the run row before doing the heavy work, so polling this
 * endpoint discovers the runId within ~500ms without needing the POST
 * response (which can take 2-5 minutes to come back).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  const { id } = params instanceof Promise ? await params : params;
  if (!id) {
    return NextResponse.json({ error: 'Missing funnel id' }, { status: 400 });
  }
  const run = await getLatestRunForFunnel(id);
  return NextResponse.json({ run });
}
