import { NextRequest, NextResponse } from 'next/server';
import { extractAllTextsUniversal } from '@/lib/universal-text-extractor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/landing/swipe/openclaw-build-prompts
 *
 * "Light first half" of /api/landing/swipe for the worker-driven path.
 * The OpenClaw worker (Neo / Morfeo) calls this with the page HTML it
 * already has (either provided by the UI from a previous clone, or
 * fetched locally), and we return:
 *   • textsForAi  — the deduped/capped extraction
 *   • systemPrompt — the full direct-response copywriter prompt
 *   • userMessage  — formatted EXACTLY in the markers
 *                    `Testi da riscrivere (JSON):` … `Riscrivi …`
 *                    that the worker's existing `runRewriteInBatches`
 *                    auto-detects and batches against the local LLM
 *
 * The actual LLM rewrite happens on the worker side. We come back at
 * /openclaw-finalize to merge the rewrites into the final HTML.
 *
 * Why split:
 *   Same reason as the checkpoint flow: keep the slow + variable parts
 *   (LLM inference) on the worker (no Netlify timeout, free local
 *   compute) and the deterministic CPU parts on Netlify (fast, well-
 *   tested pipeline). Total of TWO Netlify round-trips per swipe and
 *   each is < 2s by design.
 *
 * Body:
 *   {
 *     html: string,                      // page HTML (worker fetched it)
 *     sourceUrl?: string,                // for absolute-URL rewrites + audit
 *     product: ProductInfo,              // see below
 *     tone?: 'professional'|'friendly'|'urgent'|'luxury',
 *     language?: 'it'|'en'|...,
 *   }
 *
 * Returns:
 *   {
 *     systemPrompt, userMessage,         // ready-to-call by the worker
 *     texts: [{ id, original, tag, position }],   // for finalize merge
 *     productName, originalTitle,
 *     batchSize: number,                 // hint for worker (not enforced)
 *     totalTexts: number,
 *   }
 */

interface ProductInfo {
  name: string;
  description?: string;
  benefits?: string[];
  target_audience?: string;
  price?: string;
  cta_text?: string;
  cta_url?: string;
  brand_name?: string;
  social_proof?: string;
  sku?: string | null;
  category?: string | null;
  characteristics?: string[] | null;
  geo_market?: string | null;
  supplier?: string | null;
  marketing_brief?: string;
  additional_marketing_notes?: string;
  project_brief?: string;
  market_research?: string;
}

interface ExtractedText {
  original: string;
  tag: string;
  position: number;
}

const SAFE_TAG_CONTEXT = new Set(['title', 'meta:content']);
const SAFE_TAG_PREFIXES = [
  'tag:h1', 'tag:h2', 'tag:h3', 'tag:h4', 'tag:h5', 'tag:h6',
  'tag:p', 'tag:li', 'tag:td', 'tag:th', 'tag:dt', 'tag:dd',
  'tag:button', 'tag:a', 'tag:label', 'tag:figcaption',
  'tag:blockquote', 'tag:summary', 'tag:legend', 'tag:option',
  'tag:span', 'tag:strong', 'tag:em', 'tag:b', 'tag:i', 'tag:u',
  'tag:small', 'tag:mark', 'tag:cite', 'tag:q', 'tag:abbr',
  'mixed:p', 'mixed:div', 'mixed:li', 'mixed:td', 'mixed:th',
  'mixed:h1', 'mixed:h2', 'mixed:h3', 'mixed:h4', 'mixed:h5', 'mixed:h6',
  'mixed:span', 'mixed:strong', 'mixed:em', 'mixed:a', 'mixed:b', 'mixed:i',
  'attr:alt', 'attr:title', 'attr:placeholder', 'attr:aria-label', 'attr:value',
];

function isSafeContext(ctx: string): boolean {
  if (SAFE_TAG_CONTEXT.has(ctx)) return true;
  return SAFE_TAG_PREFIXES.some((p) => ctx === p || ctx.startsWith(p + ':'));
}

const MAX_TEXTS_FOR_AI = Math.max(
  50,
  Math.min(800, Number.parseInt(process.env.SWIPE_MAX_TEXTS_FOR_AI || '350', 10) || 350),
);

