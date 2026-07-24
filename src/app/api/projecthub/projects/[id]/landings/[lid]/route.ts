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
