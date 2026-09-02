/**
 * Shared helpers for the project's Creative → Creatives tab
 * (`creative_templates`: folders + our image/video cards).
 * Server-only (uses supabaseAdmin). Copy encode/decode lives in creative-copy.ts.
 */
import { supabaseAdmin } from '@/lib/supabase-admin';
export { parseCreativeCopy, encodeCreativeCopy, displayCreativeCopy } from '@/lib/creative-copy';
export type { CreativeCopy } from '@/lib/creative-copy';

export type FolderRef = { folderId: number; name: string };

export async function findFolderById(projectId: string, folderId: number): Promise<FolderRef | null> {
  const { data } = await supabaseAdmin
    .from('creative_templates')
    .select('id, name')
    .eq('project_id', projectId)
    .eq('id', folderId)
    .eq('media_type', 'folder')
    .maybeSingle();
  if (!data?.id) return null;
  return { folderId: data.id as number, name: String(data.name || '') };
}

export async function findFolderByName(projectId: string, name: string): Promise<FolderRef | null> {
  const { data } = await supabaseAdmin
    .from('creative_templates')
    .select('id, name')
    .eq('project_id', projectId)
    .eq('media_type', 'folder')
    .ilike('name', name)
    .maybeSingle();
  if (!data?.id) return null;
  return { folderId: data.id as number, name: String(data.name || name) };
}

/** Find or create a folder row. Idempotent. */
export async function ensureCreativeFolder(projectId: string, name: string): Promise<FolderRef> {
  const clean = name.trim().slice(0, 300);
  if (!clean) throw new Error('Folder name is required');
  const existing = await findFolderByName(projectId, clean);
  if (existing) return existing;
  const { data, error } = await supabaseAdmin
    .from('creative_templates')
    .insert({
      project_id: projectId,
      name: clean,
      media_type: 'folder',
      file_path: '',
      category: '',
      source_brand: '',
      tags: '',
    })
    .select('id, name')
    .single();
  if (error || !data) throw new Error(error?.message || 'Could not create folder');
  return { folderId: data.id as number, name: String(data.name || clean) };
}

export async function resolveFolder(
  projectId: string,
  folderId?: number | null,
  folderName?: string | null,
): Promise<FolderRef | null> {
  if (folderId && Number.isFinite(folderId) && folderId > 0) {
    const byId = await findFolderById(projectId, folderId);
    if (byId) return byId;
    throw new Error(`folderId ${folderId} not found in this project`);
  }
  const name = String(folderName || '').trim();
  if (!name) return null;
  return ensureCreativeFolder(projectId, name);
}
