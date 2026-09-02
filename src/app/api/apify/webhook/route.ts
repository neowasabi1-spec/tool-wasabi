import { NextRequest, NextResponse } from 'next/server';
import { ingestDataset, webhookSecret } from '@/lib/competitor-scrape';
import type { AdPlatform } from '@/lib/apify';
import { decodeLexiconParam } from '@/lib/competitor-relevance';
import { loadDiscoveryLexicon, webhookKeyMatches } from '@/lib/discovery-lexicon';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The netlify.toml raises the Next handler ceiling to 300s (Pro), so we can
// afford to download + upload longer video creatives here.
export const maxDuration = 300;

function parsePlatform(v: string | null): AdPlatform {
  return v === 'tiktok' || v === 'google' ? v : 'meta';
}

/**
 * Apify run webhook. Called when a competitor Ad Library run finishes.
 * Context (projectId, platform, optional brandId, secret) travels in the query
 * string; Apify appends the run payload (resource.defaultDatasetId, status).
 *
 * Two ingestion modes:
 *  - brandId present  → legacy per-brand scrape (one competitor's library).
 *  - brandId absent   → DISCOVERY: a keyword search; ingestion creates one
 *                        competitor brand per advertiser found ("per page").
 */
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('p') || url.searchParams.get('projectId') || '';
  const brandId = Number(url.searchParams.get('b') || url.searchParams.get('brandId') || '0');
  const platform = parsePlatform(url.searchParams.get('t') || url.searchParams.get('platform'));
  const provided = url.searchParams.get('k') || url.searchParams.get('secret') || '';

  const expected = webhookSecret();
  if (expected && !webhookKeyMatches(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!projectId) {
    return NextResponse.json({ error: 'Missing context' }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const resource = body?.resource || {};
  const status: string = resource.status || body?.eventType || '';
  const datasetId: string = resource.defaultDatasetId || '';

  // Only ingest successful runs; ack everything else so Apify stops retrying.
  if (status && !/SUCCEEDED/i.test(status)) {
    return NextResponse.json({ ok: true, ignored: status });
  }
  if (!datasetId) {
    return NextResponse.json({ ok: true, ignored: 'no dataset' });
  }

  let includeTerms = decodeLexiconParam(url.searchParams.get('include'));
  let excludeTerms = decodeLexiconParam(url.searchParams.get('exclude'));
  if (!includeTerms.length && !excludeTerms.length) {
    const stored = await loadDiscoveryLexicon(supabaseAdmin, projectId);
    includeTerms = stored.include;
    excludeTerms = stored.exclude;
  }

  const result = await ingestDataset({
    projectId,
    brandId: brandId > 0 ? brandId : undefined,
    datasetId,
    platform,
    includeTerms,
    excludeTerms,
  });
  return NextResponse.json({ ok: true, platform, ...result });
}
