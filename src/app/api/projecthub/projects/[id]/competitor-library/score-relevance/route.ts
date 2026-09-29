import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import { scoreProjectAdsRelevance } from '@/lib/ads-intel/ad-relevance';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/projecthub/projects/:id/competitor-library/score-relevance
 * Body: { brandId?: number, limit?: number, force?: boolean }
 * Scores scraped ads vs our product with Jev (comparability + inspiration).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const brandId = body.brandId != null ? Number(body.brandId) : undefined;
  const limit = body.limit != null ? Number(body.limit) : 40;
  const force = body.force === true;

  try {
    const result = await scoreProjectAdsRelevance(projectId, {
      brandId: Number.isFinite(brandId) ? brandId : undefined,
      limit,
      force,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Score failed' },
      { status: 500 },
    );
  }
}
