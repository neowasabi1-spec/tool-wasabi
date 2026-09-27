import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { loadDiscoveryLexicon } from '@/lib/discovery-lexicon';
import { pruneNonSameProductBrands } from '@/lib/competitor-same-product';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/** Same-product competitor pages only (not vertical peers / inactive / video folders). */
async function sameProductBrandIds(projectId: string): Promise<number[]> {
  const { data, error } = await supabaseAdmin
    .from('competitor_brands')
    .select('id, brand_type, is_active')
    .eq('project_id', projectId)
    .neq('is_active', 'false');
  if (error) throw new Error(error.message);
  return ((data || []) as Array<{ id: number; brand_type?: string | null }>)
    .filter((b) => {
      const t = String(b.brand_type || '');
      return t !== 'inspiration' && t !== 'video_folder';
    })
    .map((b) => b.id);
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const url = new URL(req.url);
  const source = url.searchParams.get('source') || 'competitor';
  const cleanup = url.searchParams.get('cleanup') !== '0';

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

  let pruned = 0;
  if (cleanup) {
    try {
      const lexicon = await loadDiscoveryLexicon(supabaseAdmin, projectId);
      const product = lexicon.product;
      if (product?.name) {
        const r = await pruneNonSameProductBrands(projectId, {
          name: product.name,
          description: product.description || '',
          market: product.market || '',
          affiliate: true,
          hosts: product.hosts || [],
          offerUrl: product.offerUrl || undefined,
          names: product.names?.length ? product.names : [product.name],
        });
        pruned = r.removed;
      } else {
        const { data: project } = await supabaseAdmin
          .from('projects')
          .select('name, description')
          .eq('id', projectId)
          .maybeSingle();
        if (project?.name) {
          const r = await pruneNonSameProductBrands(projectId, {
            name: String(project.name),
            description: String(project.description || '').slice(0, 900),
            affiliate: true,
            names: [String(project.name)],
          });
          pruned = r.removed;
        }
      }
    } catch (e) {
      console.warn('[ads-creative/library] prune:', (e as Error).message);
    }
  }

  const brandIds = await sameProductBrandIds(projectId);
  if (!brandIds.length) {
    return NextResponse.json({ source: 'competitor', ads: [], pruned, sameProductOnly: true });
  }

  const { data, error } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, project_id, brand_id, name, headline, hook, body_text, media_type, file_path, is_winner, ad_active, spend, impressions, created_at')
    .eq('project_id', projectId)
    .in('brand_id', brandIds)
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

  return NextResponse.json({ source: 'competitor', ads, pruned, sameProductOnly: true });
}
