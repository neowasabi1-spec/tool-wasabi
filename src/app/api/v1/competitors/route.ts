import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '@/lib/api-key-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ensureBrand } from '@/lib/competitor-ads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Competitor Library brands over the fsk_-key API, so MCP clients (Neo/Morfeo)
 * can list and add competitors exactly like the browser extension does — the
 * rows land in the same competitor_brands table the Project Hub UI reads.
 *
 *   GET  /api/v1/competitors[?projectId=…]  → list brands (+ creative counts)
 *   POST /api/v1/competitors                → add/ensure a competitor brand
 */

const BRAND_COLS =
  'id, project_id, name, ads_library_url, frequency, brand_type, is_active, last_scraped, scrape_count, created_at';

export async function GET(req: NextRequest) {
  const auth = await validateApiKey(req, 'read_products');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const projectId = req.nextUrl.searchParams.get('projectId')?.trim() || '';

  let q = supabaseAdmin.from('competitor_brands').select(BRAND_COLS).order('created_at', { ascending: false });
  if (projectId) q = q.eq('project_id', projectId);
  const { data: brands, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let adsQ = supabaseAdmin.from('competitor_ads').select('brand_id, media_type');
  if (projectId) adsQ = adsQ.eq('project_id', projectId);
  const { data: ads } = await adsQ;

  const counts = new Map<number, { total: number; video: number; image: number }>();
  for (const a of (ads || []) as Array<{ brand_id: number; media_type: string }>) {
    const c = counts.get(a.brand_id) || { total: 0, video: 0, image: 0 };
    c.total++;
    if (a.media_type === 'video') c.video++;
    else c.image++;
    counts.set(a.brand_id, c);
  }

  const competitors = ((brands || []) as Array<Record<string, unknown>>).map((b) => {
    const c = counts.get(b.id as number) || { total: 0, video: 0, image: 0 };
    return {
      ...b,
      ads_count: c.total,
      video_count: c.video,
      image_count: c.image,
      monitoring: (b.is_active as string) === 'true',
    };
  });

  return NextResponse.json({ competitors, count: competitors.length });
}

export async function POST(req: NextRequest) {
  const auth = await validateApiKey(req, 'write_products');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const projectId = String(body.projectId || body.project_id || '').trim();
  const name = String(body.name || '').trim();
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const adsLibraryUrl = String(body.adsLibraryUrl || body.ads_library_url || '').trim();
  const brandId = await ensureBrand(projectId, name, adsLibraryUrl);
  if (!brandId) return NextResponse.json({ error: 'Could not create competitor brand' }, { status: 500 });

  const patch: Record<string, unknown> = {};
  if (adsLibraryUrl) patch.ads_library_url = adsLibraryUrl;
  if (body.frequency) patch.frequency = String(body.frequency);
  const scrapeCount = Number(body.scrapeCount ?? body.scrape_count);
  if (Number.isFinite(scrapeCount) && scrapeCount > 0) patch.scrape_count = scrapeCount;
  if (body.autoScrape === true || body.autoScrape === 'true') patch.is_active = 'true';
  if (Object.keys(patch).length) {
    await supabaseAdmin.from('competitor_brands').update(patch).eq('id', brandId).eq('project_id', projectId);
  }

  const { data } = await supabaseAdmin.from('competitor_brands').select(BRAND_COLS).eq('id', brandId).maybeSingle();
  return NextResponse.json({ competitor: data || { id: brandId, project_id: projectId, name } });
}
