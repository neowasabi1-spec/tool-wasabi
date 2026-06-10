import { NextRequest, NextResponse } from 'next/server';
// IMPORTANT: usa il client admin (service-role) NON il client anon.
// Il client anon lato server non ha il JWT dell'utente (il JWT splicing
// in src/lib/supabase.ts legge da window.localStorage che esiste solo
// nel browser), quindi su Postgres auth.uid()=NULL. Le policy RLS
// INSERT installate da phase-2 e dalla migration project_shares
// richiedono owner_user_id = auth.uid(), quindi l'insert da utente
// normale veniva rifiutato silenziosamente ("Insert failed"). Con il
// service-role bypassiamo RLS e ricostruiamo la permission lato codice
// via getUserAccessContext / listAccessibleProjectIds — stesso pattern
// gia' usato dalle altre rotte (vedi src/lib/auth/project-access.ts).
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUserAccessContext } from '@/lib/auth/get-current-user';
import { listAccessibleProjectIds } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';

const PROJECT_COLS =
  'id, name, status, description, domain, notes, created_at, updated_at, thumbnail_path, product_brief_sections, owner_user_id';
const PROJECT_COLS_LEGACY =
  'id, name, status, description, domain, notes, created_at, updated_at, owner_user_id';

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams.get('search');

  // Multi-tenancy:
  //   - master / no-JWT → see everything (phase-1 transitional)
  //   - regular user    → own projects UNION projects shared with them
  //                       via the project_shares table (the master can
  //                       grant per-user collaborative access).
  const ctx = await getUserAccessContext(req);
  let visibleIds: string[] | null = null;
  if (ctx.userId && !ctx.isMaster) {
    const { ownedIds, sharedIds } = await listAccessibleProjectIds(ctx.userId);
    visibleIds = Array.from(new Set([...ownedIds, ...sharedIds]));
    // No accessible projects at all → short-circuit; avoids a useless
    // round-trip with `.in('id', [])` returning everything on some
    // PostgREST versions.
    if (visibleIds.length === 0) return NextResponse.json([]);
  }

  let query = supabaseAdmin
    .from('projects')
    .select(PROJECT_COLS)
    .order('created_at', { ascending: false });
  if (visibleIds) query = query.in('id', visibleIds);

  let { data, error } = await query;

  if (error && /thumbnail_path|product_brief_sections/i.test(error.message || '')) {
    let retryQuery = supabaseAdmin
      .from('projects')
      .select(PROJECT_COLS_LEGACY)
      .order('created_at', { ascending: false });
    if (visibleIds) retryQuery = retryQuery.in('id', visibleIds);
    const retry = await retryQuery;
    data = retry.data;
    error = retry.error;
    console.warn(
      '[projecthub] missing thumbnail_path/product_brief_sections columns — run supabase-migration-projecthub.sql',
    );
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let projects = data || [];
  if (search) {
    const q = search.toLowerCase();
    projects = projects.filter((p: { name?: string }) =>
      (p.name || '').toLowerCase().includes(q),
    );
  }
  return NextResponse.json(projects);
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  let formFiles: { fieldName: string; file: File }[] = [];

  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    const fd = await req.formData();
    body.name = String(fd.get('name') || '');
    const sections = fd.get('product_brief_sections');
    if (sections) body.product_brief_sections = String(sections);
    for (const [field, value] of fd.entries()) {
      if (value instanceof File && value.size > 0) {
        formFiles.push({ fieldName: field, file: value });
      }
    }
  } else {
    body = await req.json().catch(() => ({}));
  }

  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return NextResponse.json({ error: 'Missing name' }, { status: 400 });
  }

  // Multi-tenancy: tag the new project with the creator. If no JWT is
  // present (anon server-to-server), we leave it null and the DB
  // trigger will fall back to the master account.
  const ctx = await getUserAccessContext(req);

  const insert: Record<string, unknown> = {
    name: String(body.name).trim(),
    status: 'active',
    description: '',
  };
  if (body.product_brief_sections) {
    insert.product_brief_sections = body.product_brief_sections;
  }
  if (ctx.userId) insert.owner_user_id = ctx.userId;

  let { data: project, error } = await supabaseAdmin
    .from('projects')
    .insert(insert)
    .select(PROJECT_COLS)
    .single();

  if (error && /product_brief_sections/i.test(error.message || '')) {
    delete insert.product_brief_sections;
    const retry = await supabaseAdmin
      .from('projects')
      .insert(insert)
      .select(PROJECT_COLS_LEGACY)
      .single();
    project = retry.data;
    error = retry.error;
  }

  if (error || !project) {
    // Log esplicito: cosi' in produzione (Vercel logs) vediamo subito
    // se l'insert fallisce per RLS, FK mancante, o constraint nome.
    console.error('[projecthub] project insert failed:', {
      message: error?.message,
      code: (error as { code?: string } | null)?.code,
      hasUser: !!ctx.userId,
      isMaster: ctx.isMaster,
    });
    return NextResponse.json(
      { error: error?.message || 'Insert failed' },
      { status: 500 },
    );
  }

  if (formFiles.length > 0) {
    const uploaded = await uploadFilesAndRecord(
      project.id,
      formFiles.map((f) => ({ fileType: f.fieldName, file: f.file })),
    );
    return NextResponse.json({ ...project, files: uploaded });
  }

  return NextResponse.json(project);
}

async function uploadFilesAndRecord(
  projectId: string,
  uploads: { fileType: string; file: File }[],
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const u of uploads) {
    const safe = u.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectKey = `${projectId}/${u.fileType}/${Date.now()}_${safe}`;
    const ab = await u.file.arrayBuffer();
    const { error: upErr } = await supabaseAdmin.storage
      .from('project-files')
      .upload(objectKey, Buffer.from(ab), {
        contentType: u.file.type || 'application/octet-stream',
        upsert: false,
      });
    if (upErr) {
      console.warn('[projecthub] storage upload failed:', upErr.message);
      continue;
    }
    const { data, error } = await supabaseAdmin
      .from('project_files')
      .insert({
        project_id: projectId,
        file_type: u.fileType,
        file_path: objectKey,
        original_name: u.file.name,
      })
      .select()
      .single();
    if (!error && data) out.push(data);
  }
  return out;
}
