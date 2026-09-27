import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { getAnthropicKey } from '@/lib/anthropic-key';
import { wellFormed, sliceWellFormed } from '@/lib/well-formed';
import { countryFromMarketHint, fbAdLibrarySearchUrl } from '@/lib/ads-library-url';
import { parseDiscoveryLexicon, parseTermList } from '@/lib/competitor-relevance';
import { loadDiscoveryLexicon, saveDiscoveryLexicon, shortApifyWebhookUrl } from '@/lib/discovery-lexicon';
import { apifyConfigured, startAdsLibraryRun } from '@/lib/apify';
import { siteBaseUrl, webhookSecret } from '@/lib/competitor-scrape';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Discover DIRECT competitors: wide Meta keyword SEARCH + async Apify ingest
 * (competitor-judge filters noise in the webhook). Not vertical peers.
 *
 *   POST /api/projecthub/projects/:id/competitor-library/discover-direct
 *   → { country, searchTerms, include, exclude, started: [{ keyword, runId }], errors }
 */

const MODEL = 'claude-sonnet-4-6';
const MAX_TERMS = 6;
/** Ads per keyword — wide enough for affiliates, small enough for library UX. */
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

/** Prefer short 2–3 word phrases — long exact queries often return ~0–1 Meta ads. */
function preferYieldTerms(terms: string[], max = MAX_TERMS): string[] {
  const scored = terms.map((t) => {
    const words = t.trim().split(/\s+/).filter(Boolean).length;
    const len = t.trim().length;
    let score = 0;
    if (words >= 2 && words <= 3) score += 4;
    if (words === 4) score += 1;
    if (words >= 5) score -= 3;
    if (len <= 22) score += 3;
    else if (len <= 30) score += 1;
    else score -= 2;
    return { t: t.trim(), score };
  });
  scored.sort((a, b) => b.score - a.score || a.t.length - b.t.length);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { t } of scored) {
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
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
  const affiliate = product?.affiliate === true;
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

  const kwInstructions = affiliate
    ? wellFormed(`You help find advertisers of THIS SAME offer (affiliates / brand pages), not other products in the category.

Output EXACTLY this format (no extra text):

SEARCH
<8 phrases, one per line>

INCLUDE
<same names, one per line>

EXCLUDE
<leave empty>

CRITICAL RULES:
- First SEARCH lines = bare brand name, then product name, brand+product, spelling variants, "<product> review".
- NEVER category phrases ("slim coffee", "fiber supplement") — those pull OTHER products.
- No competitor brand names.`)
    : wellFormed(`You are a media buyer doing competitor research for the ${country} market.
Goal: surface EVERY advertiser selling the same kind of product as ours — all brands, formats, clones and affiliates. Noise is removed later by a model that reads each ad.

Output EXACTLY this format (no extra text):

SEARCH
<10 phrases, one per line>

INCLUDE
<8-12 short category phrases>

EXCLUDE
<6-10 off-niche traps this search often pulls>

CRITICAL RULES:
- SEARCH phrases MUST be 2-3 words when possible (max 4). Short phrases find more ads than long exact sentences.
- Cover form, mechanism, problem, outcome, buyer nicknames. STYLE: "slim coffee", "caffè dimagrante", "fat burning coffee" — NOT our brand, NOT a single generic word.
- 10 genuinely DIFFERENT searches. Local language of ${country} PLUS English when locals also see English ads.
- INCLUDE = category signals. Never our brand name.
- EXCLUDE = coffee shops, machines, retail, jobs, SaaS, unrelated verticals.
- Do NOT output brand or company names.`);

  const kwUser = wellFormed(
    `Product: ${productName}\nMarket: ${market || country}\n${description ? `Description: ${sliceWellFormed(description, 2000)}\n` : ''}\nGive SEARCH / INCLUDE / EXCLUDE now.`,
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

  let searchTerms: string[];
  let includeTerms: string[];
  let excludeTerms: string[];

  if (affiliate) {
    const rawSearch = parseTermList(
      kwRaw.match(/SEARCH\s*:?\s*\n([\s\S]*?)(?=\n\s*(?:INCLUDE|EXCLUDE)\s*:?\s*\n|$)/i)?.[1] || kwRaw,
    );
    const names = [productName, ...(product?.names || [])].filter(Boolean);
    const merged = [...names, ...rawSearch];
    const seen = new Set<string>();
    searchTerms = [];
    for (const t of merged) {
      const k = t.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      searchTerms.push(t.trim());
      if (searchTerms.length >= MAX_TERMS) break;
    }
    includeTerms = searchTerms.slice();
    excludeTerms = [];
  } else {
    const lex = parseDiscoveryLexicon(kwRaw, productName);
    searchTerms = preferYieldTerms(lex.search, MAX_TERMS);
    includeTerms = lex.include;
    excludeTerms = lex.exclude;
  }

  if (!searchTerms.length) {
    return NextResponse.json({ error: 'No usable SEARCH terms generated' }, { status: 502 });
  }

  const descr = (description || '').trim().slice(0, 900);
  try {
    await saveDiscoveryLexicon(supabaseAdmin, id, includeTerms, excludeTerms, {
      name: productName,
      description: descr,
      market: market || country,
      affiliate,
      hosts: product?.hosts || [],
      offerUrl: product?.offerUrl || undefined,
      names: affiliate ? [productName, ...(product?.names || [])].filter(Boolean) : undefined,
    });
  } catch (e) {
    console.warn('[discover-direct] lexicon save:', (e as Error).message);
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
      { error: errors[0] || 'No Apify runs started', searchTerms, errors },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    country,
    affiliate,
    searchTerms,
    include: includeTerms,
    exclude: excludeTerms,
    started,
    errors,
    message:
      'Discovery started. Ads arrive via Apify webhook; the judge keeps only real direct competitors.',
  });
}
