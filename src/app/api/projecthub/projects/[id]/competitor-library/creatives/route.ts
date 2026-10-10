import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { loadSeenAt, tagNewAds } from '@/lib/competitor-seen';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/projecthub/projects/:id/competitor-library/creatives
 * All competitor creatives for the project (flat), each tagged with its
 * competitor brand id + name. Powers the "All creatives" view.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const [{ data: ads, error }, { data: brands }, seenAt] = await Promise.all([
    supabaseAdmin
      .from('competitor_ads')
      .select('*')
      .eq('project_id', id)
      .order('created_at', { ascending: false }),
    supabaseAdmin.from('competitor_brands').select('id, name, ads_library_url, notes, is_active').eq('project_id', id),
    loadSeenAt(id),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const nameById = new Map<number, string>();
  const urlById = new Map<number, string>();
  const hiddenBrand = new Set<number>();
  for (const b of (brands || []) as { id: number; name: string; ads_library_url?: string; notes?: string; is_active?: string }[]) {
    nameById.set(b.id, b.name);
    if (b.ads_library_url) urlById.set(b.id, b.ads_library_url);
    if (b.is_active === 'false' || String(b.notes || '').startsWith('auto_pruned_not_same_product')) {
      hiddenBrand.add(b.id);
    }
  }

  const result = tagNewAds(
    (ads || []) as { brand_id: number; created_at?: string }[],
    seenAt,
  ).map((a) => ({
    ...a,
    brand_name: nameById.get(a.brand_id) || '',
    ads_library_url: urlById.get(a.brand_id) || '',
  })).filter((a) => {
    const row = a as { brand_id: number; relevance_label?: string | null; name?: string | null; headline?: string | null; hook?: string | null; body_text?: string | null; landing_url?: string | null };
    if (hiddenBrand.has(row.brand_id)) return false;
    if (row.relevance_label === 'off_target') return false;
    if (/vibriance\.com/i.test(String(row.landing_url || '') + String(row.headline || '') + String(row.name || ''))) return false;
    return true;
  });

  return NextResponse.json(result);
}
