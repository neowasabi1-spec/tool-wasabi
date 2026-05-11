import { NextRequest, NextResponse } from 'next/server';
import { getFunnel, listRunsForFunnel, deleteFunnel } from '@/lib/checkpoint-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/checkpoint/[id]
 *
 * Returns: { funnel: CheckpointFunnel, runs: CheckpointRun[] }
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }
  const funnel = await getFunnel(id);
  if (!funnel) {
    return NextResponse.json({ error: 'Funnel not found' }, { status: 404 });
  }
  const runs = await listRunsForFunnel(id);
  return NextResponse.json({ funnel, runs });
}

/**
 * DELETE /api/checkpoint/[id]
 * Removes the funnel + cascades the runs.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }
  const result = await deleteFunnel(id);
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
