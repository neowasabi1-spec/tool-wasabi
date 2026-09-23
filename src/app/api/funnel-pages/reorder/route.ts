import { NextRequest, NextResponse } from 'next/server';
import { getUserAccessContext } from '@/lib/auth/get-current-user';
import { listAccessibleProjectIds } from '@/lib/auth/project-access';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALTER_SQL = 'ALTER TABLE public.funnel_pages ADD COLUMN IF NOT EXISTS sort_order integer;';
const NOTIFY_SQL = "NOTIFY pgrst, 'reload schema';";

async function ensureSortOrderColumn(): Promise<void> {
  const admin = getSupabaseAdmin();
  const { error } = await admin.rpc('exec_sql', { sql: ALTER_SQL });
  if (error) console.warn('[funnel-pages/reorder] sort_order column:', error.message);
  const notified = await admin.rpc('exec_sql', { sql: NOTIFY_SQL });
  if (notified.error) console.warn('[funnel-pages/reorder] schema reload:', notified.error.message);
}

/**
 * POST /api/funnel-pages/reorder
 * Body: { ids: string[] } in the order they should appear (index 0 = step 1).
 */
export async function POST(req: NextRequest) {
  const ctx = await getUserAccessContext(req);
  const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = Array.isArray(body?.ids)
    ? body.ids.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id))
    : [];
  if (!ids.length) {
    return NextResponse.json({ error: 'ids required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  let allowed = ids;
  if (ctx.userId && !ctx.isMaster) {
    const { ownedIds, sharedIds } = await listAccessibleProjectIds(ctx.userId);
    const projects = new Set([...ownedIds, ...sharedIds]);
    const { data, error } = await admin
      .from('funnel_pages')
      .select('id, owner_user_id, project_id')
      .in('id', ids);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const ok = new Set(
      (data || [])
        .filter((row) => {
          const owner = (row as { owner_user_id?: string | null }).owner_user_id;
          const projectId = (row as { project_id?: string | null }).project_id;
          return owner === ctx.userId || (!!projectId && projects.has(projectId));
        })
        .map((row) => String((row as { id: string }).id)),
    );
    allowed = ids.filter((id) => ok.has(id));
  }

  if (!allowed.length) {
    return NextResponse.json({ error: 'No pages to reorder' }, { status: 403 });
  }

  const values = allowed.map((id, index) => `('${id}'::uuid, ${index})`).join(', ');
  const sql =
    `UPDATE public.funnel_pages AS f SET sort_order = v.ord ` +
    `FROM (VALUES ${values}) AS v(id, ord) WHERE f.id = v.id;`;

  let { error } = await admin.rpc('exec_sql', { sql });
  if (error && /sort_order|does not exist|42703|schema cache/i.test(error.message || '')) {
    await ensureSortOrderColumn();
    await new Promise((resolve) => setTimeout(resolve, 700));
    ({ error } = await admin.rpc('exec_sql', { sql }));
  }

  if (error) {
    await ensureSortOrderColumn();
    for (let index = 0; index < allowed.length; index++) {
      const updated = await admin
        .from('funnel_pages')
        .update({ sort_order: index })
        .eq('id', allowed[index]);
      if (updated.error) {
        return NextResponse.json({ error: updated.error.message, saved: false }, { status: 500 });
      }
    }
  }

  return NextResponse.json({ ok: true, count: allowed.length });
}
