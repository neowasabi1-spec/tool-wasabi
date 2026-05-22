/**
 * One-shot backfill endpoint: re-reads every `project_files` row for a project,
 * re-downloads each file from Supabase Storage, extracts text, and rebuilds
 * the legacy JSONB columns (`brief_files`, `market_research`, `back_end`,
 * `compliance_funnel`, `funnel`) + the legacy `brief` TEXT column so the
 * rewrite pipeline (`getProjectBriefText`) sees the content.
 *
 * Needed because every file uploaded BEFORE the mirror was added to the POST
 * route only exists as a Storage object + project_files row, so the
 * Front-End Funnel rewrite reports "Brief mancante" even though the user
 * clearly has documents attached.
 *
 * Idempotent: rebuilds the column from scratch every time. Existing inline
 * files (uploaded via the older `SectionFilesEditor` on /projects) are
 * preserved by merging them in before the storage-backed ones are appended
 * (matched by `name` so we don't double-count).
 *
 * Usage:
 *   POST /api/projecthub/projects/<projectId>/files/backfill
 *   → { backfilled: { column: count, ... }, totalFiles: N }
 */

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
// Backfill can be slow if there are many large PDFs — give it room.
export const maxDuration = 300;

const FILE_TYPE_TO_LEGACY_COLUMN: Record<string, string> = {
  market_research: 'market_research',
  pb_frontend: 'brief_files',
  pb_backend: 'back_end',
  pb_compliance: 'compliance_funnel',
  pb_funnel: 'funnel',
};

interface FileRow {
  id: number;
  file_path: string;
  file_type: string;
  original_name: string;
  created_at: string;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const projectId = params.id;

  const { data: rows, error: listErr } = await supabase
    .from('project_files')
    .select('id, file_path, file_type, original_name, created_at')
    .eq('project_id', projectId);

  if (listErr) {
    return NextResponse.json({ error: listErr.message }, { status: 500 });
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({ backfilled: {}, totalFiles: 0 });
  }

  // Bucket files by legacy column.
  const buckets: Record<string, FileRow[]> = {};
  for (const r of rows as FileRow[]) {
    const col = FILE_TYPE_TO_LEGACY_COLUMN[r.file_type];
    if (!col) continue; // ugc / unknown → no mirror
    (buckets[col] ||= []).push(r);
  }

  const backfilled: Record<string, number> = {};

  for (const [column, files] of Object.entries(buckets)) {
    // Read existing legacy content so inline-uploaded files (from the older
    // SectionFilesEditor) aren't wiped out. Storage-backed files added below
    // are appended only if `name` doesn't already exist.
    const colsToRead = `id, ${column}${column === 'brief_files' ? ', brief' : ''}`;
    const { data: row, error: readErr } = await supabase
      .from('projects')
      .select(colsToRead)
      .eq('id', projectId)
      .single();
    if (readErr || !row) {
      console.warn(
        `[backfill] failed to read ${column} for project ${projectId}:`,
        readErr?.message,
      );
      continue;
    }
    const existing = parseSectionData((row as unknown as Record<string, unknown>)[column]);
    const existingNames = new Set(existing.files.map((f) => f.name));
    const merged: SectionFile[] = [...existing.files];
    let added = 0;

    for (const f of files) {
      if (existingNames.has(f.original_name)) continue;

      const { data: blob, error: dlErr } = await supabase.storage
        .from('project-files')
        .download(f.file_path);
      if (dlErr || !blob) {
        console.warn(
          `[backfill] download failed for ${f.file_path}:`,
          dlErr?.message,
        );
        continue;
      }
      const buf = Buffer.from(await blob.arrayBuffer());
      const text = await extractTextFromUpload(
        f.original_name,
        blob.type || 'application/octet-stream',
        buf,
      );
      if (!text.trim()) continue; // skip files we couldn't read

      merged.push({
        name: f.original_name,
        content: text,
        size: buf.length,
        type: blob.type || '',
        uploadedAt: f.created_at,
      });
      existingNames.add(f.original_name);
      added++;
    }

    if (added === 0) continue;

    const content = buildSectionContent(merged, existing.notes || '');
    const update: Record<string, unknown> = {
      [column]: {
        files: merged,
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
        backfilled[column] = added;
        continue;
      }
      console.warn(`[backfill] update ${column} failed:`, updErr.message);
      continue;
    }
    backfilled[column] = added;
  }

  return NextResponse.json({ backfilled, totalFiles: rows.length });
}
