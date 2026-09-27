import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { apifyConfigured } from '@/lib/apify';
import { startBrandScrape, type Brand } from '@/lib/competitor-scrape';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_STARTS = 25;

/**
 * Force-refresh every monitored competitor page in this project
 * (new creatives + active/inactive status via Apify webhook ingest).
 *
 *   POST /api/projecthub/projects/:id/competitor-library/refresh-all
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!apifyConfigured()) {
    return NextResponse.json({ error: 'Scraping not configured (APIFY_KEY missing)' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('competitor_brands')
    .select('id, project_id, name, ads_library_url, frequency, scrape_count, is_active, last_scraped, brand_type')
    .eq('project_id', id)
    .neq('ads_library_url', '')
    .neq('is_active', 'false');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const brands = ((data || []) as Array<Brand & { brand_type?: string | null }>)
    .filter((b) => String(b.brand_type || '') !== 'video_folder' && String(b.ads_library_url || '').trim())
    .slice(0, MAX_STARTS);

  if (!brands.length) {
    return NextResponse.json({ error: 'No competitors with an Ad Library URL to refresh' }, { status: 400 });
  }

  const started: Array<{ brandId: number; name: string; runId: string }> = [];
  const errors: Array<{ brandId: number; name: string; error: string }> = [];

  // Sequential: Apify rate-limits burst starts; 25×~1s still fits maxDuration.
  for (const brand of brands) {
    const res = await startBrandScrape(brand);
    if (res.ok) started.push({ brandId: brand.id, name: brand.name, runId: res.runId });
    else errors.push({ brandId: brand.id, name: brand.name, error: res.error });
  }

  if (!started.length) {
    return NextResponse.json(
      { error: errors[0]?.error || 'No scrapes started', errors },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    started: started.length,
    failed: errors.length,
    runs: started,
    errors,
    message: 'Refresh started. New ads and active/inactive status update as Apify finishes.',
  });
}
