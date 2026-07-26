import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/projecthub/projects/:id/shots
 * List extracted competitor SHOTS for the project. Optional filters:
 *   ?brandId=  ?adId=  ?cleanOnly=1  (has_text is false/null)
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const sp = req.nextUrl.searchParams;
  const brandId = sp.get('brandId');
  const adId = sp.get('adId');
  const cleanOnly = sp.get('cleanOnly') === '1';

  let q = supabaseAdmin
    .from('competitor_shots')
    .select('*')
    .eq('project_id', id)
    .order('created_at', { ascending: false });

  if (brandId && Number.isFinite(Number(brandId))) q = q.eq('brand_id', Number(brandId));
  if (adId && Number.isFinite(Number(adId))) q = q.eq('ad_id', Number(adId));

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let rows = data || [];
  if (cleanOnly) rows = rows.filter((r) => (r as { has_text?: boolean }).has_text !== true);

  return NextResponse.json(rows);
}
