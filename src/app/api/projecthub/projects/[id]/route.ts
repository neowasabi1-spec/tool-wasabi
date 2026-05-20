import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  derivedProductBriefSections,
  legacyFilesForProject,
} from '@/lib/projecthub-legacy';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;

  // Use `*` so the route is resilient to any subset of legacy columns
  // existing on the projects table. Listing them explicitly previously
  // caused the whole select to fail with "column does not exist" the
  // moment a single legacy column was missing (e.g. brief_files), which
  // wiped out every legacy file from the merged response.
  const { data: project, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !project) {
    return NextResponse.json(
      { error: error?.message || 'Not found' },
      { status: 404 },
    );
  }

  const projectRow = project as unknown as Record<string, unknown>;

  const { data: realFiles } = await supabase
    .from('project_files')
    .select('*')
    .eq('project_id', id)
    .order('created_at', { ascending: false });

  const virtualFiles = legacyFilesForProject(projectRow);
  const allFiles = [...(realFiles || []), ...virtualFiles];

  const sections = derivedProductBriefSections(projectRow);
  const productBriefSectionsString = JSON.stringify(sections);

  return NextResponse.json({
    ...project,
    files: allFiles,
    product_brief_sections: productBriefSectionsString,
  });
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
