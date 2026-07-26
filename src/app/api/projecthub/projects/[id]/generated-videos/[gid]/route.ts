import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** DELETE /api/projecthub/projects/:id/generated-videos/:gid — remove a video + its files. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; gid: string } },
) {
  const { id, gid } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const gidNum = Number(gid);
  if (!Number.isFinite(gidNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const { data: row } = await supabaseAdmin
    .from('generated_videos')
    .select('file_path, thumb_path')
    .eq('id', gidNum)
    .eq('project_id', id)
    .maybeSingle();

  const toRemove: string[] = [];
  const fp = (row as { file_path?: string } | null)?.file_path || '';
  const tp = (row as { thumb_path?: string } | null)?.thumb_path || '';
  if (fp && !/^https?:\/\//i.test(fp)) toRemove.push(fp);
  if (tp && !/^https?:\/\//i.test(tp)) toRemove.push(tp);
  if (toRemove.length) {
    await supabaseAdmin.storage.from('project-files').remove(toRemove).catch(() => {});
  }

  const { error } = await supabaseAdmin
    .from('generated_videos')
    .delete()
    .eq('id', gidNum)
    .eq('project_id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
