import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { LANDING_MEDIA_TYPE } from '@/lib/landing-media';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; mid: string } },
) {
  const { id, mid } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: row } = await supabaseAdmin
    .from('project_files')
    .select('id, file_path, file_type, project_id')
    .eq('id', mid)
    .eq('project_id', id)
    .eq('file_type', LANDING_MEDIA_TYPE)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (row.file_path) {
    await supabaseAdmin.storage.from('project-files').remove([row.file_path]).catch(() => undefined);
  }
  await supabaseAdmin.from('project_files').delete().eq('id', row.id);
  return NextResponse.json({ ok: true });
}
