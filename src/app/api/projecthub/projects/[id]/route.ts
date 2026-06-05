import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  derivedProductBriefSections,
  legacyFilesForProject,
} from '@/lib/projecthub-legacy';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;

  // Access check up-front. Allowed if owner / master / shared / no-JWT.
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

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

  // Same access rule as GET — collaborators may edit fields (brief,
  // notes, status, ...). Return 404 to avoid leaking existence of
  // projects the caller can't touch.
  const access = await canAccessProject(req, id);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const allowedFields = ['name', 'description', 'thumbnail_path', 'product_brief_sections', 'status', 'notes', 'domain'];
  const update: Record<string, unknown> = {};
  for (const k of allowedFields) {
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
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;

  // DELETE is owner/master-only. A shared collaborator must NOT be
  // able to nuke the master's project — they only get read+edit access
  // (mirrors what the matching SQL policy enforces in RLS, where the
  // delete policy keeps the original owner_user_id = auth.uid() check).
  const { ctx, allowed, ownerUserId, viaShare } = await canAccessProject(req, id);
  if (!allowed) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (ctx.userId && !ctx.isMaster) {
    const isOwner = ownerUserId === ctx.userId;
    if (!isOwner || viaShare) {
      return NextResponse.json(
        { error: 'forbidden', message: 'Only the owner or the master can delete a project' },
        { status: 403 },
      );
    }
  }

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
