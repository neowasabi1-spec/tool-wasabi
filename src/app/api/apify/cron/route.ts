import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { apifyConfigured } from '@/lib/apify';
import { isBrandDue, startBrandScrape, webhookSecret, type Brand } from '@/lib/competitor-scrape';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_STARTS_PER_RUN = 25;

/**
 * Enumerate competitor brands whose scrape is due and start an Apify run for
 * each. Invoked by the daily Netlify scheduled function (and can be hit
 * manually with ?secret=...). Runs report back to /api/apify/webhook.
 */
async function handle(req: NextRequest) {
  const url = new URL(req.url);
  const provided = url.searchParams.get('secret') || req.headers.get('x-cron-secret') || '';
  const expected = webhookSecret();
  if (expected && provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!apifyConfigured()) {
    return NextResponse.json({ error: 'APIFY_KEY not configured' }, { status: 500 });
  }

  const { data, error } = await supabaseAdmin
    .from('competitor_brands')
    .select('id, project_id, name, ads_library_url, frequency, scrape_count, is_active, last_scraped')
    .neq('ads_library_url', '')
    .neq('is_active', 'false');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const due = (data as Brand[]).filter(isBrandDue).slice(0, MAX_STARTS_PER_RUN);
  const started: { brandId: number; runId?: string; error?: string }[] = [];

  for (const brand of due) {
    const res = await startBrandScrape(brand);
    started.push(res.ok ? { brandId: brand.id, runId: res.runId } : { brandId: brand.id, error: res.error });
  }

  return NextResponse.json({ ok: true, due: due.length, started });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
