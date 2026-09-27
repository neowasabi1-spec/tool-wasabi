import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { restoreAutoPrunedBrands } from '@/lib/competitor-same-product';
import { attachContentHashes, dedupeCreatives } from '@/lib/ads-intel/creative-fingerprint';
import { sortByWinnerTier } from '@/lib/competitor-winner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Ads Creative Library sources:
 * - competitor pages already in the library (including ones a same-product
 *   pass had hidden — those are restored on load)
 * - vertical peers the user added
 * Never: video_folder saves.
 */
async function libraryBrandIds(projectId: string): Promise<number[]> {
  const { data, error } = await supabaseAdmin
    .from('competitor_brands')
    .select('id, brand_type, is_active')
    .eq('project_id', projectId)
    .neq('is_active', 'false');
  if (error) throw new Error(error.message);
  return ((data || []) as Array<{ id: number; brand_type?: string | null }>)
    .filter((b) => String(b.brand_type || '') !== 'video_folder')
    .map((b) => b.id);
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const url = new URL(req.url);
  const source = url.searchParams.get('source') || 'competitor';

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

  let restored = 0;
  try {
    restored = await restoreAutoPrunedBrands(projectId);
  } catch (e) {
    console.warn('[ads-creative/library] restore pruned brands:', (e as Error).message);
  }

  const brandIds = await libraryBrandIds(projectId);
  if (!brandIds.length) {
    return NextResponse.json({ source: 'competitor', ads: [], restored, curatedOnly: true });
  }

  const { data, error } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, project_id, brand_id, name, headline, hook, body_text, media_type, file_path, media_hash, is_winner, ad_active, ad_started_at, spend, impressions, created_at')
    .eq('project_id', projectId)
    .in('brand_id', brandIds)
    .order('created_at', { ascending: false })
    .limit(400);
  // media_hash column may be missing until migration — retry without it.
  let rows: Record<string, unknown>[] | null = (data as Record<string, unknown>[] | null) || null;
  let selErr = error;
  if (selErr && /media_hash/i.test(selErr.message || '')) {
    const retry = await supabaseAdmin
      .from('competitor_ads')
      .select('id, project_id, brand_id, name, headline, hook, body_text, media_type, file_path, is_winner, ad_active, ad_started_at, spend, impressions, created_at')
      .eq('project_id', projectId)
      .in('brand_id', brandIds)
      .order('created_at', { ascending: false })
      .limit(400);
    rows = (retry.data as Record<string, unknown>[] | null) || null;
    selErr = retry.error;
  }
  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 });

  const { data: analyses } = await supabaseAdmin
    .from('creative_analyses')
    .select('id, ad_ref_id, status, updated_at')
    .eq('project_id', projectId)
    .eq('ad_source', 'competitor');

  const byRef = new Map((analyses || []).map((a: any) => [String(a.ad_ref_id), a]));
  let mapped = (rows || []).map((ad: any) => ({
    ...ad,
    analysis: byRef.get(String(ad.id)) || null,
  }));
  // Same bytes, different storage paths → one card (hashes computed on the fly).
  mapped = await attachContentHashes(mapped, { limit: 150, concurrency: 10 });
  const ads = sortByWinnerTier(dedupeCreatives(mapped)).slice(0, 120);
  const collapsed = mapped.length - ads.length;

  const bIds = [...new Set(ads.map((a: any) => a.brand_id).filter(Boolean))];
  let brandNames: Record<number, string> = {};
  if (bIds.length) {
    const { data: brands } = await supabaseAdmin
      .from('competitor_brands')
      .select('id, name')
      .in('id', bIds);
    for (const b of brands || []) brandNames[Number(b.id)] = String(b.name || '');
  }
  const withBrand = ads.map((a: any) => ({
    ...a,
    brand_name: brandNames[Number(a.brand_id)] || '',
  }));

  return NextResponse.json({
    source: 'competitor',
    ads: withBrand,
    restored,
    collapsed,
    curatedOnly: true,
  });
}
