import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** DELETE /api/projecthub/projects/:id/shots/:sid — remove a shot + its files. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; sid: string } },
) {
  const { id, sid } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const sidNum = Number(sid);
  if (!Number.isFinite(sidNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const { data: shot } = await supabaseAdmin
    .from('competitor_shots')
    .select('file_path, thumb_path')
    .eq('id', sidNum)
    .eq('project_id', id)
    .maybeSingle();

  const toRemove: string[] = [];
  const fp = (shot as { file_path?: string } | null)?.file_path || '';
  const tp = (shot as { thumb_path?: string } | null)?.thumb_path || '';
  if (fp && !/^https?:\/\//i.test(fp)) toRemove.push(fp);
  if (tp && !/^https?:\/\//i.test(tp)) toRemove.push(tp);
  if (toRemove.length) {
    await supabaseAdmin.storage.from('project-files').remove(toRemove).catch(() => {});
  }

  const { error } = await supabaseAdmin
    .from('competitor_shots')
    .delete()
    .eq('id', sidNum)
    .eq('project_id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
