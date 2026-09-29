import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { loadDiscoveryLexicon } from '@/lib/discovery-lexicon';
import { getAnthropicKey } from '@/lib/anthropic-key';
import { wellFormed, sliceWellFormed } from '@/lib/well-formed';
import { countryFromMarketHint } from '@/lib/ads-library-url';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Suggest same-vertical (non-direct) product/brand names for Apify spy.
 *
 *   POST /api/projecthub/projects/:id/competitor-library/suggest-vertical-peers
 *   → { suggestions: [{ name, why }], country, vertical }
 */

const MODEL = 'claude-sonnet-4-6';
const MAX_SUGGESTIONS = 10;

type Suggestion = { name: string; why: string };
type Vertical = 'mmo_bizopp' | 'cpg_supplement' | 'general';

function briefSnippet(val: unknown, max = 2000): string {
  if (!val) return '';
  if (typeof val === 'string') return sliceWellFormed(val, max);
  try {
    return sliceWellFormed(JSON.stringify(val), max);
  } catch {
    return '';
  }
}

function detectVertical(...parts: Array<string | null | undefined>): Vertical {
  const s = parts.filter(Boolean).join(' \n ').toLowerCase();
  if (
    /social profits|wifi profit|feed flip|make money|\$\d+\/?day|from my phone|phone income|commission flow|biz\s*opp|clickbank|income training|passive income|side hustle system|affiliate info product|get paid from|cash from (your )?phone|try-socialprofits/.test(
      s,
    )
  ) {
    return 'mmo_bizopp';
  }
  if (
    /supplement|probiotic|fat.?burn|weight loss|coffee|collagen|gum|skincare|serum|capsule|gummy|nutra|cbd|nootropic/.test(
      s,
    )
  ) {
    return 'cpg_supplement';
  }
  return 'general';
}

function systemForVertical(vertical: Vertical): string {
  if (vertical === 'mmo_bizopp') {
    return wellFormed(`You help a media buyer expand Facebook Ad Library spy for MAKE-MONEY / BIZ-OPP info products.

OUR OFFER is a paid "system" / training / dashboard sold via VSL or advertorial (phone income, commissions, Feed Flip style). Direct clones of THIS exact offer are already covered or scarce.

Suggest OTHER real Meta-advertised info products / front-end brand names in the SAME buyer intent:
- "make money from your phone", auto commission machines, WiFi/phone income systems, similar ClickBank-style frontends.
Good kind of peer: WiFi Profit, other phone-income / social-profits style machines, similar "$X/day from phone" trainings.
Bad (never suggest):
- WiFi routers, ISPs, hardware, VPN, mobile carriers
- Meta Ads Manager, Canva, CapCut, Shopify, LinkedIn, TikTok Shop as SaaS tools
- generic words ("side hustle", "passive income") with no product brand
- our own offer name or spelling variants (Social Profits Machine, SPM, try-socialprofits)

Return STRICT JSON only:
{"suggestions":[{"name":"Product or Brand Name","why":"<=12 words"}]}
Give 8–10 distinct, searchable advertiser names (2–4 words). Prefer names people actually type into Meta Ad Library.`);
  }
  if (vertical === 'cpg_supplement') {
    return wellFormed(`You help a media buyer expand Facebook Ad Library spy coverage.

OUR PRODUCT is a consumer supplement / nutra / beauty SKU. Direct competitors (same offer / same brand / clones) are already covered or scarce.
Suggest OTHER real consumer products or brand names in the SAME VERTICAL — same category and buyer problem, but a DIFFERENT product/brand.

Good: rival brands and adjacent SKUs (e.g. another fat-burner coffee when we sell slim coffee; another probiotic gum when we sell ProDentim).
Bad: our brand/product name, spelling variants, marketplaces, agencies, SaaS, generic category words.

Return STRICT JSON only:
{"suggestions":[{"name":"Product or Brand Name","why":"<=12 words"}]}
Give 8–10 distinct, searchable names (2–4 words). Prefer names advertisers put in Meta ads.`);
  }
  return wellFormed(`You help a media buyer expand Facebook Ad Library spy coverage.

OUR PRODUCT is known. Direct competitors (same offer / same brand / clones of THIS product) are already covered or scarce.
Suggest OTHER real products or brand names in the SAME VERTICAL — same category and buyer problem, but a DIFFERENT product/brand (not our offer).

Match the product type carefully (info product vs physical good vs SaaS). Do not cross verticals.
Bad: our brand/product name, spelling variants, marketplaces, agencies, generic category words.

Return STRICT JSON only:
{"suggestions":[{"name":"Product or Brand Name","why":"<=12 words"}]}
Give 8–10 distinct, searchable names (2–4 words). Prefer names advertisers put in Meta ads.`);
}

