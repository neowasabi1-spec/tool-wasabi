'use client';

/**
 * Supabase Storage helper for the projecthub integration.
 *
 * Replaces projecthub's express + multer + local-filesystem upload pipeline
 * with a Supabase Storage backed equivalent. Uploaded files live in the
 * `project-files` bucket organised as:
 *
 *   project-files/{projectId}/{file_type}/{timestamp}_{slug}.{ext}
 *
 * The returned `file_path` is the storage object key — pass it through
 * `getPublicUrlForFile` to render or download.
 */

import { getSupabaseBrowser } from './supabase-browser';

export const PROJECTHUB_BUCKET = 'project-files';

export interface UploadedFile {
  /** Storage object key (use `getPublicUrlForFile` to get a URL) */
  filePath: string;
  /** Public URL for direct linking (only valid for public buckets) */
  publicUrl: string;
  /** Original filename as uploaded by the user */
  originalName: string;
  /** MIME type of the uploaded file */
  contentType: string;
  /** File size in bytes */
  size: number;
}

function slugifyFilename(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const safe = base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return `${safe}_${Date.now()}${ext}`;
}

export async function uploadProjectFile(
  projectId: string,
  fileType: string,
  file: File,
): Promise<UploadedFile> {
  const supabase = getSupabaseBrowser();
  if (!supabase) {
    throw new Error('Supabase not configured (missing env vars)');
  }
  const objectKey = `${projectId}/${fileType}/${slugifyFilename(file.name)}`;
  const { error } = await supabase.storage
    .from(PROJECTHUB_BUCKET)
    .upload(objectKey, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || 'application/octet-stream',
    });
  if (error) {
    throw new Error(`Upload failed: ${error.message}`);
  }

  const { data: pub } = supabase.storage
    .from(PROJECTHUB_BUCKET)
    .getPublicUrl(objectKey);

  return {
    filePath: objectKey,
    publicUrl: pub.publicUrl,
    originalName: file.name,
    contentType: file.type || 'application/octet-stream',
    size: file.size,
  };
}

export async function uploadManyProjectFiles(
  projectId: string,
  fileType: string,
  files: File[],
): Promise<UploadedFile[]> {
  const out: UploadedFile[] = [];
  for (const f of files) {
    out.push(await uploadProjectFile(projectId, fileType, f));
  }
  return out;
}

export function getPublicUrlForFile(filePath: string): string | null {
  const supabase = getSupabaseBrowser();
  if (!supabase) return null;
  const { data } = supabase.storage
    .from(PROJECTHUB_BUCKET)
    .getPublicUrl(filePath);
  return data?.publicUrl || null;
}

/**
 * Convenience wrapper used by projecthub components in place of the original
 * `/uploads/${file_path}` express static-file URL. Returns an empty string
 * when Supabase isn't configured so `<img src="">` simply shows a broken
 * image instead of crashing the render.
 */
export function getUploadUrl(filePath?: string | null): string {
  if (!filePath) return '';
  if (/^https?:\/\//i.test(filePath)) return filePath;
  // Legacy synthetic paths produced by `legacyFilesForProject` resolve to a
  // server route that streams the inlined text content as a download
  // (legacy section files used to live as text inside JSONB columns, not in
  // Supabase Storage).
  if (filePath.startsWith('legacy/')) {
    return `/api/projecthub/legacy-files/${filePath.slice('legacy/'.length)}`;
  }
  return getPublicUrlForFile(filePath) || '';
}

export async function deleteProjectFile(filePath: string): Promise<void> {
  const supabase = getSupabaseBrowser();
  if (!supabase) return;
  const { error } = await supabase.storage
    .from(PROJECTHUB_BUCKET)
    .remove([filePath]);
  if (error) {
    console.warn('[projecthub-storage] delete failed:', error.message);
  }
}

/**
 * Mimics the express+multer "fields" interface so projecthub-style multi-field
 * forms (mockup[], ugc[], market_research, product_brief, ...) can be ported
 * with minimal refactoring.
 */
export interface MulterStyleFields {
  [fieldName: string]: File[] | undefined;
}

export async function uploadMultipartProjectFiles(
  projectId: string,
  fields: MulterStyleFields,
): Promise<{ [fieldName: string]: UploadedFile[] }> {
  const out: { [fieldName: string]: UploadedFile[] } = {};
  for (const [fieldName, files] of Object.entries(fields)) {
    if (!files || files.length === 0) continue;
    out[fieldName] = await uploadManyProjectFiles(projectId, fieldName, files);
  }
  return out;
}
