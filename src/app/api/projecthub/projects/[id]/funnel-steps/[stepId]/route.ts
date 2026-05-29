import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const WRITABLE = [
  'step_number',
  'page_name',
  'step_type',
  'template_name',
  'url',
  'html_file_path',
  'html_original_name',
  'target',
  'angle',
  'prompt_notes',
  'auto_gen',
  'fidelity_mode',
  'product',
  'status',
  'result_content',
  'feedback',
] as const;

function pickWritable(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

/** PATCH — update a single funnel step (inline edits from the Funnel tab). */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; stepId: string } },
) {
  const body = await req.json().catch(() => ({}));
  const patch = pickWritable(body as Record<string, unknown>);
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no writable fields' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('funnel_steps')
    .update(patch)
    .eq('id', params.stepId)
    .eq('project_id', params.id)
    .select('*')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}

/** DELETE — remove a single funnel step. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; stepId: string } },
) {
  const { error } = await supabase
    .from('funnel_steps')
    .delete()
    .eq('id', params.stepId)
    .eq('project_id', params.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
