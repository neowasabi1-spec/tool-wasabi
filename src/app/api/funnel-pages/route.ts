import { NextRequest, NextResponse } from 'next/server';
import { getUserAccessContext } from '@/lib/auth/get-current-user';
import { listAccessibleProjectIds } from '@/lib/auth/project-access';
import { loadSlimFunnelPages } from '@/lib/slim-funnel-pages';
import { ownerEmailById } from '@/lib/auth/owner-emails';

export const dynamic = 'force-dynamic';
export const maxDuration = 26;

/**
 * GET /api/funnel-pages
 * Clone/Swipe list. Metadata only — HTML lives in page_html. Selecting the
 * JSONB blobs here is what made boot + this page hang and 57014 Postgres.
 */
export async function GET(req: NextRequest) {
  const ctx = await getUserAccessContext(req);

  const { rows, error } = await loadSlimFunnelPages();
  if (error) return NextResponse.json({ error }, { status: 500 });

  if (!ctx.userId || ctx.isMaster) {
    if (!ctx.isMaster) return NextResponse.json(rows);
    const emails = await ownerEmailById(
      rows.map((r) =>
        typeof (r as { owner_user_id?: unknown }).owner_user_id === 'string'
          ? String((r as { owner_user_id: string }).owner_user_id)
          : '',
      ),
    );
    return NextResponse.json(
      rows.map((r) => {
        const owner =
          typeof (r as { owner_user_id?: unknown }).owner_user_id === 'string'
            ? String((r as { owner_user_id: string }).owner_user_id)
            : null;
        return {
          ...r,
          owner_email: owner ? emails.get(owner) || null : null,
        };
      }),
    );
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
