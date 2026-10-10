import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { seedCompetitorBrandsFromResearch } from '@/lib/seed-competitors-from-research';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Competitor Library — brands endpoint.
 *
 *   GET  → brands + per-brand stats (SQL aggregate — not a full ads dump)
 *   POST → add a competitor brand
 */

interface BrandRow {
  id: number;
  project_id: string;
  name: string;
  ads_library_url: string;
  scrape_count: number;
  frequency: string;
  brand_type: string;
  notes: string;
  is_active: string;
  last_scraped: string | null;
  created_at: string;
}

type StatsRow = {
  brand_id: number;
  ads_count: number;
  video_count: number;
  image_count: number;
  new_count: number;
  preview_paths: string[] | null;
  preview_types: string[] | null;
};

type SlimAd = {
  brand_id: number;
  media_type: string | null;
  file_path: string | null;
  created_at: string | null;
};

/** Fallback when RPC migration is not applied yet — capped + slim columns. */
async function statsFallback(projectId: string): Promise<Map<number, StatsRow>> {
  const { data: ads } = await supabaseAdmin
    .from('competitor_ads')
    .select('brand_id, media_type, file_path, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(2500);

  const map = new Map<number, StatsRow & { _previewN: number }>();
  for (const raw of (ads || []) as SlimAd[]) {
    const id = Number(raw.brand_id);
    let row = map.get(id) as (StatsRow & { _previewN: number }) | undefined;
    if (!row) {
      row = {
        brand_id: id,
        ads_count: 0,
        video_count: 0,
        image_count: 0,
        new_count: 0,
        preview_paths: [],
        preview_types: [],
        _previewN: 0,
      };
      map.set(id, row);
    }
    row.ads_count++;
    if (raw.media_type === 'video') row.video_count++;
    else row.image_count++;
    if (raw.file_path && row._previewN < 4) {
      (row.preview_paths as string[]).push(raw.file_path);
      (row.preview_types as string[]).push(raw.media_type || 'image');
      row._previewN++;
    }
  }
  return map;
}

async function loadStats(projectId: string): Promise<Map<number, StatsRow>> {
  const { data, error } = await supabaseAdmin.rpc('competitor_library_brand_stats', {
    p_project_id: projectId,
  });
  if (!error && Array.isArray(data)) {
    const map = new Map<number, StatsRow>();
    for (const r of data as StatsRow[]) {
      map.set(Number(r.brand_id), r);
    }
    return map;
  }
  if (error && !/competitor_library_brand_stats|42883|PGRST202/i.test(error.message || '')) {
    console.warn('[competitor-library] stats rpc:', error.message);
  }
  return statsFallback(projectId);
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // restoreAutoPrunedBrands removed from GET hot path (was scanning brands on every live refresh).

  let { data: brands, error } = await supabaseAdmin
    .from('competitor_brands')
    .select(
      'id, project_id, name, ads_library_url, scrape_count, frequency, brand_type, notes, is_active, last_scraped, created_at',
    )
    .eq('project_id', id)
    .order('created_at', { ascending: false });

  if (!error && !(brands || []).length) {
    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('name')
      .eq('id', id)
      .maybeSingle();
    await seedCompetitorBrandsFromResearch(supabaseAdmin, id, {
      ownName: String((project as { name?: string } | null)?.name || ''),
    }).catch((e) => console.warn('[competitor-library] seed:', (e as Error).message));
    const retry = await supabaseAdmin
      .from('competitor_brands')
      .select(
        'id, project_id, name, ads_library_url, scrape_count, frequency, brand_type, notes, is_active, last_scraped, created_at',
      )
      .eq('project_id', id)
      .order('created_at', { ascending: false });
    brands = retry.data;
    error = retry.error;
  }

  const stats = await loadStats(id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const result = ((brands || []) as BrandRow[])
    .filter((b) => !String(b.notes || '').startsWith('auto_pruned_not_same_product'))
    .map((b) => {
    const s = stats.get(b.id);
    const paths = (s?.preview_paths || []).filter(Boolean);
    const types = (s?.preview_types || []).filter(Boolean);
    const previews = paths.map((file_path, i) => ({
      file_path,
      media_type: types[i] || 'image',
    }));
    const preview = previews.find((p) => p.media_type !== 'video') || previews[0] || null;
    return {
      ...b,
      ads_count: Number(s?.ads_count || 0),
      new_count: Number(s?.new_count || 0),
      video_count: Number(s?.video_count || 0),
      image_count: Number(s?.image_count || 0),
      hooks: [] as string[],
      headlines: [] as string[],
      monitoring_status: b.is_active === 'true' ? 'attivo' : 'in_analisi',
      last_check: b.last_scraped,
      preview_path: preview?.file_path || '',
      preview_type: preview?.media_type || '',
      previews,
    };
  });

  const { data: offRows } = await supabaseAdmin
    .from('competitor_ads')
    .select('brand_id, file_path')
    .eq('project_id', id)
    .eq('relevance_label', 'off_target')
    .limit(2000);
  const offByBrand = new Map<number, Set<string>>();
  for (const row of (offRows || []) as Array<{ brand_id: number; file_path?: string | null }>) {
    const set = offByBrand.get(row.brand_id) || new Set<string>();
    if (row.file_path) set.add(row.file_path);
    offByBrand.set(row.brand_id, set);
  }
  for (const brand of result) {
    const off = offByBrand.get(brand.id);
    if (!off?.size) continue;
    brand.ads_count = Math.max(0, brand.ads_count - off.size);
    if (brand.previews?.length) {
      brand.previews = brand.previews.filter((p) => !off.has(p.file_path));
      const first = brand.previews[0];
      brand.preview_path = first?.file_path || '';
      brand.preview_type = first?.media_type || '';
    }
  }

  return NextResponse.json(result);
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const insert = {
    project_id: id,
    name,
    ads_library_url: String(body.ads_library_url || '').trim(),
    scrape_count: Number.isFinite(Number(body.scrape_count)) ? Number(body.scrape_count) : 10,
    frequency: String(body.frequency || 'every_7_days'),
    brand_type: String(body.brand_type || 'competitor'),
    notes: String(body.notes || ''),
  };

  const { data, error } = await supabaseAdmin
    .from('competitor_brands')
    .insert(insert)
    .select()
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Insert failed' }, { status: 500 });
  }

  return NextResponse.json({
    ...data,
    ads_count: 0,
    video_count: 0,
    image_count: 0,
    hooks: [],
    headlines: [],
    monitoring_status: 'in_analisi',
    last_check: null,
  });
}
