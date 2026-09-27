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
 *   → { suggestions: [{ name, why }], country: "IT" }
 */

const MODEL = 'claude-sonnet-4-6';
const MAX_SUGGESTIONS = 10;

type Suggestion = { name: string; why: string };

function briefSnippet(val: unknown, max = 2000): string {
  if (!val) return '';
  if (typeof val === 'string') return sliceWellFormed(val, max);
  try {
    return sliceWellFormed(JSON.stringify(val), max);
  } catch {
    return '';
  }
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

  const existing = new Set(
    ((brands || []) as { name?: string }[])
      .map((b) => String(b.name || '').trim().toLowerCase())
      .filter(Boolean),
  );
  // Also exclude our own product / offer names so Claude does not suggest them.
  for (const n of [productName, ...(product?.names || [])]) {
    const k = String(n || '').trim().toLowerCase();
    if (k) existing.add(k);
  }

  const system = wellFormed(`You help a media buyer expand Facebook Ad Library spy coverage.

OUR PRODUCT is known. Direct competitors (same offer / same brand / clones of THIS product) are already covered or scarce.
Suggest OTHER real consumer products or brand names in the SAME VERTICAL — same category and buyer problem, but a DIFFERENT product/brand (not our offer, not the same SKU under another affiliate name).

Good: rival brands and adjacent SKUs a buyer might also consider (e.g. another fat-burner coffee brand when we sell a slim coffee; another probiotic gum when we sell ProDentim).
Bad: our brand/product name, spelling variants of our offer, marketplaces, agencies, SaaS tools, generic category words with no brand/product ("supplement", "weight loss").

Return STRICT JSON only:
{"suggestions":[{"name":"Product or Brand Name","why":"<=12 words"}]}
Give 8–10 distinct, searchable names (2–4 words when possible). Prefer names advertisers actually put in Meta ads.`);

  const user = wellFormed(
    JSON.stringify({
      our_product: productName || 'unknown',
      market: market || country,
      description: sliceWellFormed(description, 3000),
      already_monitored: [...existing].slice(0, 40),
      affiliate: product?.affiliate === true,
    }),
  );

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system,
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
    return NextResponse.json({ suggestions, country });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Suggest failed' },
      { status: 502 },
    );
  }
}
