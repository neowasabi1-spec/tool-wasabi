import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { apifyConfigured } from '@/lib/apify';
import { startBrandScrape, type Brand } from '@/lib/competitor-scrape';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/projecthub/projects/:id/competitor-library/:cid/scrape
 * Manually kick off an Apify Ad Library run for a brand ("Scrape now").
 * Ingestion happens asynchronously via /api/apify/webhook.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; cid: string } },
) {
  const { id, cid } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!apifyConfigured()) {
    return NextResponse.json({ error: 'Scraping not configured (APIFY_KEY missing)' }, { status: 400 });
  }

  const brandId = Number(cid);
  const { data: brand } = await supabaseAdmin
    .from('competitor_brands')
    .select('id, project_id, name, ads_library_url, frequency, scrape_count, is_active, last_scraped')
    .eq('id', brandId)
    .eq('project_id', id)
    .maybeSingle();

  if (!brand) return NextResponse.json({ error: 'Competitor not found' }, { status: 404 });
  if (!brand.ads_library_url) {
    return NextResponse.json({ error: 'Add the competitor Ad Library URL first' }, { status: 400 });
  }

  const res = await startBrandScrape(brand as Brand);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });

  return NextResponse.json({ ok: true, runId: res.runId });
}
