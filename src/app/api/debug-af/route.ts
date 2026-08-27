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

  // Decisive probe: a REAL service-role key bypasses RLS, so an insert +
  // read-back must succeed. If the insert is rejected by RLS, the configured
  // "service" key is actually anon-level and the data is merely invisible.
  const probe: Record<string, unknown> = {};
  const { data: ins, error: insErr } = await supabaseAdmin
    .from('archived_funnels')
    .insert({ name: '__wsb_diag_probe__', total_steps: 0, steps: [] })
    .select('id')
    .single();
  probe.insertError = insErr ? insErr.message : null;
  if (ins?.id) {
    const { data: back, error: readErr } = await supabaseAdmin
      .from('archived_funnels')
      .select('id, name')
      .eq('id', ins.id)
      .maybeSingle();
    probe.readBack = back ? 'ok' : `MISSING${readErr ? ' err=' + readErr.message : ''}`;
    const { error: delErr } = await supabaseAdmin.from('archived_funnels').delete().eq('id', ins.id);
    probe.cleanup = delErr ? `ERR ${delErr.message}` : 'deleted';
  }

  return NextResponse.json({
    hasServiceRoleKey: hasServiceRoleKey(),
    probe,
    counts,
    total,
    linked,
    linkedRows,
    recent,
  });
}
