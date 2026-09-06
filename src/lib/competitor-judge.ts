/**
 * Server-only. Decides which advertisers found by a keyword search are real
 * competitors of OUR product. The model reads each advertiser's ad copy and
 * landing host and answers per advertiser — no keyword lists, no host regex.
 *
 * Wide search + model judgement is what lets discovery cast a broad net
 * without dragging in coffee shops, SaaS and marketplaces.
 */
import { getAnthropicKey } from '@/lib/anthropic-key';

export type ProductProfile = {
  name: string;
  description?: string;
  market?: string;
};

export type AdvertiserCard = {
  id: string;
  name: string;
  /** Up to a few ad texts (headline / hook / body) — the model reads these. */
  samples: string[];
  landingHost?: string;
};

export type Verdict = { id: string; competitor: boolean; why: string };

const MODEL = 'claude-sonnet-4-6';
const BATCH = 40;

export async function judgeAdvertisers(
  product: ProductProfile,
  cards: AdvertiserCard[],
): Promise<Map<string, Verdict>> {
  const out = new Map<string, Verdict>();
  if (!cards.length) return out;
  const key = getAnthropicKey();
  if (!key) throw new Error('ANTHROPIC_API_KEY is not configured');

  const batches: AdvertiserCard[][] = [];
  for (let i = 0; i < cards.length; i += BATCH) batches.push(cards.slice(i, i + BATCH));

  const results = await Promise.all(batches.map((b) => judgeBatch(key, product, b)));
  for (const r of results) for (const v of r) out.set(v.id, v);
  return out;
}

async function judgeBatch(key: string, product: ProductProfile, cards: AdvertiserCard[]): Promise<Verdict[]> {
  const system = `You are a media buyer building the competitor set for OUR product.

OUR PRODUCT: ${product.name}
${product.description ? `WHAT IT IS: ${product.description.slice(0, 900)}\n` : ''}${product.market ? `MARKET: ${product.market}\n` : ''}
You get a list of advertisers found by keyword search on ad libraries, each with samples of their ad copy and their landing domain.

An advertiser is a COMPETITOR when a person about to buy our product could buy theirs instead: same kind of product, solving the same problem for the same buyer — including different brands, different formats of the same solution, and clones/affiliates of it. Keep them even if their copy uses other words than ours.

NOT a competitor: shops or marketplaces selling everything, tools/SaaS/agencies/courses, jobs, media/news, charities, unrelated categories that merely share a keyword (e.g. a coffee machine when we sell a slimming coffee; a gym when we sell a supplement), and ads with no readable offer at all.

Judge from what the copy actually sells. When the copy is empty or unreadable, say competitor=false.

Return STRICT JSON only:
{"advertisers":[{"id":"...","competitor":true,"why":"<=12 words"}]}
One object per input id.`;

  const user = JSON.stringify(
    cards.map((c) => ({
      id: c.id,
      name: c.name.slice(0, 80),
      landing: c.landingHost || '',
      ads: c.samples.slice(0, 4).map((s) => s.slice(0, 260)),
    })),
  );

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 3000, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('');
  return parseVerdicts(text, cards);
}

function parseVerdicts(raw: string, cards: AdvertiserCard[]): Verdict[] {
  let c = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const a = c.indexOf('{');
  const b = c.lastIndexOf('}');
  if (a >= 0 && b > a) c = c.slice(a, b + 1);
  const obj = JSON.parse(c) as { advertisers?: Array<Record<string, unknown>> };
  const ids = new Set(cards.map((x) => x.id));
  const out: Verdict[] = [];
  for (const v of obj.advertisers || []) {
    const id = String(v.id ?? '');
    if (!ids.has(id)) continue;
    out.push({ id, competitor: v.competitor === true, why: String(v.why || '').slice(0, 120) });
  }
  return out;
}

export function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}
