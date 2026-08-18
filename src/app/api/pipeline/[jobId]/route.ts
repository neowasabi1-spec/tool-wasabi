import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';

/** GET /api/pipeline/[jobId] — poll a single job's full state. */
export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } },
) {
  const { jobId } = params;
  const { data, error } = await supabaseAdmin
    .from('pipeline_jobs')
    .select('id, project_id, status, input, steps, current_step, error, created_at, updated_at')
    .eq('id', jobId)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: `Job non trovato: ${error?.message}` }, { status: 404 });
  }
  return NextResponse.json(data);
}

/** DELETE /api/pipeline/[jobId] — cancel/remove a job. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { jobId: string } },
) {
  const { jobId } = params;
  const { error } = await supabaseAdmin.from('pipeline_jobs').delete().eq('id', jobId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true, jobId });
}
