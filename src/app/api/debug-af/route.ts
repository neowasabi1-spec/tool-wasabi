/**
 * TEMPORARY diagnostic route — inspect archived_funnels project links.
 * Guarded by a one-off token. REMOVE after the investigation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, hasServiceRoleKey } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TOKEN = 'wsb-diag-8f3a1c6e2b';

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const [{ count: total }, { count: linked }, { data: recent }, { data: linkedRows }] =
    await Promise.all([
      supabaseAdmin.from('archived_funnels').select('id', { count: 'exact', head: true }),
      supabaseAdmin
        .from('archived_funnels')
        .select('id', { count: 'exact', head: true })
        .not('project_id', 'is', null),
      supabaseAdmin
        .from('archived_funnels')
        .select('id, name, project_id, owner_user_id, total_steps, created_at, section')
        .order('created_at', { ascending: false })
        .limit(30),
      supabaseAdmin
        .from('archived_funnels')
        .select('id, name, project_id, created_at')
        .not('project_id', 'is', null)
        .limit(30),
    ]);

  const counts: Record<string, number | string> = {};
  for (const t of ['archived_funnels', 'archive_categories', 'projects', 'funnel_pages', 'page_html']) {
    const { count, error } = await supabaseAdmin.from(t).select('*', { count: 'exact', head: true });
    counts[t] = error ? `ERR ${error.message}` : (count ?? -1);
  }

  return NextResponse.json({
    hasServiceRoleKey: hasServiceRoleKey(),
    counts,
    total,
    linked,
    linkedRows,
    recent,
  });
}
