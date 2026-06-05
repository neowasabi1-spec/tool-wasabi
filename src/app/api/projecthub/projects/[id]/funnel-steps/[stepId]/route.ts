import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// The "Save Funnel into project" flow PATCHes one step per page with
// `result_content` carrying multi-MB cloned HTML. Default 10s wasn't
// enough on slow upstreams and was triggering the misleading
// "Partial save... ~6MB" error from the client. Bumped to 60s — well
// under Netlify's max-function-duration cap.
export const maxDuration = 60;

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
  // Mirror the bulk POST whitelist so flow renames (PATCH with
  // { flow_name }) actually persist. Without this the field was
  // silently dropped at this layer.
  'flow_name',
] as const;

function pickWritable(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

/** Multi-tenancy: require the caller to either be the owner of the
 *  parent project, the master, OR a project_shares collaborator before
 *  mutating a step. Anonymous callers bypass — phase 2 of the RLS
 *  rollout locks them out. Centralised in canAccessProject so this
 *  stays in lock-step with the matching RLS policies. */
async function checkStepAccess(
  req: NextRequest,
  projectId: string,
): Promise<{ deny: NextResponse | null }> {
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) {
    return { deny: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  }
  return { deny: null };
}

/** PATCH — update a single funnel step (inline edits from the Funnel tab). */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; stepId: string } },
) {
  const { deny } = await checkStepAccess(req, params.id);
  if (deny) return deny;

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
  req: NextRequest,
  { params }: { params: { id: string; stepId: string } },
) {
  const { deny } = await checkStepAccess(req, params.id);
  if (deny) return deny;

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
