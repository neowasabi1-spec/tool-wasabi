/**
 * Swipe plan — the one document every rewrite batch follows.
 *
 * A swipe keeps the STRUCTURE of a winning page (advertorial by an authority,
 * root cause → mechanism → product → proof → offer) and re-authors it for our
 * product. Rewriting 28 lines at a time with no shared story produced a
 * physical therapist explaining hunger, three different mechanism names and
 * bold fragments that no longer fit their own sentence. The plan is written
 * once, from the whole page, and injected into every batch.
 */
import { requireAnthropicKey } from '@/lib/anthropic-key';
import { wellFormed } from '@/lib/well-formed';

export type SwipePlanInput = {
  productName: string;
  /** Everything we know about our product (brief, research, description). */
  productContext: string;
  /** Page texts in document order (already filtered to visible copy). */
  texts: Array<{ text: string; tag?: string }>;
  /** Output language for the rewrites (e.g. 'en', 'it', 'Italian'). */
  language: string;
  model?: string;
  timeoutMs?: number;
};

/** Compact, ordered outline of the original page for the planner (≈12k chars). */
export function outlinePageTexts(texts: Array<{ text: string; tag?: string }>, maxChars = 12_000): string {
  const lines: string[] = [];
  let used = 0;
  for (const t of texts) {
    const tag = (t.tag || '').replace(/^(tag|mixed):/, '');
    const isHead = /^h[1-4]$|^title$/.test(tag);
    const body = t.text.replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const line = `${isHead ? `[${tag.toUpperCase()}] ` : ''}${body.slice(0, isHead ? 200 : 160)}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * Ask the model for the swipe plan. Returns '' on any failure so callers
 * degrade to the plain per-batch prompt instead of aborting the swipe.
 */
export async function buildSwipePlan(input: SwipePlanInput): Promise<string> {
  const apiKey = requireAnthropicKey();
  const outline = outlinePageTexts(input.texts);
  if (!outline) return '';

  const system = `You are a senior direct-response strategist preparing a SWIPE: a proven landing page is kept as a template (same sections, same persuasion sequence, same energy) and re-authored to sell a DIFFERENT product. Copywriters will then rewrite the page line by line, in parallel batches, following ONLY your plan — so the plan must make every decision once.

Write the plan in English, under 550 words, in exactly these sections:

PAGE: what kind of page this is (advertorial, VSL text, product page, checkout…) and its persuasion sequence in one line.
NARRATOR: who speaks on the NEW page. Must be credible for OUR product (a physical therapist cannot sell a weight-loss jelly; pick the matching authority: dietitian, endocrinologist, nurse, founder, customer…). If the original has a named author, decide the new name/credentials and how to introduce them. If our product context names a real spokesperson, use them.
ROOT CAUSE: the ONE enemy / hidden cause story of the new page, in the copy's own words (2-3 sentences).
MECHANISM NAME: the exact name used everywhere for how our product works (one name, capitalised the same way each time). Take it from the product context when it has one; otherwise coin one and say "coined".
PRODUCT NAMING: the exact product name to use, and how to refer to it on second mention.
PROMISE & BENEFITS: the headline promise, then the mapping old benefit → new benefit (one line each) so parallel lists stay parallel.
PROOF: which numbers/claims from the original are generic enough to keep (shipping, guarantee days), which must become our product's facts, and what testimonials should now say (what changed for the customer).
OFFER: price/packages/guarantee wording — from the product context when known; otherwise keep the original offer MECHANICS and say "keep structure, do not invent numbers".
NEVER CARRY OVER: the old product's vocabulary that must not survive anywhere (body parts, conditions, technologies, brand and model names, units like "device", "mat", "session"…).
LANGUAGE: the output language for all copy.`;

  const user = `OUR PRODUCT: ${input.productName}
OUTPUT LANGUAGE: ${input.language}

PRODUCT CONTEXT (source of truth; never invent medical/legal claims beyond it. If it contains an OFFER PAGE block, that page IS the product: its name, ingredients, mechanism, dosage, price and guarantee override anything else, including the brief):
${wellFormed(input.productContext).slice(0, 40_000) || '(no context — derive from the product name only, flag every assumption)'}

ORIGINAL PAGE, in reading order (each line is one piece of copy; [H1]/[H2]… are headings):
${wellFormed(outline)}

Write the SWIPE PLAN now.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: input.model || 'claude-sonnet-4-6',
        max_tokens: 1800,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(input.timeoutMs || 60_000),
    });
    if (!res.ok) {
      console.warn('[swipe-plan] Anthropic', res.status, (await res.text()).slice(0, 200));
      return '';
    }
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return (data.content?.[0]?.text || '').trim();
  } catch (e) {
    console.warn('[swipe-plan] failed:', (e as Error).message);
    return '';
  }
}

/** Rules appended to every batch prompt when a plan exists. */
export function planRules(plan: string): string {
  if (!plan) return '';
  return `
SWIPE PLAN — decided once for the whole page; every rewrite follows it exactly (same narrator, same mechanism name, same root cause, same product naming). Never reintroduce anything listed under NEVER CARRY OVER:
${plan}

FRAGMENTS: an item with "partOf": <id> is an inline piece (bold, underline, link text) of the paragraph with that id, which is in this same batch. Rewrite the paragraph first, then make the piece's "rewritten" text the exact corresponding piece of that rewritten paragraph — never a standalone sentence of its own.`;
}

/**
 * Sort texts in document order and mark inline fragments with the id of the
 * paragraph that contains them, so paragraph + pieces travel in one batch and
 * the model rewrites them as one unit.
 */
export function orderAndLinkFragments<T extends { id: number; text: string; position?: number }>(
  texts: T[],
): Array<T & { partOf?: number }> {
  const sorted = [...texts].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const out: Array<T & { partOf?: number }> = sorted.map((t) => ({ ...t }));
  // Parent = a longer text that contains this one; prefer the shortest such
  // parent (the immediate paragraph), only for pieces short enough to be inline.
  // A parent must itself read like a paragraph: not a region blob, not code.
  const looksLikeParagraph = (s: string) => s.length <= 1500 && !/[{}<>]|=\s*["'{[]/.test(s);
  for (const item of out) {
    if (item.text.length > 400) continue;
    let best: (T & { partOf?: number }) | null = null;
    for (const other of out) {
      if (other === item || other.text.length <= item.text.length + 8) continue;
      if (!looksLikeParagraph(other.text) || !other.text.includes(item.text)) continue;
      if (!best || other.text.length < best.text.length) best = other;
    }
    if (best) item.partOf = best.id;
  }
  return out;
}

/** Split into batches of ~size, never separating a paragraph from its fragments. */
export function batchKeepingGroups<T extends { id: number; partOf?: number }>(items: T[], size: number): T[][] {
  const byId = new Map(items.map((t) => [t.id, t]));
  const groupOf = (t: T): number => {
    let cur = t;
    for (let hops = 0; cur.partOf != null && hops < 8; hops++) {
      const parent = byId.get(cur.partOf);
      if (!parent || parent === cur) break;
      cur = parent;
    }
    return cur.id;
  };
  const order: number[] = [];
  const groups = new Map<number, T[]>();
  for (const t of items) {
    const g = groupOf(t);
    if (!groups.has(g)) { groups.set(g, []); order.push(g); }
    groups.get(g)!.push(t);
  }
  const batches: T[][] = [];
  let cur: T[] = [];
  for (const g of order) {
    const members = groups.get(g)!;
    if (cur.length && cur.length + members.length > size) { batches.push(cur); cur = []; }
    cur.push(...members);
  }
  if (cur.length) batches.push(cur);
  return batches;
}
