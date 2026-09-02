import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type TemplateRow = {
  id: number;
  media_type: string;
  name: string;
  file_path: string;
  category: string;
};

async function loadRow(projectId: string, tid: number): Promise<TemplateRow | null> {
  const { data } = await supabaseAdmin
    .from('creative_templates')
    .select('id, media_type, name, file_path, category')
    .eq('project_id', projectId)
    .eq('id', tid)
    .maybeSingle();
  return (data as TemplateRow | null) || null;
}

/**
 * PATCH — rename, move to folder (category), or edit text content (tags).
 * Renaming a folder row also re-points every item inside it.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string; tid: string } }) {
  const { id } = params;
  const tid = Number(params.tid);
  const { allowed } = await canAccessProject(req, id);
  if (!allowed || !Number.isFinite(tid)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const row = await loadRow(id, tid);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const patch: Record<string, string> = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 300);
  if (typeof body.category === 'string') patch.category = body.category.slice(0, 200);
  // `tags` doubles as the creative's text/copy — editable on every media type.
  if (typeof body.content === 'string') patch.tags = body.content;
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from('creative_templates')
    .update(patch)
    .eq('project_id', id)
    .eq('id', tid)
    .select()
    .single();
  if (error || !data) return NextResponse.json({ error: error?.message || 'Update failed' }, { status: 500 });

  // Folder rename → migrate the items that referenced the old name.
  if (row.media_type === 'folder' && patch.name && patch.name !== row.name) {
    await supabaseAdmin
      .from('creative_templates')
      .update({ category: patch.name })
      .eq('project_id', id)
      .eq('category', row.name)
      .neq('media_type', 'folder');
  }

  return NextResponse.json(data);
}

/**
 * DELETE — remove a creative (and its storage file when we own it) or a
 * folder (items inside are moved back to the root, never deleted).
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string; tid: string } }) {
  const { id } = params;
  const tid = Number(params.tid);
  const { allowed } = await canAccessProject(req, id);
  if (!allowed || !Number.isFinite(tid)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const row = await loadRow(id, tid);
  if (!row) return NextResponse.json({ ok: true });

  if (row.media_type === 'folder') {
    await supabaseAdmin
      .from('creative_templates')
      .update({ category: '' })
      .eq('project_id', id)
      .eq('category', row.name)
      .neq('media_type', 'folder');
  } else if (row.file_path && row.file_path.startsWith(`${id}/creatives/`)) {
    // Only delete storage objects this tab uploaded itself — files imported
    // from the Ads Library are shared with competitor_ads rows.
    await supabaseAdmin.storage.from('project-files').remove([row.file_path]).catch(() => {});
  }

  const { error } = await supabaseAdmin
    .from('creative_templates')
    .delete()
    .eq('project_id', id)
    .eq('id', tid);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
