/**
 * Apify run webhook → competitor ingestion, as a BACKGROUND function.
 *
 * Why not the Next route (/api/apify/webhook)? Netlify caps synchronous
 * functions at 60s on every plan (not configurable — `maxDuration`/toml
 * timeout are ignored, see docs.netlify.com/build/functions/configuration). Judging a
 * dataset of 400 ads (landing fetch + model + downloads) takes minutes, so
 * every deep search was dying before writing a single brand — the library
 * showed only the 2–4 advertisers from tiny datasets. Background functions
 * get 15 minutes and return 202 immediately (Apify is happy with that).
 *
 * Context (projectId, platform, optional brandId, secret) travels in the
 * query string; Apify posts the run payload (resource.defaultDatasetId).
 */
import type { Context } from '@netlify/functions';
import { ingestDataset, webhookSecret } from '../../src/lib/competitor-scrape';
import type { AdPlatform } from '../../src/lib/apify';
import type { ProductProfile } from '../../src/lib/competitor-judge';
import { decodeLexiconParam } from '../../src/lib/competitor-relevance';
import { loadDiscoveryLexicon, webhookKeyMatches } from '../../src/lib/discovery-lexicon';
import { supabaseAdmin } from '../../src/lib/supabase-admin';

function parsePlatform(v: string | null): AdPlatform {
  return v === 'tiktok' || v === 'google' ? v : 'meta';
}

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

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('p') || url.searchParams.get('projectId') || '';
  const brandId = Number(url.searchParams.get('b') || url.searchParams.get('brandId') || '0');
  const platform = parsePlatform(url.searchParams.get('t') || url.searchParams.get('platform'));
  const provided = url.searchParams.get('k') || url.searchParams.get('secret') || '';

  const expected = webhookSecret();
  if (expected && !webhookKeyMatches(provided, expected)) {
    console.warn('[apify-ingest] unauthorized webhook');
    return;
  }
  if (!projectId) { console.warn('[apify-ingest] missing project'); return; }

  const body = await req.json().catch(() => null) as { resource?: { status?: string; defaultDatasetId?: string }; eventType?: string } | null;
  const resource = body?.resource || {};
  const status: string = resource.status || body?.eventType || '';
  const datasetId: string = resource.defaultDatasetId || '';
  if (status && !/SUCCEEDED/i.test(status)) { console.log(`[apify-ingest] ${platform} run ${status}: ignored`); return; }
  if (!datasetId) { console.log('[apify-ingest] no dataset id'); return; }

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
    collectMedia = !stored.product?.affiliate;
  }

  const started = Date.now();
  try {
    const result = await ingestDataset({
      projectId,
      brandId: brandId > 0 ? brandId : undefined,
      datasetId,
      platform,
      product,
      includeTerms,
      excludeTerms,
      collectMedia,
      budgetMs: 13 * 60_000,
    });
    console.log(`[apify-ingest] ${platform} dataset ${datasetId}: ${JSON.stringify(result)} in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (e) {
    console.error(`[apify-ingest] ${platform} dataset ${datasetId} failed:`, (e as Error).message);
  }
};
