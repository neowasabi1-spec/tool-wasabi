import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/projecthub/projects/:id/generated-videos
 * List videos recreated from real footage for the project. Optional filters:
 *   ?brandId=  ?adId=
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const sp = req.nextUrl.searchParams;
  const brandId = sp.get('brandId');
  const adId = sp.get('adId');

  let q = supabaseAdmin
    .from('generated_videos')
    .select('*')
    .eq('project_id', id)
    .order('created_at', { ascending: false });

  if (brandId && Number.isFinite(Number(brandId))) q = q.eq('brand_id', Number(brandId));
  if (adId && Number.isFinite(Number(adId))) q = q.eq('ad_id', Number(adId));

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data || []);
}
