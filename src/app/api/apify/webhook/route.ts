import { NextRequest, NextResponse } from 'next/server';
import { ingestDataset, webhookSecret } from '@/lib/competitor-scrape';
import type { AdPlatform } from '@/lib/apify';
import { decodeLexiconParam } from '@/lib/competitor-relevance';
import type { ProductProfile } from '@/lib/competitor-judge';
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

/** Older projects have no stored profile: describe the product from the project row. */
async function productFromProject(projectId: string): Promise<ProductProfile | null> {
  try {
    const { data } = await supabaseAdmin
      .from('projects')
      .select('name, description, brief')
      .eq('id', projectId)
      .maybeSingle();
    const row = (data || {}) as { name?: string; description?: string | null; brief?: unknown };
    const name = String(row.name || '').trim();
    if (!name) return null;
    const brief = typeof row.brief === 'string' ? row.brief : '';
    const description = String(row.description || '').trim() || brief.replace(/\s+/g, ' ').slice(0, 900);
    return { name, description };
  } catch {
    return null;
  }
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

  // Netlify caps synchronous routes at 60s (hard, every plan) — far less than a deep
  // dataset needs. Hand the payload to the background function (15 min) and
  // ack Apify at once. Kept for runs registered with the old webhook URL.
  const base = (process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/$/, '');
  if (base && !url.searchParams.get('direct')) {
    const rawBody = await req.text().catch(() => '');
    const target = `${base}/.netlify/functions/apify-ingest-background?${url.searchParams.toString()}`;
    try {
      const resp = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody, signal: AbortSignal.timeout(8_000) });
      return NextResponse.json({ ok: true, forwarded: resp.status });
    } catch (e) {
      console.warn('[apify/webhook] forward failed, ingesting inline:', (e as Error).message);
      req = new NextRequest(req.url, { method: 'POST', headers: req.headers, body: rawBody });
    }
  }
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
  let product: ProductProfile | null = null;
  let collectMedia = true;
  if (brandId <= 0) {
    const stored = await loadDiscoveryLexicon(supabaseAdmin, projectId);
    if (!includeTerms.length && !excludeTerms.length) {
      includeTerms = stored.include;
      excludeTerms = stored.exclude;
    }
    product = stored.product || (await productFromProject(projectId));
    // Affiliate runs: the library is the promoted offer's photos only.
    collectMedia = !stored.product?.affiliate;
  }

  const result = await ingestDataset({
    projectId,
    brandId: brandId > 0 ? brandId : undefined,
    datasetId,
    platform,
    product,
    includeTerms,
    excludeTerms,
    collectMedia,
  });
  return NextResponse.json({ ok: true, platform, ...result });
}
