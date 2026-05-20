import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  decodeLegacyFileId,
  removeFileFromLegacySection,
} from '@/lib/projecthub-legacy';

export const dynamic = 'force-dynamic';

const LEGACY_COLS =
  'id, market_research, brief_files, front_end, back_end, compliance_funnel, funnel';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; fileId: string } },
) {
  const fileId = Number(params.fileId);
  if (!Number.isFinite(fileId)) {
    return NextResponse.json({ error: 'Invalid file id' }, { status: 400 });
  }

  if (fileId < 0) {
    const decoded = decodeLegacyFileId(fileId);
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid legacy id' }, { status: 400 });
    }
    const { data: project, error: fetchErr } = await supabase
      .from('projects')
      .select(LEGACY_COLS)
      .eq('id', params.id)
      .single();

    if (fetchErr || !project) {
      return NextResponse.json(
        { error: fetchErr?.message || 'Project not found' },
        { status: 404 },
      );
    }

    const newValue = removeFileFromLegacySection(
      (project as Record<string, unknown>)[decoded.section],
      decoded.idx,
    );
    const update: Record<string, unknown> = { [decoded.section]: newValue };
    const { error: updErr } = await supabase
      .from('projects')
      .update(update)
      .eq('id', params.id);
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
    return NextResponse.json({ success: true, legacy: true });
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
