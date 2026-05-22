import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, hasServiceRoleKey } from '@/lib/supabase-admin';
import { extractTextFromUpload } from '@/lib/server-text-extract';
import {
  parseSectionData,
  buildSectionContent,
  type SectionFile,
} from '@/lib/project-sections';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Uploads may include large PDFs that need server-side parsing — give the
// route enough headroom that we don't get truncated by the default 10s limit.
export const maxDuration = 300;

const BUCKET = 'project-files';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { data, error } = await supabaseAdmin
    .from('project_files')
    .select('*')
    .eq('project_id', params.id)
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data || []);
}

/** Make sure the `project-files` bucket exists and is public. We try to
 *  create it on first upload — idempotent: "already exists" is a no-op.
 *  Failures are non-fatal here because the upload itself will then return a
 *  proper error to the client (and we log everything). */
let _bucketEnsured = false;
async function ensureBucket(): Promise<void> {
  if (_bucketEnsured) return;
  try {
    const { error } = await supabaseAdmin.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: 52428800, // 50 MB per file
    });
    if (error && !/already exists|duplicate/i.test(error.message)) {
      console.warn('[projecthub] ensureBucket failed:', error.message);
    }
  } catch (err) {
    console.warn(
      '[projecthub] ensureBucket threw:',
      err instanceof Error ? err.message : err,
    );
  }
  _bucketEnsured = true;
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
  const { data: row, error: readErr } = await supabaseAdmin
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

  const { error: updErr } = await supabaseAdmin
    .from('projects')
    .update(update)
    .eq('id', projectId);

  if (updErr) {
    // Most common failure: `brief_files` JSONB column doesn't exist yet on this
    // database (the migration `supabase-migration-projects-section-files.sql`
    // is gated behind a separate run). Retry with just the `brief` TEXT column
    // so we still get rewrite content available.
    if (/brief_files/i.test(updErr.message) && column === 'brief_files') {
      const { error: brErr } = await supabaseAdmin
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

  await ensureBucket();

  const inserted: unknown[] = [];
  const extracted: UploadedRecord[] = [];
  const failures: { name: string; reason: string }[] = [];

  for (const file of files) {
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectKey = `${projectId}/${fileType}/${Date.now()}_${safe}`;
    const ab = await file.arrayBuffer();
    const buf = Buffer.from(ab);
    const contentType = file.type || 'application/octet-stream';

    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(objectKey, buf, { contentType, upsert: false });
    if (upErr) {
      // Surface the REAL reason — the previous code silently swallowed
      // storage failures and the UI was showing "File caricato!" even
      // when the bucket was missing or RLS denied the write.
      const reason = upErr.message || 'storage upload failed';
      console.warn(`[projecthub] storage upload failed for ${file.name}:`, reason);
      failures.push({ name: file.name, reason });
      continue;
    }
    const { data, error } = await supabaseAdmin
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
      console.warn(`[projecthub] DB insert failed for ${file.name}:`, error.message);
      // Roll back the storage object so we don't leak orphans.
      await supabaseAdmin.storage.from(BUCKET).remove([objectKey]).catch(() => {});
      failures.push({ name: file.name, reason: error.message });
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

  // If EVERY file failed return 500 with details so the UI can show a real
  // error instead of a misleading "File caricato!" toast. Partial successes
  // still return 200 with `failures` populated.
  if (inserted.length === 0 && failures.length > 0) {
    return NextResponse.json(
      {
        error: failures[0].reason,
        failures,
        hint: hasServiceRoleKey()
          ? 'Check the `project-files` bucket on Supabase — service role can write but the upload still failed.'
          : 'SUPABASE_SERVICE_ROLE_KEY is missing in the environment. Without it the server falls back to the anon key, which is normally blocked by RLS / bucket policies. Add the service-role key to .env.local (and to the Netlify env vars) and redeploy.',
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ inserted, failures });
}
