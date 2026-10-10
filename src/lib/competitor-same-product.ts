/**
 * Same-product helpers. Discovery must add pages, not hide ones already saved.
 * restoreAutoPrunedBrands puts back brands a previous cleanup had deactivated.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  classifyOfferAd,
  judgeAdvertisers,
  hostOf,
  type AdvertiserCard,
  type ProductProfile,
} from '@/lib/competitor-judge';

/** Put back pages that same-product cleanup had soft-disabled. */
export async function restoreAutoPrunedBrands(projectId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('competitor_brands')
    .select('id, notes, is_active')
    .eq('project_id', projectId);

  if (error) throw new Error(error.message);

  const ids = ((data || []) as Array<{ id: number; notes?: string | null; is_active?: string | null }>)
    .filter((b) => String(b.notes || '').startsWith('auto_pruned_not_same_product'))
    .map((b) => b.id);

  if (!ids.length) return 0;

  const { error: updErr } = await supabaseAdmin
    .from('competitor_brands')
    .update({ is_active: 'true', notes: '' })
    .in('id', ids)
    .eq('project_id', projectId);

  if (updErr) throw new Error(updErr.message);
  return ids.length;
}

export async function pruneNonSameProductBrands(
  projectId: string,
  product: ProductProfile,
): Promise<{ checked: number; removed: number; kept: number }> {
  const profile: ProductProfile = {
    ...product,
    affiliate: true,
    names: (product.names?.length ? product.names : [product.name]).filter(Boolean),
  };

  const { data: brands, error } = await supabaseAdmin
    .from('competitor_brands')
    .select('id, name, brand_type, is_active')
    .eq('project_id', projectId)
    .neq('is_active', 'false');

  if (error) throw new Error(error.message);

  const candidates = ((brands || []) as Array<{
    id: number; name: string; brand_type?: string | null;
  }>).filter((b) => String(b.brand_type || '') !== 'inspiration' && String(b.brand_type || '') !== 'video_folder');

  if (!candidates.length) return { checked: 0, removed: 0, kept: 0 };

  const cards: AdvertiserCard[] = [];
  for (const b of candidates) {
    const { data: ads } = await supabaseAdmin
      .from('competitor_ads')
      .select('name, headline, hook, body_text, landing_url')
      .eq('project_id', projectId)
      .eq('brand_id', b.id)
      .order('created_at', { ascending: false })
      .limit(6);

    const samples = (ads || [])
      .map((a) => [a.name, a.headline, a.hook, a.body_text].filter(Boolean).join(' — '))
      .filter(Boolean) as string[];
    // Brand page name is decisive for off-niche junk (hotels, toys, etc.).
    const withBrand = [`Page: ${b.name}`, ...samples].slice(0, 6);

    const landingHost = hostOf((ads || []).find((a) => a.landing_url)?.landing_url || undefined);

    cards.push({
      id: String(b.id),
      name: b.name,
      samples: withBrand.length ? withBrand : [b.name],
      landingHost,
    });
  }

  const verdicts = await judgeAdvertisers(profile, cards);
  let removed = 0;
  let kept = 0;

  for (const b of candidates) {
    const v = verdicts.get(String(b.id));
    if (v?.competitor) {
      kept++;
      continue;
    }
    // Soft-disable so vertical history stays; UI filters inactive monitoring.
    const { error: updErr } = await supabaseAdmin
      .from('competitor_brands')
      .update({
        is_active: 'false',
        notes: `auto_pruned_not_same_product${v?.why ? `: ${v.why}` : ''}`,
      })
      .eq('id', b.id)
      .eq('project_id', projectId);
    if (!updErr) removed++;
  }

  const adPass = await hideAdsThatAreNotThisOffer(projectId);
  removed += adPass.brands;

  return { checked: candidates.length, removed, kept: kept - adPass.brands };
}

/** An advertiser stays, but ads that sell something else are marked off-target.
 *  A page with no ad for this offer is deactivated. */
async function hideAdsThatAreNotThisOffer(projectId: string): Promise<{ ads: number; brands: number }> {
  const { data, error } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, brand_id, name, headline, hook, body_text, relevance_label')
    .eq('project_id', projectId)
    .limit(2000);
  if (error || !data?.length) return { ads: 0, brands: 0 };

  const rows = data as Array<{
    id: number; brand_id: number; name?: string | null; headline?: string | null;
    hook?: string | null; body_text?: string | null; relevance_label?: string | null;
  }>;
  const offerBrands = new Set<number>();
  const offIds: number[] = [];
  for (const ad of rows) {
    const text = [ad.name, ad.headline, ad.hook, ad.body_text].filter(Boolean).join('\n');
    const kind = classifyOfferAd(text);
    if (kind === 'offer') offerBrands.add(ad.brand_id);
    else if (kind === 'other' && ad.relevance_label !== 'off_target') offIds.push(ad.id);
  }

  let ads = 0;
  for (let i = 0; i < offIds.length; i += 80) {
    const chunk = offIds.slice(i, i + 80);
    const { error: updErr } = await supabaseAdmin
      .from('competitor_ads')
      .update({
        relevance_score: 0,
        relevance_label: 'off_target',
        relevance_why: 'Does not sell this product',
        relevance_at: new Date().toISOString(),
      })
      .in('id', chunk)
      .eq('project_id', projectId);
    if (!updErr) ads += chunk.length;
  }

  const brandIds = [...new Set(rows.map((r) => r.brand_id))];
  const { data: brandRows } = await supabaseAdmin
    .from('competitor_brands')
    .select('id, brand_type')
    .in('id', brandIds);
  const keepType = new Set(
    ((brandRows || []) as Array<{ id: number; brand_type?: string | null }>)
      .filter((b) => {
        const t = String(b.brand_type || '');
        return t === 'inspiration' || t === 'video_folder';
      })
      .map((b) => b.id),
  );
  let brands = 0;
  for (const id of brandIds) {
    if (offerBrands.has(id) || keepType.has(id)) continue;
    const { error: updErr } = await supabaseAdmin
      .from('competitor_brands')
      .update({
        is_active: 'false',
        notes: 'auto_pruned_not_same_product: no ad sells this product',
      })
      .eq('id', id)
      .eq('project_id', projectId)
      .neq('is_active', 'false');
    if (!updErr) brands++;
  }
  return { ads, brands };
}
