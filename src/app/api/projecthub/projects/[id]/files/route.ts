import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { extractTextFromUpload } from '@/lib/server-text-extract';
import {
  parseSectionData,
  buildSectionContent,
  type SectionFile,
} from '@/lib/project-sections';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { data, error } = await supabase
    .from('project_files')
    .select('*')
    .eq('project_id', params.id)
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data || []);
}

// file_type (from GeneralBriefSection / projecthub-legacy) → legacy column name.
// Keep in sync with SECTION_TO_FILE_TYPE in src/lib/projecthub-legacy.ts.
//
// pb_frontend is special: it also mirrors `content` into the TEXT `brief`
// column because the rewrite pipeline (`getProjectBriefText`) reads `brief`
// when `brief_files` is empty.
const FILE_TYPE_TO_LEGACY_COLUMN: Record<string, string> = {
  market_research: 'market_research',
  pb_frontend: 'brief_files',
  pb_backend: 'back_end',
  pb_compliance: 'compliance_funnel',
  pb_funnel: 'funnel',
};

interface UploadedRecord {
  name: string;
  text: string;
  size: number;
  type: string;
}

async function mirrorToLegacyColumn(
  projectId: string,
  fileType: string,
  uploads: UploadedRecord[],
): Promise<void> {
  const column = FILE_TYPE_TO_LEGACY_COLUMN[fileType];
  if (!column) return; // ugc / unknown file_type → nothing to mirror
  if (uploads.length === 0) return;

  // Read the current value so we APPEND instead of overwriting (the user may
  // have legacy files already in there, or may upload several files across
  // multiple requests).
  const { data: row, error: readErr } = await supabase
    .from('projects')
    .select(`id, ${column}${column === 'brief_files' ? ', brief' : ''}`)
    .eq('id', projectId)
    .single();

  if (readErr || !row) {
    console.warn(
      `[projecthub] mirror skipped — failed to read ${column} for project ${projectId}:`,
      readErr?.message,
    );
    return;
  }

  const existing = parseSectionData((row as unknown as Record<string, unknown>)[column]);
  const newFiles: SectionFile[] = [
    ...existing.files,
    ...uploads
      .filter((u) => u.text.trim())
      .map((u) => ({
        name: u.name,
        content: u.text,
        size: u.size,
        type: u.type,
        uploadedAt: new Date().toISOString(),
      })),
  ];
  const content = buildSectionContent(newFiles, existing.notes || '');
  const update: Record<string, unknown> = {
    [column]: {
      files: newFiles,
      notes: existing.notes || '',
      content,
    },
  };
  // Frontend brief: ALSO mirror to the TEXT `brief` column so the legacy
  // rewrite pipeline (getProjectBriefText → fallback path) keeps working.
  if (column === 'brief_files') update.brief = content;

  const { error: updErr } = await supabase
    .from('projects')
    .update(update)
    .eq('id', projectId);

  if (updErr) {
    // Most common failure: `brief_files` JSONB column doesn't exist yet on this
    // database (the migration `supabase-migration-projects-section-files.sql`
    // is gated behind a separate run). Retry with just the `brief` TEXT column
    // so we still get rewrite content available.
    if (/brief_files/i.test(updErr.message) && column === 'brief_files') {
      const { error: brErr } = await supabase
        .from('projects')
        .update({ brief: content })
        .eq('id', projectId);
      if (brErr) {
        console.warn('[projecthub] mirror to brief TEXT failed too:', brErr.message);
      }
      return;
    }
    console.warn(`[projecthub] mirror to ${column} failed:`, updErr.message);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const projectId = params.id;
  const fd = await req.formData();
  const fileType = String(fd.get('file_type') || 'misc');

  const files: File[] = [];
  for (const value of fd.getAll('files')) {
    if (value instanceof File && value.size > 0) files.push(value);
  }
  for (const value of fd.getAll('file')) {
    if (value instanceof File && value.size > 0) files.push(value);
  }
  if (files.length === 0) {
    return NextResponse.json({ error: 'No files provided' }, { status: 400 });
  }

  const inserted: unknown[] = [];
  const extracted: UploadedRecord[] = [];

  for (const file of files) {
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectKey = `${projectId}/${fileType}/${Date.now()}_${safe}`;
    const ab = await file.arrayBuffer();
    const buf = Buffer.from(ab);
    const contentType = file.type || 'application/octet-stream';

    const { error: upErr } = await supabase.storage
      .from('project-files')
      .upload(objectKey, buf, { contentType, upsert: false });
    if (upErr) {
      console.warn('[projecthub] upload failed:', upErr.message);
      continue;
    }
    const { data, error } = await supabase
      .from('project_files')
      .insert({
        project_id: projectId,
        file_type: fileType,
        file_path: objectKey,
        original_name: file.name,
      })
      .select()
      .single();
    if (error) {
      console.warn('[projecthub] DB insert failed:', error.message);
      continue;
    }
    inserted.push(data);

    // Best-effort text extraction for the legacy-column mirror. Failures are
    // logged inside extractTextFromUpload; we just get "" back here.
    const text = await extractTextFromUpload(file.name, contentType, buf);
    extracted.push({
      name: file.name,
      text,
      size: file.size,
      type: contentType,
    });
  }

  // Mirror to legacy JSONB column (briefs / market research / back_end / ...).
  // Awaited so the response is consistent (UI invalidates queries right after
  // POST resolves, and we want getProjectBriefText to see the new content).
  await mirrorToLegacyColumn(projectId, fileType, extracted);

  return NextResponse.json(inserted);
}
