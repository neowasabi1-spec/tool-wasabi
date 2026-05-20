import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; fileId: string } },
) {
  const fileId = Number(params.fileId);
  if (!Number.isFinite(fileId)) {
    return NextResponse.json({ error: 'Invalid file id' }, { status: 400 });
  }

  const { data: row, error: fetchErr } = await supabase
    .from('project_files')
    .select('file_path')
    .eq('id', fileId)
    .single();

  if (fetchErr || !row) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  if (row.file_path) {
    await supabase.storage.from('project-files').remove([row.file_path]);
  }

  const { error: delErr } = await supabase
    .from('project_files')
    .delete()
    .eq('id', fileId);

  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
