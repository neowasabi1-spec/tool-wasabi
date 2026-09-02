import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The "Creatives" tab of the Creative section is backed by the existing
 * `creative_templates` table (it's also where "Import to templates" from the
 * Ads Library writes). Conventions layered on top of the legacy columns:
 *
 *  - Folders: a row with media_type='folder' (name = folder name, empty
 *    file_path). Items belong to a folder via `category` = folder name.
 *  - Text creatives: media_type='text', the copy lives in `tags`
 *    (file_path stays empty).
 *  - Image/video creatives: file uploaded to storage via ./sign-upload,
 *    then registered here with kind='file'.
 */

/** GET — list every creative + folder row of the project. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data, error } = await supabaseAdmin
    .from('creative_templates')
    .select('*')
    .eq('project_id', id)
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data || []);
}

/**
 * POST — create a folder, a text creative, or register an uploaded file.
 * Body (JSON):
 *   { kind: 'folder', name }
 *   { kind: 'text',   name, category?, content }
 *   { kind: 'file',   name, category?, file_path, media_type }
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const kind = String(body.kind || '');
  const name = String(body.name || '').trim().slice(0, 300);

  let row: Record<string, unknown> | null = null;

  if (kind === 'folder') {
    if (!name) return NextResponse.json({ error: 'Folder name required' }, { status: 400 });
    // No duplicate folders (case-insensitive).
    const { data: dupe } = await supabaseAdmin
      .from('creative_templates')
      .select('id')
      .eq('project_id', id)
      .eq('media_type', 'folder')
      .ilike('name', name)
      .maybeSingle();
    if (dupe) return NextResponse.json({ error: 'Folder already exists' }, { status: 409 });
    row = { project_id: id, name, media_type: 'folder', file_path: '', category: '', source_brand: '', tags: '' };
  } else if (kind === 'text') {
    const content = String(body.content || '').trim();
    if (!content) return NextResponse.json({ error: 'Text content required' }, { status: 400 });
    row = {
      project_id: id,
      name: name || content.slice(0, 60),
      media_type: 'text',
      file_path: '',
      category: String(body.category || '').slice(0, 200),
      source_brand: '',
      tags: content,
    };
  } else if (kind === 'file') {
    const filePath = String(body.file_path || '').trim();
    const mediaType = body.media_type === 'video' ? 'video' : 'image';
    if (!filePath) return NextResponse.json({ error: 'file_path required' }, { status: 400 });
    row = {
      project_id: id,
      name: name || 'Creative',
      media_type: mediaType,
      file_path: filePath,
      category: String(body.category || '').slice(0, 200),
      source_brand: '',
      tags: '',
    };
  } else {
    return NextResponse.json({ error: 'Unknown kind' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('creative_templates')
    .insert(row)
    .select()
    .single();
  if (error || !data) return NextResponse.json({ error: error?.message || 'Insert failed' }, { status: 500 });
  return NextResponse.json(data);
}
