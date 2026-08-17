import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '@/lib/api-key-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ensureBrand } from '@/lib/competitor-ads';
import { apifyConfigured } from '@/lib/apify';
import { startBrandScrape, type Brand } from '@/lib/competitor-scrape';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Kick off an Apify Ad Library scrape for a competitor over the fsk_-key API,
 * mirroring the Project Hub "Scrape now" button. Provide either an existing
 * brandId, or name + adsLibraryUrl to create the competitor on the fly.
 * Ingestion happens asynchronously via /api/apify/webhook.
 *
 *   POST /api/v1/competitors/scrape
 */
export async function POST(req: NextRequest) {
  const auth = await validateApiKey(req, 'write_products');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (!apifyConfigured()) {
    return NextResponse.json({ error: 'Scraping not configured (APIFY_KEY missing)' }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const projectId = String(body.projectId || body.project_id || '').trim();
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  let brandId = Number(body.brandId ?? body.competitorId ?? body.cid);
  const adsLibraryUrl = String(body.adsLibraryUrl || body.ads_library_url || '').trim();
  const name = String(body.name || '').trim();

  if (!Number.isFinite(brandId) || brandId <= 0) {
    if (!name || !adsLibraryUrl) {
      return NextResponse.json(
        { error: 'Provide brandId, or name + adsLibraryUrl to create the competitor first.' },
        { status: 400 },
      );
    }
    const ensured = await ensureBrand(projectId, name, adsLibraryUrl);
    if (!ensured) return NextResponse.json({ error: 'Could not create competitor brand' }, { status: 500 });
    brandId = ensured;
    await supabaseAdmin
      .from('competitor_brands')
      .update({ ads_library_url: adsLibraryUrl })
      .eq('id', brandId)
      .eq('project_id', projectId);
  }

  const { data: brand } = await supabaseAdmin
    .from('competitor_brands')
    .select('id, project_id, name, ads_library_url, frequency, scrape_count, is_active, last_scraped')
    .eq('id', brandId)
    .eq('project_id', projectId)
    .maybeSingle();

  if (!brand) return NextResponse.json({ error: 'Competitor not found in this project' }, { status: 404 });
  if (!brand.ads_library_url) {
    return NextResponse.json({ error: 'Add the competitor Ad Library URL first' }, { status: 400 });
  }

  const res = await startBrandScrape(brand as Brand);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });

  return NextResponse.json({ ok: true, brandId, runId: res.runId });
}
