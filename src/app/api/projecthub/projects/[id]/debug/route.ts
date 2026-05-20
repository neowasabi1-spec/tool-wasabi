import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  derivedProductBriefSections,
  legacyFilesForProject,
} from '@/lib/projecthub-legacy';
import { parseSectionData } from '@/lib/project-sections';

export const dynamic = 'force-dynamic';

const COLS_TO_PROBE = [
  'market_research',
  'brief',
  'brief_files',
  'front_end',
  'back_end',
  'compliance_funnel',
  'funnel',
  'thumbnail_path',
  'product_brief_sections',
];

/**
 * Diagnostic endpoint — open in browser:
 *   /api/projecthub/projects/<projectId>/debug
 * Returns a JSON document showing exactly which legacy columns exist
 * on this project, what shape they have, what `parseSectionData`
 * extracts from each, and what virtual file rows the merger produced.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;

  // Probe each column individually so a missing column doesn't break the
  // whole select.
  const columnReport: Record<string, unknown> = {};
  for (const col of COLS_TO_PROBE) {
    const { data, error } = await supabase
      .from('projects')
      .select(`id, ${col}`)
      .eq('id', id)
      .single();
    if (error) {
      columnReport[col] = { exists: false, error: error.message };
    } else {
      const value = (data as Record<string, unknown> | null)?.[col];
      const parsed =
        col === 'brief' || col === 'thumbnail_path'
          ? null
          : parseSectionData(value);
      columnReport[col] = {
        exists: true,
        rawType: typeof value,
        rawIsNull: value == null,
        rawSample: typeof value === 'string' ? value.slice(0, 200) : value,
        parsedFiles: parsed?.files?.length ?? null,
        parsedNotesLen: parsed?.notes?.length ?? null,
        parsedContentLen: parsed?.content?.length ?? null,
      };
    }
  }

  // Now run the actual merger so we can see what files would surface.
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('*')
    .eq('id', id)
    .single();

  if (projErr || !project) {
    return NextResponse.json(
      { columnReport, error: projErr?.message || 'Project not found' },
      { status: 404 },
    );
  }

  const projectRow = project as unknown as Record<string, unknown>;
  const virtualFiles = legacyFilesForProject(projectRow);
  const sections = derivedProductBriefSections(projectRow);

  const { data: realFiles } = await supabase
    .from('project_files')
    .select('*')
    .eq('project_id', id)
    .order('created_at', { ascending: false });

  return NextResponse.json({
    projectId: id,
    projectKeys: Object.keys(project),
    columnReport,
    virtualFilesCount: virtualFiles.length,
    virtualFiles: virtualFiles.map((f) => ({
      id: f.id,
      file_type: f.file_type,
      original_name: f.original_name,
      legacy_section: f.legacy_section,
      legacy_index: f.legacy_index,
    })),
    realFilesCount: realFiles?.length ?? 0,
    realFiles: (realFiles || []).map((f: { id: number; file_type: string; original_name: string }) => ({
      id: f.id,
      file_type: f.file_type,
      original_name: f.original_name,
    })),
    derivedSections: sections,
  });
}
