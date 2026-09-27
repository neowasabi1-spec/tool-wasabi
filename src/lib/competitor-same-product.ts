/**
 * Re-judge existing competitor_brands and deactivate those that are not the
 * same product/offer. Vertical peers (brand_type=inspiration) are never touched.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  judgeAdvertisers,
  hostOf,
  type AdvertiserCard,
  type ProductProfile,
} from '@/lib/competitor-judge';

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
      .select('headline, hook, body_text, landing_url')
      .eq('project_id', projectId)
      .eq('brand_id', b.id)
      .order('created_at', { ascending: false })
      .limit(4);

    const samples = (ads || [])
      .map((a) => [a.headline, a.hook, a.body_text].filter(Boolean).join(' — '))
      .filter(Boolean) as string[];

    const landingHost = hostOf((ads || []).find((a) => a.landing_url)?.landing_url || undefined);

    cards.push({
      id: String(b.id),
      name: b.name,
      samples: samples.length ? samples : [b.name],
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

  return { checked: candidates.length, removed, kept };
}
