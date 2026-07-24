import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Competitor Library — brands endpoint.
 *
 *   GET  /api/projecthub/projects/:id/competitor-library
 *        → list competitor_brands for the project, enriched with per-brand
 *          creative stats (counts, hooks, headlines) computed from
 *          competitor_ads. Shape matches the `CompetitorWithStats` type the
 *          frontend expects.
 *
 *   POST /api/projecthub/projects/:id/competitor-library
 *        → add a competitor brand.
 */

interface AdRow {
  brand_id: number;
  media_type: string;
  hook: string;
  headline: string;
}

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

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: brands, error } = await supabaseAdmin
    .from('competitor_brands')
    .select(
      'id, project_id, name, ads_library_url, scrape_count, frequency, brand_type, notes, is_active, last_scraped, created_at',
    )
    .eq('project_id', id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: ads } = await supabaseAdmin
    .from('competitor_ads')
    .select('brand_id, media_type, hook, headline')
    .eq('project_id', id);

  const adsByBrand = new Map<number, AdRow[]>();
  for (const a of (ads || []) as AdRow[]) {
    const list = adsByBrand.get(a.brand_id) || [];
    list.push(a);
    adsByBrand.set(a.brand_id, list);
  }

  const result = ((brands || []) as BrandRow[]).map((b) => {
    const list = adsByBrand.get(b.id) || [];
    const videoCount = list.filter((a) => a.media_type === 'video').length;
    const imageCount = list.filter((a) => a.media_type !== 'video').length;
    const hooks = [...new Set(list.map((a) => a.hook).filter(Boolean))];
    const headlines = [...new Set(list.map((a) => a.headline).filter(Boolean))];
    return {
      ...b,
      ads_count: list.length,
      video_count: videoCount,
      image_count: imageCount,
      hooks,
      headlines,
      monitoring_status: b.is_active === 'true' ? 'attivo' : 'in_analisi',
      last_check: b.last_scraped,
    };
  });

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
