import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import { markBrandSeen } from '@/lib/competitor-seen';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/projecthub/projects/:id/competitor-library/:cid/seen
 * Stamp a competitor as looked at, so the creatives the daily scrape added stop
 * counting as new. Called once the creatives grid has rendered them.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; cid: string } },
) {
  const { id, cid } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const brandId = Number(cid);
  if (!Number.isFinite(brandId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const ok = await markBrandSeen(id, brandId);
  return NextResponse.json({ ok });
}
