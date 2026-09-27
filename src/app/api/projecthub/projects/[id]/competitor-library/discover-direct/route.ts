import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { getAnthropicKey } from '@/lib/anthropic-key';
import { wellFormed, sliceWellFormed } from '@/lib/well-formed';
import { countryFromMarketHint, fbAdLibrarySearchUrl } from '@/lib/ads-library-url';
import { parseTermList } from '@/lib/competitor-relevance';
import { loadDiscoveryLexicon, saveDiscoveryLexicon, shortApifyWebhookUrl } from '@/lib/discovery-lexicon';
import { apifyConfigured, startAdsLibraryRun } from '@/lib/apify';
import { siteBaseUrl, webhookSecret } from '@/lib/competitor-scrape';
import { pruneNonSameProductBrands } from '@/lib/competitor-same-product';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Discover SAME-PRODUCT advertisers (brand + affiliates of OUR offer).
 * Adjacent / different products → use "Add vertical peers".
 *
 *   POST /api/projecthub/projects/:id/competitor-library/discover-direct
 */

const MODEL = 'claude-sonnet-4-6';
const MAX_TERMS = 6;
const ADS_PER_TERM = 80;

function briefSnippet(val: unknown, max = 2000): string {
  if (!val) return '';
  if (typeof val === 'string') return sliceWellFormed(val, max);
  try {
    return sliceWellFormed(JSON.stringify(val), max);
  } catch {
    return '';
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!apifyConfigured()) {
    return NextResponse.json({ error: 'Scraping not configured (APIFY_KEY missing)' }, { status: 400 });
  }
  const base = siteBaseUrl();
  if (!base) {
    return NextResponse.json({ error: 'Site base URL not configured' }, { status: 400 });
  }

  const key = getAnthropicKey();
  if (!key) return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured' }, { status: 503 });

  const [{ data: project }, lexicon] = await Promise.all([
    supabaseAdmin
      .from('projects')
      .select('name, description, brief, market_research')
      .eq('id', id)
      .single(),
    loadDiscoveryLexicon(supabaseAdmin, id),
  ]);

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const product = lexicon.product;
  const productName = (product?.name || project.name || '').trim();
  if (!productName) {
    return NextResponse.json({ error: 'Project has no product name' }, { status: 400 });
  }

  const description = [
    product?.description,
    typeof project.description === 'string' ? project.description : '',
    briefSnippet(project.brief, 1500),
    briefSnippet(project.market_research, 800),
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 3500);

  const market = product?.market || '';
  const country = countryFromMarketHint(market, description, productName);
  const offerNames = [productName, ...(product?.names || [])].map((n) => String(n || '').trim()).filter(Boolean);

  const kwInstructions = wellFormed(`You help find advertisers of THIS SAME offer (affiliates / brand pages), not other products in the category.

Output EXACTLY this format (no extra text):

SEARCH
<8 phrases, one per line>

INCLUDE
<same names, one per line>

EXCLUDE
<leave empty>

CRITICAL RULES:
- First SEARCH lines = bare brand name, then product name, brand+product, spelling variants, "<product> review".
- NEVER category phrases ("slim coffee", "fiber supplement", "caffè dimagrante") — those pull OTHER products.
- No competitor brand names.
- Names searched as-is (do not invent unrelated category keywords).`);

  const kwUser = wellFormed(
    `Product: ${productName}\nAlso known as: ${offerNames.join(', ')}\nMarket: ${market || country}\n${description ? `Description: ${sliceWellFormed(description, 2000)}\n` : ''}\nGive SEARCH / INCLUDE / EXCLUDE now.`,
  );

  let kwRaw = '';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: kwInstructions,
        messages: [{ role: 'user', content: kwUser }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 200);
      return NextResponse.json({ error: `lexicon HTTP ${res.status}: ${errText}` }, { status: 502 });
    }
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    kwRaw = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('');
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Lexicon generation failed' },
      { status: 502 },
    );
  }

  const rawSearch = parseTermList(
    kwRaw.match(/SEARCH\s*:?\s*\n([\s\S]*?)(?=\n\s*(?:INCLUDE|EXCLUDE)\s*:?\s*\n|$)/i)?.[1] || kwRaw,
  );
  const merged = [...offerNames, ...rawSearch];
  const seen = new Set<string>();
  const searchTerms: string[] = [];
  for (const t of merged) {
    const k = t.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    searchTerms.push(t.trim());
    if (searchTerms.length >= MAX_TERMS) break;
  }
  const includeTerms = searchTerms.slice();
  const excludeTerms: string[] = [];

  if (!searchTerms.length) {
    return NextResponse.json({ error: 'No usable SEARCH terms generated' }, { status: 502 });
  }

  const descr = (description || '').trim().slice(0, 900);
  const productProfile = {
    name: productName,
    description: descr,
    market: market || country,
    affiliate: true as const,
    hosts: product?.hosts || [],
    offerUrl: product?.offerUrl || undefined,
    names: offerNames,
  };

  try {
    await saveDiscoveryLexicon(supabaseAdmin, id, includeTerms, excludeTerms, productProfile);
  } catch (e) {
    console.warn('[discover-direct] lexicon save:', (e as Error).message);
  }

  // Drop category brands already saved (keep vertical peers / inspiration).
  let pruned = 0;
  try {
    const prune = await pruneNonSameProductBrands(id, productProfile);
    pruned = prune.removed;
  } catch (e) {
    console.warn('[discover-direct] prune:', (e as Error).message);
  }

  const webhookUrl = shortApifyWebhookUrl({
    base,
    projectId: id,
    platform: 'meta',
    secret: webhookSecret(),
  });

  const started: Array<{ keyword: string; runId: string; url: string }> = [];
  const errors: string[] = [];

  await Promise.all(
    searchTerms.map(async (kw) => {
      const metaUrl = fbAdLibrarySearchUrl(kw, country);
      const run = await startAdsLibraryRun({
        adsLibraryUrl: metaUrl,
        count: ADS_PER_TERM,
        webhookUrl,
      });
      if (run.ok) started.push({ keyword: kw, runId: run.runId, url: metaUrl });
      else errors.push(`${kw}: ${run.error}`);
    }),
  );

  if (!started.length) {
    return NextResponse.json(
      { error: errors[0] || 'No Apify runs started', searchTerms, errors, pruned },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    country,
    affiliate: true,
    sameProductOnly: true,
    searchTerms,
    include: includeTerms,
    exclude: excludeTerms,
    started,
    errors,
    pruned,
    message:
      'Same-product discovery started. Other brands in the niche belong under Add vertical peers.',
  });
}