const TAG_PRIORITY: Record<string, number> = {
  title: 0,
  h1: 1, h2: 1, h3: 2, h4: 3, h5: 4, h6: 4,
  p: 2, li: 2, button: 1, a: 3, label: 3,
  td: 4, th: 4, dt: 4, dd: 4, blockquote: 4, summary: 4, legend: 4, figcaption: 4,
  option: 5, span: 6, strong: 6, em: 6, b: 6, i: 6, u: 6,
  small: 6, mark: 6, cite: 6, q: 6, abbr: 6,
  div: 7,
  'attr:alt': 5, 'attr:title': 5, 'attr:placeholder': 5,
  'attr:aria-label': 5, 'attr:value': 5,
  'attr:meta-content': 5,
};
function priorityOf(tag: string): number {
  if (TAG_PRIORITY[tag] !== undefined) return TAG_PRIORITY[tag];
  if (tag.startsWith('attr:')) return 5;
  return 8;
}

function extractTextsFromHtml(html: string): ExtractedText[] {
  const universal = extractAllTextsUniversal(html);
  const collected: ExtractedText[] = [];
  const seen = new Map<string, ExtractedText>();
  for (const u of universal) {
    if (!isSafeContext(u.context)) continue;
    if (u.text.length < 2 || u.text.length > 800) continue;
    if (!/[a-zA-Z]/.test(u.text)) continue;
    if (u.text.startsWith('http://') || u.text.startsWith('https://')) continue;
    if (u.text.includes('{') && u.text.includes('}') && /[=:]\s*function|=>/.test(u.text)) continue;

    let mappedTag = u.context;
    if (u.context.startsWith('attr:')) mappedTag = u.context;
    else if (u.context.startsWith('tag:')) mappedTag = u.context.slice(4);
    else if (u.context.startsWith('mixed:')) mappedTag = u.context.slice(6);
    else if (u.context === 'title') mappedTag = 'title';
    else if (u.context === 'meta:content') mappedTag = 'attr:meta-content';

    const existing = seen.get(u.text);
    const newPrio = priorityOf(mappedTag);
    if (existing) {
      if (newPrio < priorityOf(existing.tag)) {
        existing.tag = mappedTag;
        existing.position = u.position;
      }
      continue;
    }
    const entry: ExtractedText = { original: u.text, tag: mappedTag, position: u.position };
    seen.set(u.text, entry);
    collected.push(entry);
  }

  if (collected.length > MAX_TEXTS_FOR_AI) {
    collected.sort((a, b) => priorityOf(a.tag) - priorityOf(b.tag));
    return collected.slice(0, MAX_TEXTS_FOR_AI);
  }
  return collected;
}

function prependDocumentTitle(texts: ExtractedText[], html: string): ExtractedText[] {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const raw = titleMatch?.[1]
    ?.replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw || raw.length < 3 || !/[a-zA-Z]/.test(raw)) return texts;
  const seen = new Set(texts.map((t) => t.original));
  if (seen.has(raw)) return texts;
  const minPos = texts.length ? Math.min(...texts.map((t) => t.position)) : 0;
  return [{ original: raw, tag: 'title', position: minPos - 1 }, ...texts];
}

