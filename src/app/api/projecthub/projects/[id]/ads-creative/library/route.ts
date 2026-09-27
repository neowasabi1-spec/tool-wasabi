import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const source = new URL(req.url).searchParams.get('source') || 'competitor';

  if (source === 'own') {
    const { data, error } = await supabaseAdmin
      .from('own_ads')
      .select('*, own_ad_insights(*)')
      .eq('project_id', projectId)
      .order('synced_at', { ascending: false })
      .limit(100);
    if (error) {
      return NextResponse.json({
        error: error.message + (/own_ads/i.test(error.message) ? ' Apply supabase-migration-ads-intel.sql' : ''),
        ads: [],
      }, { status: /own_ads/i.test(error.message) ? 200 : 500 });
    }
    return NextResponse.json({ source: 'own', ads: data || [] });
  }

  const { data, error } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, project_id, brand_id, name, headline, hook, body_text, media_type, file_path, is_winner, ad_active, spend, impressions, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: analyses } = await supabaseAdmin
    .from('creative_analyses')
    .select('id, ad_ref_id, status, updated_at')
    .eq('project_id', projectId)
    .eq('ad_source', 'competitor');

  const byRef = new Map((analyses || []).map((a: any) => [String(a.ad_ref_id), a]));
  const ads = (data || []).map((ad: any) => ({
    ...ad,
    analysis: byRef.get(String(ad.id)) || null,
  }));

  return NextResponse.json({ source: 'competitor', ads });
}
