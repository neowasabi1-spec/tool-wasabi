import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { loadFunnelById } from '@/lib/checkpoint-sources';
import type { CheckpointRun } from '@/types/checkpoint';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/checkpoint/[id]
 *
 * `id` is the composite UnifiedFunnel id (`<source_table>:<row_id>`).
 *
 * Returns:
 *   {
 *     funnel: UnifiedFunnel,
 *     runs: CheckpointRun[]   // history, newest first
 *   }
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: compositeId } = await params;
  if (!compositeId) {
    return NextResponse.json({ error: 'Missing funnel id' }, { status: 400 });
  }

  const funnel = await loadFunnelById(decodeURIComponent(compositeId));
  if (!funnel) {
    return NextResponse.json({ error: 'Funnel not found' }, { status: 404 });
  }

  const { data: runs, error } = await supabase
    .from('funnel_checkpoints')
    .select('*')
    .eq('source_table', funnel.source_table)
    .eq('source_id', funnel.source_id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[api/checkpoint/[id]] load runs:', error.message);
    return NextResponse.json(
      { funnel, runs: [], error: error.message },
      { status: 200 },
    );
  }

  return NextResponse.json({
    funnel,
    runs: (runs as CheckpointRun[] | null) ?? [],
  });
}
