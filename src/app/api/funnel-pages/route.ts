import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUserAccessContext } from '@/lib/auth/get-current-user';
import { listAccessibleProjectIds } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';

/**
 * GET /api/funnel-pages
 * Clone/Swipe list. Service role + project access, so pages Chimera created
 * (owner = master trigger) still show up for the project owner.
 */
export async function GET(req: NextRequest) {
  const ctx = await getUserAccessContext(req);

  const { data, error } = await supabaseAdmin
    .from('funnel_pages')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = data || [];

  if (!ctx.userId || ctx.isMaster) {
    return NextResponse.json(rows);
  }

  const { ownedIds, sharedIds } = await listAccessibleProjectIds(ctx.userId);
  const allowed = new Set([...ownedIds, ...sharedIds]);
  const visible = rows.filter((r) => {
    const owner = (r as { owner_user_id?: string | null }).owner_user_id;
    const projectId = (r as { project_id?: string | null }).project_id;
    if (owner === ctx.userId) return true;
    if (projectId && allowed.has(projectId)) return true;
    return false;
  });
  return NextResponse.json(visible);
}
