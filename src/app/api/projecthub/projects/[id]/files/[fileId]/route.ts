import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  decodeLegacyFileId,
  removeFileFromLegacySection,
} from '@/lib/projecthub-legacy';
import {
  parseSectionData,
  buildSectionContent,
} from '@/lib/project-sections';

export const dynamic = 'force-dynamic';

const LEGACY_COLS =
  'id, market_research, brief_files, front_end, back_end, compliance_funnel, funnel';

// Same mapping as the POST route — keep them in sync. We need this here so
// that deleting a file from `project_files` also pulls the mirrored entry
// out of the legacy JSONB column (otherwise the rewrite pipeline keeps
// seeing stale content from a file the user thought was gone).
const FILE_TYPE_TO_LEGACY_COLUMN: Record<string, string> = {
  market_research: 'market_research',
  pb_frontend: 'brief_files',
  pb_backend: 'back_end',
  pb_compliance: 'compliance_funnel',
  pb_funnel: 'funnel',
};

async function unmirrorFromLegacyColumn(
  projectId: string,
  fileType: string,
  originalName: string,
): Promise<void> {
  const column = FILE_TYPE_TO_LEGACY_COLUMN[fileType];
  if (!column) return;

  const { data: row, error: readErr } = await supabase
    .from('projects')
    .select(`id, ${column}${column === 'brief_files' ? ', brief' : ''}`)
    .eq('id', projectId)
    .single();
  if (readErr || !row) return;

  const existing = parseSectionData((row as unknown as Record<string, unknown>)[column]);
  const newFiles = existing.files.filter((f) => f.name !== originalName);
  if (newFiles.length === existing.files.length) return; // nothing to remove

  const content = buildSectionContent(newFiles, existing.notes || '');
  const update: Record<string, unknown> = {
    [column]: {
      files: newFiles,
      notes: existing.notes || '',
      content,
    },
  };
  if (column === 'brief_files') update.brief = content;

  const { error: updErr } = await supabase
    .from('projects')
    .update(update)
    .eq('id', projectId);
  if (updErr) {
    if (/brief_files/i.test(updErr.message) && column === 'brief_files') {
      await supabase.from('projects').update({ brief: content }).eq('id', projectId);
      return;
    }
    console.warn(`[projecthub] unmirror from ${column} failed:`, updErr.message);
  }
}

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
    .select('file_path, file_type, original_name, project_id')
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

  // Keep the legacy JSONB mirror in sync — drop the entry matching
  // `original_name` from the column matching `file_type`. Failures here are
  // logged but not surfaced; the file row + storage object are already gone.
  if (row.file_type && row.original_name) {
    await unmirrorFromLegacyColumn(
      String(row.project_id ?? params.id),
      String(row.file_type),
      String(row.original_name),
    );
  }

  return NextResponse.json({ success: true });
}
