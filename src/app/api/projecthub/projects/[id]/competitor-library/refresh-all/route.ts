import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { apifyConfigured } from '@/lib/apify';
import { startBrandScrape, type Brand } from '@/lib/competitor-scrape';
import { fbAdLibrarySearchUrl, countryFromMarketHint } from '@/lib/ads-library-url';
import { loadDiscoveryLexicon } from '@/lib/discovery-lexicon';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_STARTS = 25;

/** Strip platform tags added at discovery ingest: "Brand (Meta)". */
function searchNameFromBrand(name: string): string {
  return String(name || '')
    .replace(/\s*\((Meta|TikTok|Google)\)\s*$/i, '')
    .trim();
}

/**
 * Force-refresh every monitored competitor page in this project
 * (new creatives + active/inactive status via Apify webhook ingest).
 *
 * Brands discovered without an Ad Library URL get one synthesized from the
 * page name so Refresh all still works.
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

  const [{ data, error }, lexicon, { data: project }] = await Promise.all([
    supabaseAdmin
      .from('competitor_brands')
      .select('id, project_id, name, ads_library_url, frequency, scrape_count, is_active, last_scraped, brand_type')
      .eq('project_id', id)
      .neq('is_active', 'false'),
    loadDiscoveryLexicon(supabaseAdmin, id),
    supabaseAdmin.from('projects').select('name, description').eq('id', id).maybeSingle(),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const country = countryFromMarketHint(
    lexicon.product?.market,
    project?.description,
    lexicon.product?.name || project?.name,
  );

  const candidates = ((data || []) as Array<Brand & { brand_type?: string | null }>)
    .filter((b) => String(b.brand_type || '') !== 'video_folder')
    .slice(0, MAX_STARTS);

  if (!candidates.length) {
    return NextResponse.json({ error: 'No competitors to refresh' }, { status: 400 });
  }

  const brands: Brand[] = [];
  for (const b of candidates) {
    let url = String(b.ads_library_url || '').trim();
    if (!url) {
      const q = searchNameFromBrand(b.name);
      if (!q) continue;
      url = fbAdLibrarySearchUrl(q, country);
      await supabaseAdmin
        .from('competitor_brands')
        .update({ ads_library_url: url })
        .eq('id', b.id)
        .eq('project_id', id);
    }
    brands.push({ ...b, ads_library_url: url });
  }

  if (!brands.length) {
    return NextResponse.json({ error: 'No competitors with a usable name/URL to refresh' }, { status: 400 });
  }

  const started: Array<{ brandId: number; name: string; runId: string }> = [];
  const errors: Array<{ brandId: number; name: string; error: string }> = [];

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
