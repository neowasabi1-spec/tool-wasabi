/**
 * TEMPORARY diagnostic route — inspect archived_funnels project links.
 * Guarded by a one-off token. REMOVE after the investigation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

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

  return NextResponse.json({ total, linked, linkedRows, recent });
}