function parseSuggestions(raw: string, exclude: Set<string>): Suggestion[] {
  let c = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const a = c.indexOf('{');
  const b = c.lastIndexOf('}');
  if (a >= 0 && b > a) c = c.slice(a, b + 1);
  const obj = JSON.parse(c) as { suggestions?: Array<Record<string, unknown>> };
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const s of obj.suggestions || []) {
    const name = String(s.name || '').trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2 || name.length > 80) continue;
    const key = name.toLowerCase();
    if (seen.has(key) || exclude.has(key)) continue;
    seen.add(key);
    out.push({ name, why: String(s.why || '').trim().slice(0, 120) });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const key = getAnthropicKey();
  if (!key) return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured' }, { status: 503 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const offerHint = typeof body.offerUrl === 'string' ? body.offerUrl.trim() : '';

  const [{ data: project }, { data: brands }, lexicon] = await Promise.all([
    supabaseAdmin
      .from('projects')
      .select('name, description, brief, market_research')
      .eq('id', id)
      .single(),
    supabaseAdmin.from('competitor_brands').select('name').eq('project_id', id),
    loadDiscoveryLexicon(supabaseAdmin, id),
  ]);

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const product = lexicon.product;
  const productName = (product?.name || project.name || '').trim();
  const offerUrl = (product?.offerUrl || offerHint || '').trim();
  const description = [
    product?.description,
    typeof project.description === 'string' ? project.description : '',
    briefSnippet(project.brief, 1500),
    briefSnippet(project.market_research, 800),
    offerUrl ? `Offer URL: ${offerUrl}` : '',
    /try-socialprofits|socialprofits|social profits machine/i.test(
      `${productName} ${offerUrl} ${briefSnippet(project.brief, 400)}`,
    )
      ? 'Vertical lock: make-money-from-phone info product / Social Profits Machine (MMO bizopp). Peers = other phone-income / commission-machine frontends (e.g. WiFi Profit), NOT hardware WiFi, NOT SaaS tools.'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 3800);

  const market = product?.market || '';
  const country = countryFromMarketHint(market, description, productName);
  const vertical = detectVertical(productName, description, offerUrl, ...(product?.names || []));

  const existing = new Set(
    ((brands || []) as { name?: string }[])
      .map((b) => String(b.name || '').trim().toLowerCase())
      .filter(Boolean),
  );
  for (const n of [productName, ...(product?.names || []), 'Social Profits Machine', 'SPM', 'try-socialprofits']) {
    const k = String(n || '').trim().toLowerCase();
    if (k) existing.add(k);
  }

  const user = wellFormed(
    JSON.stringify({
      our_product: productName || 'unknown',
      also_known_as: product?.names || [],
      offer_url: offerUrl || null,
      offer_hosts: product?.hosts || [],
      market: market || country,
      vertical,
      affiliate: product?.affiliate === true,
      description: sliceWellFormed(description, 3200),
      already_monitored: [...existing].slice(0, 40),
    }),
  );

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: systemForVertical(vertical),
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 200);
      return NextResponse.json({ error: `suggest HTTP ${res.status}: ${errText}` }, { status: 502 });
    }
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('');
    const suggestions = parseSuggestions(text, existing);
    return NextResponse.json({ suggestions, country, vertical });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Suggest failed' },
      { status: 502 },
    );
  }
}
