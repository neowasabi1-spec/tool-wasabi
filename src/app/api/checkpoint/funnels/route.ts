import { NextRequest, NextResponse } from 'next/server';
import { listFunnels, createFunnel } from '@/lib/checkpoint-store';
import type { CreateCheckpointFunnelInput } from '@/types/checkpoint';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/checkpoint/funnels
 * Optional query: ?projectId=...
 *
 * Returns: { funnels: CheckpointFunnel[] }
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const projectId = url.searchParams.get('projectId') ?? undefined;
    const funnels = await listFunnels({ projectId });
    return NextResponse.json({ funnels });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/checkpoint/funnels GET]', msg);
    return NextResponse.json(
      { error: 'Failed to load funnels', detail: msg },
      { status: 500 },
    );
  }
}

/**
 * POST /api/checkpoint/funnels
 * Body: CreateCheckpointFunnelInput
 *
 * Returns: { funnel: CheckpointFunnel } | { error: string }
 */
export async function POST(req: NextRequest) {
  let body: CreateCheckpointFunnelInput;
  try {
    body = (await req.json()) as CreateCheckpointFunnelInput;
  } catch {
    return NextResponse.json({ error: 'Body JSON non valido.' }, { status: 400 });
  }
  const result = await createFunnel(body);
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ funnel: result }, { status: 201 });
}
