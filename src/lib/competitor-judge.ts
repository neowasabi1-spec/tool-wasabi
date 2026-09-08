/**
 * Server-only. Decides which advertisers found by a keyword search are real
 * competitors of OUR product. The model reads each advertiser's ad copy and
 * landing host and answers per advertiser — no keyword lists, no host regex.
 *
 * Wide search + model judgement is what lets discovery cast a broad net
 * without dragging in coffee shops, SaaS and marketplaces.
 */
import { getAnthropicKey } from '@/lib/anthropic-key';
import { sliceWellFormed, wellFormed } from '@/lib/well-formed';

export type ProductProfile = {
  name: string;
  description?: string;
  market?: string;
  /** Affiliate: we promote an existing offer. A competitor is then anyone
   *  running THAT SAME product (brand + other affiliates), not the category. */
  affiliate?: boolean;
  /** Affiliate: domains the offer lives on; ads landing there are the product. */
  hosts?: string[];
  /** Affiliate: the names the offer goes by (brand, product, advertorial title). */
  names?: string[];
};

export type AdvertiserCard = {
  id: string;
  name: string;
  /** Up to a few ad texts (headline / hook / body) — the model reads these. */
  samples: string[];
  landingHost?: string;
  /** Readable excerpt of the advertiser's landing page (title, h1, first copy). */
  landingText?: string;
  /** Outbound hosts the landing page links to (affiliate pre-landers link to the offer). */
  landingLinks?: string[];
};

const normHost = (h: string) => h.toLowerCase().replace(/^www\./, '');

/** Names worth matching literally: 4+ chars, not a generic word. */
function matchableNames(product: ProductProfile): string[] {
  const names = [product.name, ...(product.names || [])].map((n) => String(n || '').trim()).filter((n) => n.length >= 4);
  return [...new Set(names.map((n) => n.toLowerCase()))];
}

/** Does the text name the product? Case/spacing/hyphen-insensitive ("JellyStick" = "Jelly Stick"). */
export function mentionsProduct(text: string, names: string[]): string {
  const hay = text.toLowerCase().replace(/[\s\-_.]+/g, '');
  for (const n of names) {
    const needle = n.replace(/[\s\-_.]+/g, '');
    if (needle.length >= 4 && hay.includes(needle)) return n;
  }
  return '';
}

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

  // Affiliate: domain evidence needs no model call — the ad lands on the
  // offer's own domain, or its pre-lander links out to it. A NAME match is
  // only a hint for the model (the product name may be a generic phrase that
  // other brands use too), never a verdict on its own.
  const hosts = new Set((product.hosts || []).map(normHost).filter(Boolean));
  const pending: AdvertiserCard[] = [];
  for (const c of cards) {
    if (!product.affiliate) { pending.push(c); continue; }
    const lh = normHost(c.landingHost || '');
    const linksToOffer = (c.landingLinks || []).map(normHost).some((h) => hosts.has(h));
    if (lh && hosts.has(lh)) out.set(c.id, { id: c.id, competitor: true, why: 'lands on the offer domain' });
    else if (linksToOffer) out.set(c.id, { id: c.id, competitor: true, why: 'pre-lander links to the offer domain' });
    else pending.push(c);
  }
  if (!pending.length) return out;

  const batches: AdvertiserCard[][] = [];
  for (let i = 0; i < pending.length; i += BATCH) batches.push(pending.slice(i, i + BATCH));

  // One failing batch must not throw away the verdicts of the others: cards
  // the model never answered for are simply absent and the caller falls back.
  const results = await Promise.allSettled(batches.map((b) => judgeBatch(key, product, b)));
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') for (const v of r.value) out.set(v.id, v);
    else { failed++; console.warn('[competitor-judge] batch failed:', (r.reason as Error)?.message); }
  }
  if (failed && failed === results.length) throw new Error('every judge batch failed');
  return out;
}

async function judgeBatch(key: string, product: ProductProfile, cards: AdvertiserCard[]): Promise<Verdict[]> {
  const head = `OUR PRODUCT: ${product.name}
${product.description ? `WHAT IT IS: ${product.description.slice(0, 1200)}\n` : ''}${product.market ? `MARKET: ${product.market}\n` : ''}${product.hosts?.length ? `OFFER DOMAINS: ${product.hosts.join(', ')}\n` : ''}${product.names?.length ? `NAMES THE OFFER GOES BY: ${product.names.join(', ')}\n` : ''}
You get a list of advertisers found by keyword search on ad libraries, each with samples of their ad copy, their landing domain and (when we could fetch it) an excerpt of the landing page they send clicks to.`;

  const system = product.affiliate
    ? `You are a media buyer working as an AFFILIATE: we promote an existing offer, and we want every advertiser running THAT SAME product — the brand itself and the other affiliates — to study their ads.

${head}

An advertiser is a COMPETITOR only when it sells EXACTLY this product: the same product/brand name (any spelling, spacing, casing or translation of it), a nickname clearly used for it, or a landing on one of the offer domains. Other affiliates' pre-landers and advertorials for this product count — affiliates often keep the brand out of the AD and name it only on the LANDING PAGE, so read the landing excerpt as carefully as the ad copy.

NOT a competitor: a different product, even the same kind (another product of the same format, another brand with the same promise), shops/marketplaces, tools, media, unrelated categories, and ads with no readable offer.

Decide from the product actually named or shown in the copy or on the landing page. If neither identifies this specific product, say competitor=false.

Return STRICT JSON only:
{"advertisers":[{"id":"...","competitor":true,"why":"<=12 words"}]}
One object per input id.`
    : `You are a media buyer building the competitor set for OUR product.

${head}

An advertiser is a COMPETITOR when a person about to buy our product could buy theirs instead: same kind of product, solving the same problem for the same buyer — including different brands, different formats of the same solution, and clones/affiliates of it. Keep them even if their copy uses other words than ours.

NOT a competitor: shops or marketplaces selling everything, tools/SaaS/agencies/courses, jobs, media/news, charities, unrelated categories that merely share a keyword (e.g. a coffee machine when we sell a slimming coffee; a gym when we sell a supplement), and ads with no readable offer at all.

Judge from what the copy — and the landing page excerpt, when present — actually sells. When both are empty or unreadable, say competitor=false.

Return STRICT JSON only:
{"advertisers":[{"id":"...","competitor":true,"why":"<=12 words"}]}
One object per input id.`;

  const names = matchableNames(product);
  const user = JSON.stringify(
    cards.map((c) => {
      const named = product.affiliate ? mentionsProduct(`${c.samples.join(' ')} ${c.landingText || ''}`, names) : '';
      return {
        id: c.id,
        name: sliceWellFormed(c.name, 80),
        landing: c.landingHost || '',
        ads: c.samples.slice(0, 4).map((s) => sliceWellFormed(s, 260)),
        ...(c.landingText ? { landing_page: sliceWellFormed(c.landingText, 600) } : {}),
        ...(named ? { mentions_our_name: named } : {}),
      };
    }),
  );

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 3000, system: wellFormed(system), messages: [{ role: 'user', content: wellFormed(user) }] }),
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
