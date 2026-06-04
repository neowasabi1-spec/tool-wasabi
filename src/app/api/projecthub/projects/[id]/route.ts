import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  derivedProductBriefSections,
  legacyFilesForProject,
} from '@/lib/projecthub-legacy';
import { getUserAccessContext } from '@/lib/auth/get-current-user';

export const dynamic = 'force-dynamic';

// Multi-tenancy helper: returns true when the caller is allowed to
// see/touch `ownerId`. Master → always allowed. Otherwise must match.
// When the caller has no session (server-to-server, worker), we allow
// it for now — phase 2 of the RLS rollout will lock this down.
function canAccessRow(
  ctx: { userId: string | null; isMaster: boolean },
  ownerId: string | null | undefined,
): boolean {
  if (!ctx.userId) return true; // legacy / unauthenticated — see "all"
  if (ctx.isMaster) return true;
  return !!ownerId && ownerId === ctx.userId;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  const ctx = await getUserAccessContext(req);

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
  if (!canAccessRow(ctx, projectRow.owner_user_id as string | null | undefined)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

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

  const ctx = await getUserAccessContext(req);
  // Ownership check BEFORE write — return 404 to avoid leaking the
  // existence of a project the caller doesn't own.
  if (ctx.userId && !ctx.isMaster) {
    const { data: owned } = await supabase
      .from('projects')
      .select('owner_user_id')
      .eq('id', id)
      .maybeSingle();
    if (!owned || (owned as { owner_user_id?: string }).owner_user_id !== ctx.userId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  }

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
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;

  const ctx = await getUserAccessContext(req);
  if (ctx.userId && !ctx.isMaster) {
    const { data: owned } = await supabase
      .from('projects')
      .select('owner_user_id')
      .eq('id', id)
      .maybeSingle();
    if (!owned || (owned as { owner_user_id?: string }).owner_user_id !== ctx.userId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
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
