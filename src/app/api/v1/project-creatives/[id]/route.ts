import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '@/lib/api-key-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  encodeCreativeCopy,
  findFolderByName,
  parseCreativeCopy,
  resolveFolder,
} from '@/lib/creative-library';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Row = {
  id: number;
  project_id: string;
  name: string;
  media_type: string;
  file_path: string;
  category: string;
  tags: string;
};

function shape(r: Row, folderId: number | null) {
  const copy = parseCreativeCopy(r.tags);
  return {
    id: r.id,
    name: r.name,
    folderId,
    folderName: r.category || '',
    filePath: r.file_path,
    mediaType: r.media_type,
    headline: copy.headline,
    hook: copy.hook,
    bodyText: copy.bodyText,
  };
}

async function load(projectId: string, tid: number): Promise<Row | null> {
  const { data } = await supabaseAdmin
    .from('creative_templates')
    .select('id, project_id, name, media_type, file_path, category, tags')
    .eq('project_id', projectId)
    .eq('id', tid)
    .maybeSingle();
  return (data as Row | null) || null;
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await validateApiKey(req, 'write_products');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const tid = Number(params.id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const projectId = String(body.projectId || body.project_id || '').trim();
  if (!projectId || !Number.isFinite(tid)) {
    return NextResponse.json({ error: 'projectId and a numeric id are required' }, { status: 400 });
  }

  const row = await load(projectId, tid);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const patch: Record<string, string> = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 300);

  if (body.folderId !== undefined || body.folderName !== undefined || body.folder !== undefined) {
    try {
      const folder = await resolveFolder(
        projectId,
        Number(body.folderId) || null,
        String(body.folderName || body.folder || ''),
      );
      patch.category = folder?.name || '';
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'folder error' }, { status: 400 });
    }
  }

  if (
    body.headline !== undefined ||
    body.hook !== undefined ||
    body.bodyText !== undefined ||
    body.body_text !== undefined ||
    body.text !== undefined
  ) {
    const current = parseCreativeCopy(row.tags);
    patch.tags = encodeCreativeCopy({
      headline: body.headline !== undefined ? String(body.headline) : current.headline,
      hook: body.hook !== undefined ? String(body.hook) : current.hook,
      bodyText:
        body.bodyText !== undefined ? String(body.bodyText)
          : body.body_text !== undefined ? String(body.body_text)
            : body.text !== undefined ? String(body.text)
              : current.bodyText,
    });
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('creative_templates')
    .update(patch)
    .eq('project_id', projectId)
    .eq('id', tid)
    .select('id, project_id, name, media_type, file_path, category, tags')
    .single();
  if (error || !data) return NextResponse.json({ error: error?.message || 'Update failed' }, { status: 500 });

  if (row.media_type === 'folder' && patch.name && patch.name !== row.name) {
    await supabaseAdmin
      .from('creative_templates')
      .update({ category: patch.name })
      .eq('project_id', projectId)
      .eq('category', row.name)
      .neq('media_type', 'folder');
  }

  const out = data as Row;
  const folder = out.category ? await findFolderByName(projectId, out.category) : null;
  return NextResponse.json(shape(out, folder?.folderId ?? null));
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await validateApiKey(req, 'write_products');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const tid = Number(params.id);
  const projectId = req.nextUrl.searchParams.get('projectId')?.trim() || '';
  if (!projectId || !Number.isFinite(tid)) {
    return NextResponse.json({ error: 'projectId query and a numeric id are required' }, { status: 400 });
  }

  const row = await load(projectId, tid);
  if (!row) return NextResponse.json({ success: true });

  if (row.media_type === 'folder') {
    await supabaseAdmin
      .from('creative_templates')
      .update({ category: '' })
      .eq('project_id', projectId)
      .eq('category', row.name)
      .neq('media_type', 'folder');
  } else if (row.file_path && row.file_path.startsWith(`${projectId}/creatives/`)) {
    await supabaseAdmin.storage.from('project-files').remove([row.file_path]).catch(() => {});
  }

  const { error } = await supabaseAdmin
    .from('creative_templates')
    .delete()
    .eq('project_id', projectId)
    .eq('id', tid);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
