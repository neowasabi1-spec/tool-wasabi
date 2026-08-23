import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * DELETE /api/projecthub/projects/:id/landings/:lid
 * Remove a competitor landing (archived_funnels row) from the project.
 * Only rows actually linked to this project can be deleted here.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; lid: string } },
) {
  const { id, lid } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Composite id `${rowId}::${stepIndex}` → remove a single step from a funnel
  // folder (delete the whole row only when it was its last step).
  if (lid.includes('::')) {
    const [rowId, idxRaw] = lid.split('::');
    const idx = Number(idxRaw);
    const { data: row } = await supabaseAdmin
      .from('archived_funnels')
      .select('id, steps')
      .eq('id', rowId)
      .eq('project_id', id)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const steps = Array.isArray(row.steps) ? (row.steps as Array<{ page_id?: string }>) : [];
    const removed = steps[idx];
    const nextSteps = steps.filter((_, i) => i !== idx);

    if (nextSteps.length === 0) {
      await supabaseAdmin.from('archived_funnels').delete().eq('id', rowId).eq('project_id', id);
    } else {
      await supabaseAdmin
        .from('archived_funnels')
        .update({ steps: nextSteps, total_steps: nextSteps.length })
        .eq('id', rowId)
        .eq('project_id', id);
    }
    // Best-effort: drop the removed step's mirrored HTML.
    try {
      const pid = removed?.page_id;
      if (pid) await supabaseAdmin.from('page_html').delete().eq('page_id', pid);
    } catch { /* ignore */ }
    return NextResponse.json({ success: true });
  }

  const { error } = await supabaseAdmin
    .from('archived_funnels')
    .delete()
    .eq('id', lid)
    .eq('project_id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Best-effort: drop the mirrored HTML so it doesn't linger in page_html.
  try {
    await supabaseAdmin.from('page_html').delete().eq('page_id', lid);
  } catch {
    /* ignore */
  }

  return NextResponse.json({ success: true });
}
