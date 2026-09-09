import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { loadStepOffer } from '@/lib/step-offer';

export const dynamic = 'force-dynamic';

/** GET /api/projecthub/projects/:id/step-offer?pageType=&name=
 *  Price + brief + packshot for this funnel step (manual tabs or Chimera). */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const url = new URL(req.url);
  const pageType = String(url.searchParams.get('pageType') || '');
  const name = String(url.searchParams.get('name') || '');
  const offer = await loadStepOffer(supabaseAdmin, projectId, pageType, name);
  return NextResponse.json(offer);
}