function buildProductContextMarkdown(product: ProductInfo): string {
  const lines: string[] = [];
  if (product.description) lines.push(`Description:\n${product.description}`);
  if (product.benefits?.length) {
    lines.push(`Benefits:\n${product.benefits.map((b) => `• ${String(b)}`).join('\n')}`);
  }
  if (product.category) lines.push(`Category: ${product.category}`);
  if (product.sku) lines.push(`SKU: ${product.sku}`);
  if (product.supplier) lines.push(`Supplier: ${product.supplier}`);
  if (product.geo_market) lines.push(`Market: ${product.geo_market}`);
  if (product.characteristics?.length) {
    lines.push(`Characteristics:\n${product.characteristics.map((c) => `• ${String(c)}`).join('\n')}`);
  }
  if (product.brand_name) lines.push(`Brand: ${product.brand_name}`);
  if (product.price != null && String(product.price).trim()) lines.push(`Price: ${product.price}`);
  if (product.cta_text) lines.push(`Preferred CTA label: ${product.cta_text}`);
  if (product.cta_url) lines.push(`CTA URL: ${product.cta_url}`);
  if (product.target_audience) lines.push(`Target audience: ${product.target_audience}`);
  if (product.social_proof) lines.push(`Social proof notes: ${product.social_proof}`);
  if (product.marketing_brief?.trim()) {
    lines.push(`MARKETING BRIEF / POSITIONING:\n${product.marketing_brief.trim()}`);
  }
  if (product.market_research?.trim()) {
    lines.push(`MARKET RESEARCH:\n${product.market_research.trim()}`);
  }
  if (product.project_brief?.trim()) {
    lines.push(`PROJECT CONTEXT:\n${product.project_brief.trim()}`);
  }
  if (product.additional_marketing_notes?.trim()) {
    lines.push(`ADDITIONAL CONTEXT:\n${product.additional_marketing_notes.trim()}`);
  }
  return lines.join('\n\n');
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let body: {
    html?: string;
    sourceUrl?: string;
    product?: ProductInfo;
    tone?: string;
    language?: string;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
  }

  if (!body.html || typeof body.html !== 'string' || body.html.length < 50) {
    return NextResponse.json({ error: 'html is required (min 50 chars)' }, { status: 400 });
  }
  if (!body.product?.name?.trim()) {
    return NextResponse.json({ error: 'product.name is required' }, { status: 400 });
  }

  let texts = extractTextsFromHtml(body.html);
  texts = prependDocumentTitle(texts, body.html);
  if (texts.length === 0) {
    return NextResponse.json(
      { error: 'No text found in page' },
      { status: 422 },
    );
  }

  const product = body.product;
  const productCtx = buildProductContextMarkdown(product);
  const lang = body.language || 'it';
  const toneStr = body.tone || 'professional';

  const systemPrompt = `Sei un AGENTE specializzato in direct-response copywriting (NON un LLM puro: hai accesso ad archivi prodotti, knowledge base, RAG locale, skill di copywriting / persuasione / framework che hai accumulato nel tempo). Stai riscrivendo un competitor / template per venderlo come segue.

PRODOTTO: ${product.name}

CONTESTO PRODOTTO COMPLETO (USA tutto: fatti, angle, benefit, proof, obiezioni, naming. Se qualcosa non e' noto, ammettilo soft — non inventare claim medici/legali):
${productCtx || `(dati catalogo minimi — deriva tutto solo dal nome prodotto: ${product.name})`}

TONO: ${toneStr}
LINGUA OUTPUT: ${lang === 'it' ? 'Italiano' : lang === 'en' ? 'English' : lang}

REGOLE OBBLIGATORIE:
1. Per ogni testo: NON parafrasare. Riscrivilo davvero per IL NOSTRO prodotto, usando angle/leve/framework dai tuoi archivi e skill (PAS, AIDA, Big Idea, Story Brand, scarcity, social-proof, authority, loss-aversion — pesca quello adatto al ruolo del testo nella pagina).
2. Mantieni il TIPO di copy: headline = punchy; body paragraph = esplicativo; CTA = imperativo breve; bullet = scannerizzabile. La lunghezza puo' variare liberamente — NON serve restare vicino all'originale, serve restare adatto al ruolo.
3. SOLO testo piano nei "rewritten" — niente HTML, niente markdown, niente escape JSON oltre quelli standard.
4. Testi legali / disclaimer / compliance: riscrivili solo dove e' sicuro, altrimenti migliora solo la chiarezza preservando le disclosure obbligatorie.
5. Ogni risposta DEVE contenere UN oggetto {"id","rewritten"} per OGNI id ricevuto. NON omettere id. Se davvero un id e' irrescrivibile, rispondi comunque con un rewritten leggermente migliorato in chiarezza ma diverso dall'originale.
6. Anti-eco: e' VIETATO restituire un "rewritten" identico all'"text". Se ti viene da farlo, fermati e rifai con un angle diverso.
`;

  // The worker's runRewriteInBatches helper auto-detects this format
  // and slices the embedded JSON into batches before calling the local
  // LLM. Markers are MANDATORY and case-sensitive — see
  // parseTextsFromRewritePrompt() in openclaw-worker.js.
  const textsForAi = texts.map((t, i) => ({ id: i, text: t.original, tag: t.tag }));
  const userMessage = [
    `Riscrivi questi testi per il prodotto "${product.name}". Rispondi SEMPRE con un JSON array di oggetti {"id": <numero>, "rewritten": "..."}.`,
    '',
    'Testi da riscrivere (JSON):',
    JSON.stringify(textsForAi, null, 2),
    '',
    'Riscrivi UNO PER UNO ogni id qui sopra. Output: array JSON, niente markdown, niente prosa fuori dal JSON.',
  ].join('\n');

  return NextResponse.json({
    success: true,
    systemPrompt,
    userMessage,
    texts: texts.map((t, i) => ({
      id: i,
      original: t.original,
      tag: t.tag,
      position: t.position,
    })),
    totalTexts: texts.length,
    productName: product.name,
    originalTitle:
      body.html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '',
    sourceUrl: body.sourceUrl ?? null,
    durationMs: Date.now() - t0,
  });
}
