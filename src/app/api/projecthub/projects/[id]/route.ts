import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const PROJECT_COLS =
  'id, name, status, description, domain, notes, created_at, updated_at, thumbnail_path, product_brief_sections';
const PROJECT_COLS_LEGACY =
  'id, name, status, description, domain, notes, created_at, updated_at';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;

  let { data: project, error } = await supabase
    .from('projects')
    .select(PROJECT_COLS)
    .eq('id', id)
    .single();

  if (error && /thumbnail_path|product_brief_sections/i.test(error.message || '')) {
    const retry = await supabase
      .from('projects')
      .select(PROJECT_COLS_LEGACY)
      .eq('id', id)
      .single();
    project = retry.data;
    error = retry.error;
  }
  if (error || !project) {
    return NextResponse.json(
      { error: error?.message || 'Not found' },
      { status: 404 },
    );
  }

  const { data: files } = await supabase
    .from('project_files')
    .select('*')
    .eq('project_id', id)
    .order('created_at', { ascending: false });

  return NextResponse.json({ ...project, files: files || [] });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  const body = await req.json().catch(() => ({}));

  const allowed = ['name', 'description', 'thumbnail_path', 'product_brief_sections', 'status', 'notes', 'domain'];
  const update: Record<string, unknown> = {};
  for (const k of allowed) {
    if (k in body) update[k] = body[k];
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No allowed fields' }, { status: 400 });
  }

  let { data, error } = await supabase
    .from('projects')
    .update(update)
    .eq('id', id)
    .select()
    .single();

  if (error && /thumbnail_path|product_brief_sections/i.test(error.message || '')) {
    delete update.thumbnail_path;
    delete update.product_brief_sections;
    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { error: 'Migration not run — run supabase-migration-projecthub.sql' },
        { status: 500 },
      );
    }
    const retry = await supabase
      .from('projects')
      .update(update)
      .eq('id', id)
      .select()
      .single();
    data = retry.data;
    error = retry.error;
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;

  const { data: files } = await supabase
    .from('project_files')
    .select('file_path')
    .eq('project_id', id);
  if (files && files.length > 0) {
    const keys = files.map((f: { file_path: string }) => f.file_path).filter(Boolean);
    if (keys.length > 0) {
      await supabase.storage.from('project-files').remove(keys);
    }
  }

  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
