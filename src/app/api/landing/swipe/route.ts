import { NextRequest, NextResponse } from 'next/server';
import { requireAnthropicKey } from '@/lib/anthropic-key';
import { extractAllTextsUniversal } from '@/lib/universal-text-extractor';

export const maxDuration = 300;

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
  /** Extra catalog fields when swiping via product_id */
  sku?: string | null;
  category?: string | null;
  characteristics?: string[] | null;
  geo_market?: string | null;
  supplier?: string | null;
  /** Long-form positioning / strategist output — injected into swipe prompt */
  marketing_brief?: string;
  /** Freeform angles, objections, proofs, swipe notes */
  additional_marketing_notes?: string;
  /** Aggregated from linked project rows (backend / MCP may set this) */
  project_brief?: string;
  market_research?: string;
}

interface ExtractedText {
  original: string;
  tag: string;
  position: number;
}

// Categorie estratte dalla v2 (extractAllTextsUniversal) che SONO sicure da
// passare all'AI per essere riscritte. Escludiamo url/email/phone/script/json-ld
// e attributi `data-*` perché sostituirli rompe routing/widget/embed.
const SAFE_TAG_CONTEXT = new Set([
  'title',
  // meta-description / og:description / twitter:description sono gestite separatamente
  // nei rewrite server-side; qui comunque includiamo "meta:content" e poi filtriamo
  // con il check sul name nell'HTML originale.
  'meta:content',
]);
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

// Hard cap to keep Anthropic round-trip within Netlify's 300s function budget.
// Big SaaS landings can produce 1000+ raw entries from the universal extractor;
// after dedupe-by-text we usually stay around 200–400 unique strings.
const MAX_TEXTS_FOR_AI = Math.max(
  50,
  Math.min(800, Number.parseInt(process.env.SWIPE_MAX_TEXTS_FOR_AI || '350', 10) || 350),
);

// Priority for keeping the most user-visible copy when we hit the cap.
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
  // Usiamo l'estrattore v2 ("universal") e mappiamo nel formato locale,
  // con dedupe-by-text e cap di sicurezza.
  const universal = extractAllTextsUniversal(html);
  const collected: ExtractedText[] = [];
  const seen = new Map<string, ExtractedText>();
  for (const u of universal) {
    if (!isSafeContext(u.context)) continue;
    if (u.text.length < 2 || u.text.length > 800) continue;
    if (!/[a-zA-Z]/.test(u.text)) continue;
    if (u.text.startsWith('http://') || u.text.startsWith('https://')) continue;
    // Salta junk tipico (json/code embed accidentale)
    if (u.text.includes('{') && u.text.includes('}') && /[=:]\s*function|=>/.test(u.text)) continue;

    let mappedTag = u.context;
    if (u.context.startsWith('attr:')) {
      mappedTag = u.context;
    } else if (u.context.startsWith('tag:')) {
      mappedTag = u.context.slice(4);
    } else if (u.context.startsWith('mixed:')) {
      mappedTag = u.context.slice(6);
    } else if (u.context === 'title') {
      mappedTag = 'title';
    } else if (u.context === 'meta:content') {
      mappedTag = 'attr:meta-content';
    }

    const existing = seen.get(u.text);
    const newPrio = priorityOf(mappedTag);
    if (existing) {
      // tieni quello con priority più alta (numero più basso)
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

  // Cap: ordina per priorità (più importante = numero più basso) e taglia.
  if (collected.length > MAX_TEXTS_FOR_AI) {
    collected.sort((a, b) => priorityOf(a.tag) - priorityOf(b.tag));
    return collected.slice(0, MAX_TEXTS_FOR_AI);
  }
  return collected;
}

function _legacyExtract(html: string): ExtractedText[] {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '');

  const bodyMatch = stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : stripped;

  const texts: ExtractedText[] = [];
  const seen = new Set<string>();

  const textTags = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'li', 'td', 'th', 'dt', 'dd',
    'button', 'a', 'label', 'figcaption',
    'blockquote', 'summary', 'legend',
  ];

  const blockTags = new Set([
    'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'blockquote', 'figure', 'figcaption', 'form', 'fieldset',
    'button', 'details', 'summary',
  ]);

  for (const tag of textTags) {
    const regex = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let match;
    while ((match = regex.exec(bodyHtml)) !== null) {
      const innerHTML = match[2];
      const plain = innerHTML.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (plain.length < 2 || !/[a-zA-Z]/.test(plain)) continue;
      if (seen.has(plain)) continue;
      if (plain.includes('{') && plain.includes('}') && plain.includes('=>')) continue;

      const hasBlockChild = Array.from(innerHTML.matchAll(/<(div|section|article|p|h[1-6]|ul|ol|li|table|tr|td|th|blockquote|form|button)[^>]*>/gi))
        .some((m) => {
          const childTag = m[1].toLowerCase();
          if (!blockTags.has(childTag)) return false;
          const childContent = innerHTML.slice(m.index! + m[0].length);
          const closeIdx = childContent.indexOf(`</${childTag}`);
          if (closeIdx === -1) return false;
          const childText = childContent.slice(0, closeIdx).replace(/<[^>]*>/g, '').trim();
          return childText.length >= 2;
        });
      if (hasBlockChild) continue;

      seen.add(plain);
      texts.push({ original: plain, tag, position: match.index || 0 });
    }
  }

  const inlineRegex = /<(span|div|strong|em|b|i)([^>]*)>([^<]{3,500})<\/\1>/gi;
  let inMatch;
  while ((inMatch = inlineRegex.exec(bodyHtml)) !== null) {
    const text = inMatch[3].replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 3 || !/[a-zA-Z]/.test(text) || seen.has(text)) continue;
    seen.add(text);
    texts.push({ original: text, tag: inMatch[1], position: inMatch.index || 0 });
  }

  const attrRegex = /(alt|title|placeholder|aria-label|value)=["']([^"']{3,200})["']/gi;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(bodyHtml)) !== null) {
    const val = attrMatch[2].trim();
    if (val.length < 3 || !/[a-zA-Z]/.test(val) || seen.has(val) || val.startsWith('http')) continue;
    // value="" only useful on form controls (button/input/option) where it's the visible label.
    if (attrMatch[1].toLowerCase() === 'value') {
      const before = bodyHtml.slice(Math.max(0, (attrMatch.index || 0) - 80), attrMatch.index || 0);
      if (!/<(input|button|option)\b[^>]*$/i.test(before)) continue;
    }
    seen.add(val);
    texts.push({ original: val, tag: `attr:${attrMatch[1]}`, position: 0 });
  }

  // Leaf <div> / <option> / <figcaption> with plain text and no block children.
  const leafRegex = /<(div|option|figcaption)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let leafMatch;
  while ((leafMatch = leafRegex.exec(bodyHtml)) !== null) {
    const inner = leafMatch[3];
    if (/<(div|section|article|p|h[1-6]|ul|ol|li|table|tr|td|th|blockquote|form|button)\b/i.test(inner)) continue;
    const plain = inner.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (plain.length < 3 || plain.length > 600 || !/[a-zA-Z]/.test(plain) || seen.has(plain)) continue;
    if (plain.includes('{') && plain.includes('}') && plain.includes('=>')) continue;
    seen.add(plain);
    texts.push({ original: plain, tag: leafMatch[1], position: leafMatch.index || 0 });
  }

  return texts;
}

function cleanAiOutput(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/i, '');
  const jsonStart = cleaned.indexOf('[');
  const jsonEnd = cleaned.lastIndexOf(']');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
  }
  return cleaned.trim();
}

const SWIPE_TEXT_BATCH_SIZE = Math.max(
  8,
  Math.min(40, Number.parseInt(process.env.SWIPE_TEXT_BATCH_SIZE || '28', 10) || 28),
);

async function callAnthropicFallback(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = requireAnthropicKey();

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(150_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err.substring(0, 300)}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || '';
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

/** Document <title> is easy to miss in tag-only extraction; prepend when distinct. */
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

async function anthropicRewriteBatch(
  systemPrompt: string,
  batch: Array<{ id: number; text: string; tag: string }>,
  passLabel: string,
): Promise<Array<{ id: number; rewritten: string }>> {
  if (batch.length === 0) return [];
  const userPrompt = `${passLabel}: You MUST return exactly one JSON object per input id (${batch.length} items). Never skip an id.

Rewrite these texts so they sell ONLY the described product while keeping approximate length (±25%) and the same conversational energy. Plain text only in "rewritten" — no HTML or markdown.

Input:
${JSON.stringify(batch, null, 2)}

Output shape: [{"id": number, "rewritten": "..."}, ...] — include EVERY id listed above (any order ok).`;

  const aiText = await callAnthropicFallback(systemPrompt, userPrompt);
  if (!aiText.trim()) throw new Error('Empty batch response from Anthropic');
  const cleaned = cleanAiOutput(aiText);
  const parsed: unknown = JSON.parse(cleaned);
  const rewrites = parsed as Array<{ id: number; rewritten: string }>;
  if (!Array.isArray(rewrites)) throw new Error('AI batch: expected JSON array');
  return rewrites;
}

async function collectAllRewrites(
  systemPrompt: string,
  textsForAi: Array<{ id: number; text: string; tag: string }>,
): Promise<Map<number, string>> {
  const effective = new Map<number, string>();

  const totalBatches = Math.ceil(textsForAi.length / SWIPE_TEXT_BATCH_SIZE);
  for (let i = 0; i < textsForAi.length; i += SWIPE_TEXT_BATCH_SIZE) {
    const slice = textsForAi.slice(i, i + SWIPE_TEXT_BATCH_SIZE);
    const batchIdx = Math.floor(i / SWIPE_TEXT_BATCH_SIZE) + 1;
    try {
      const rewrites = await anthropicRewriteBatch(
        systemPrompt,
        slice,
        `Batch ${batchIdx} of ${totalBatches}`,
      );
      for (const rw of rewrites) {
        if (typeof rw.id !== 'number' || rw.rewritten === undefined || rw.rewritten === null) continue;
        const trimmed = String(rw.rewritten).trim();
        if (!trimmed) continue;
        const originalText = textsForAi.find((t) => t.id === rw.id)?.text;
        if (originalText && trimmed === originalText) continue;
        effective.set(rw.id, trimmed);
      }
    } catch (e) {
      console.error(`[swipe] batch failed at offset ${i}:`, e instanceof Error ? e.message : e);
      throw e;
    }
  }

  // Solo 2 sweep di gap-fill: i sweep extra costano un round-trip Anthropic
  // per ogni 28-40 testi e fanno saltare il limite Netlify (300s) su pagine
  // grosse. 2 passi coprono >99% nei test reali.
  const maxSweep = Math.max(0, Math.min(6, Number.parseInt(process.env.SWIPE_MAX_SWEEP || '2', 10) || 2));
  for (let sweep = 0; sweep < maxSweep; sweep++) {
    const missing = textsForAi.filter((t) => !effective.has(t.id));
    if (missing.length === 0) break;
    console.log(`[swipe] fill sweep ${sweep + 1}: ${missing.length} texts still outstanding`);

    for (let j = 0; j < missing.length; j += SWIPE_TEXT_BATCH_SIZE) {
      const slice = missing.slice(j, j + SWIPE_TEXT_BATCH_SIZE);
      try {
        const rewrites = await anthropicRewriteBatch(
          systemPrompt,
          slice,
          `GAP-FILL — return ONLY ids [${slice.map((s) => s.id).join(', ')}]; every id mandatory`,
        );
        for (const rw of rewrites) {
          if (typeof rw.id !== 'number' || rw.rewritten === undefined || rw.rewritten === null) continue;
          const trimmed = String(rw.rewritten).trim();
          if (!trimmed) continue;
          effective.set(rw.id, trimmed);
        }
      } catch (e) {
        console.error(`[swipe] gap-fill error:`, e instanceof Error ? e.message : e);
      }
    }
  }

  return effective;
}

async function clonePageHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Failed to fetch page: HTTP ${res.status}`);
  let html = await res.text();
  return absolutizeUrls(html, url);
}

function makeAbsolute(path: string, origin: string, basePath: string, protocol: string): string {
  const trimmed = path.trim();
  if (!trimmed || /^(https?:\/\/|data:|#|mailto:|javascript:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return protocol + trimmed;
  if (trimmed.startsWith('/')) return origin + trimmed;
  return basePath + trimmed;
}

function fixMediaLoading(html: string): string {
  let fixed = html.replace(/loading=["']lazy["']/gi, 'loading="eager"');
  fixed = fixed.replace(/<img\b/gi, '<img referrerpolicy="no-referrer" ');
  fixed = fixed.replace(/<video\b/gi, '<video referrerpolicy="no-referrer" ');
  fixed = fixed.replace(/<source\b/gi, '<source referrerpolicy="no-referrer" ');
  if (fixed.includes('<head>')) {
    fixed = fixed.replace('<head>', '<head><meta name="referrer" content="no-referrer">');
  } else if (fixed.includes('<head ')) {
    fixed = fixed.replace(/<head\s/i, '<head><meta name="referrer" content="no-referrer"></head><head ');
  } else {
    fixed = '<meta name="referrer" content="no-referrer">' + fixed;
  }
  return fixed;
}

function absolutizeUrls(html: string, baseUrl: string): string {
  const urlObj = new URL(baseUrl);
  const origin = urlObj.origin;
  const basePath = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  const protocol = urlObj.protocol;

  return html
    .replace(/(srcset)=(["'])(.*?)\2/gi, (_match, attr, quote, value) => {
      if (/^\s*(https?:\/\/|\/\/)/i.test(value)) return `${attr}=${quote}${value}${quote}`;
      const fixed = value.split(/,(?=\s)/).map((entry: string) => {
        const parts = entry.trim().split(/\s+/);
        if (parts.length === 0) return entry;
        parts[0] = makeAbsolute(parts[0], origin, basePath, protocol);
        return parts.join(' ');
      }).join(', ');
      return `${attr}=${quote}${fixed}${quote}`;
    })
    .replace(/(src|href|poster|data-src|data-lazy-src)=(["'])((?!https?:\/\/|data:|#|mailto:|javascript:|\/\/).*?)\2/gi,
      (_match, attr, quote, path) => {
        return `${attr}=${quote}${makeAbsolute(path, origin, basePath, protocol)}${quote}`;
      })
    .replace(/url\((['"]?)((?!https?:\/\/|data:|#)(?:\/[^)'"]+|[^)'"\s]+))\1\)/gi,
      (_match, quote, path) => {
        return `url(${quote}${makeAbsolute(path, origin, basePath, protocol)}${quote})`;
      });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { source_url, html: providedHtml, product, tone, language } = body as {
      source_url?: string;
      html?: string;
      product: ProductInfo;
      tone?: string;
      language?: string;
    };

    if (!source_url && !providedHtml) {
      return NextResponse.json({ error: 'source_url or html required' }, { status: 400 });
    }
    if (!product?.name) {
      return NextResponse.json({ error: 'product.name required' }, { status: 400 });
    }

    let originalHtml: string;
    if (providedHtml) {
      originalHtml = source_url ? absolutizeUrls(providedHtml, source_url) : providedHtml;
    } else {
      originalHtml = await clonePageHtml(source_url!);
    }
    originalHtml = fixMediaLoading(originalHtml);
    if (originalHtml.length < 50) {
      return NextResponse.json({ error: 'HTML too short' }, { status: 400 });
    }

    let texts = extractTextsFromHtml(originalHtml);
    texts = prependDocumentTitle(texts, originalHtml);
    if (texts.length === 0) {
      return NextResponse.json({ error: 'No text found in page' }, { status: 400 });
    }

    const textsForAi = texts.map((t, i) => ({ id: i, text: t.original, tag: t.tag }));
    const productCtx = buildProductContextMarkdown(product);

    const lang = language || 'it';
    const toneStr = tone || 'professional';

    const systemPrompt = `You are a world-class direct-response copywriter. You rewrite competitor-style marketing texts to sell ONE specific product/offering without changing HTML structure downstream.

PRODUCT NAME: ${product.name}

FULL PRODUCT CONTEXT (use this everywhere you need facts, angles, benefits, proofs, objections, naming; if something is unknown, soften with honest uncertainty — avoid inventing medical/legal claims):
${productCtx || `(minimal catalog data — derive only from product name: ${product.name})`}

TONE: ${toneStr}
OUTPUT LANGUAGE FOR REWRITES: ${lang === 'it' ? 'Italian' : lang === 'en' ? 'English' : lang}

CRITICAL RULES:
1. Treat each input line as discrete visible copy — rewrite it completely for OUR product/offering whenever it is substantive marketing text.
2. Keep the same conversational energy/medium (headline punchy stays punchy). Approximate length ±25%.
3. Plain text ONLY in rewritten strings — NO HTML, markdown, or JSON escapes beyond normal string characters.
4. Legal/compliance texts: rewrite only where safe; preserve mandatory disclosures when uncertainty exists.
5. Every batch MUST return one {"id","rewritten"} object per supplied id — never omit ids.
`;

    let idToRewrite: Map<number, string>;
    try {
      console.log(`[swipe] Anthropic batched swipe, texts=${texts.length}, batch=${SWIPE_TEXT_BATCH_SIZE}`);
      // Hard wall: 240s for the whole AI loop. Netlify functions die at 300s,
      // we leave 60s for response building, server-side meta/title rewrite, etc.
      const aiBudgetMs = Math.max(
        60_000,
        Math.min(280_000, Number.parseInt(process.env.SWIPE_AI_BUDGET_MS || '240000', 10) || 240_000),
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`AI budget exceeded (${aiBudgetMs}ms)`)), aiBudgetMs);
      });
      idToRewrite = (await Promise.race([
        collectAllRewrites(systemPrompt, textsForAi),
        timeoutPromise,
      ])) as Map<number, string>;
    } catch (anthropicErr) {
      console.error(`[swipe] Anthropic failed: ${anthropicErr instanceof Error ? anthropicErr.message : 'Unknown'}`);
      return NextResponse.json(
        {
          error: `Anthropic failed: ${anthropicErr instanceof Error ? anthropicErr.message : 'Unknown'}`,
        },
        { status: 502 },
      );
    }

    const unresolvedIds = textsForAi.filter((t) => !idToRewrite.has(t.id)).map((t) => t.id);
    if (unresolvedIds.length > 0) {
      console.warn(`[swipe] unresolved text ids after sweeps: ${unresolvedIds.join(',')}`);
    }

    const replacementPairs: Array<{ from: string; to: string; attr?: string }> = [];
    const serverSideTitlePairs: Array<{ from: string; to: string }> = [];
    const serverSideMetaPairs: Array<{ from: string; to: string }> = [];
    for (const [id, rewritten] of idToRewrite) {
      const original = texts[id];
      if (!original || !rewritten || original.original === rewritten) continue;
      if (original.tag === 'title') {
        // Sostituiamo SIA server-side (per evitare il flash del titolo originale
        // nel tab del browser e per SEO/social preview) sia client-side via lo
        // script DOM-replacer (per gestire reload/SPA).
        serverSideTitlePairs.push({ from: original.original, to: rewritten });
        replacementPairs.push({ from: original.original, to: rewritten });
      } else if (original.tag === 'attr:meta-content') {
        // Solo server-side: i <meta> non sono nel DOM visibile, quindi lo script
        // client-side non li tocca. Servono per og:description / twitter:card / SEO.
        serverSideMetaPairs.push({ from: original.original, to: rewritten });
      } else if (original.tag.startsWith('attr:')) {
        replacementPairs.push({
          from: original.original,
          to: rewritten,
          attr: original.tag.replace('attr:', ''),
        });
      } else {
        replacementPairs.push({ from: original.original, to: rewritten });
      }
    }

    function escRxLiteral(s: string): string {
      return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function escAttr(s: string): string {
      return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }
    function escHtml(s: string): string {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    const usedProvider = 'anthropic';

    const swipeScript = `<script data-swipe-replacer>
(function(){
  var pairs = ${JSON.stringify(replacementPairs)};
  function escRx(s){return s.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&');}
  function normWS(s){return (s||'').replace(/\\s+/g,' ').trim();}
  // Pre-compute a normalized form + tolerant regex for every pair so we can
  // match even when whitespace (newlines, double spaces, &nbsp;) differs.
  var prepared = pairs.map(function(p){
    var fn = normWS(p.from);
    return {
      from: p.from,
      to: p.to,
      attr: p.attr,
      norm: fn,
      rx: fn ? new RegExp(escRx(fn).replace(/ /g,'\\\\s+'),'g') : null
    };
  }).filter(function(p){return p.norm && p.norm.length>=2;});
  function tryReplace(text){
    if(!text) return text;
    var out = text;
    for(var i=0;i<prepared.length;i++){
      var p = prepared[i];
      if(p.attr) continue;
      if(out.indexOf(p.from)!==-1){
        out = out.split(p.from).join(p.to);
      } else if(p.rx && p.rx.test(out)){
        p.rx.lastIndex = 0;
        out = out.replace(p.rx, p.to);
      }
    }
    return out;
  }
  // Pass 1 — replace at the element level when full normalized textContent
  // matches one of our normalized "from" strings. This handles texts that
  // were split across inline children (<p>This <strong>is</strong> nice</p>).
  var blockSel = 'h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,button,a,label,figcaption,blockquote,summary,legend,span,strong,em,b,i';
  var elems = document.body ? document.body.querySelectorAll(blockSel) : [];
  for(var k=0;k<elems.length;k++){
    var el = elems[k];
    if(el.querySelector(blockSel)) continue; // skip containers, only leaf-ish blocks
    var fullNorm = normWS(el.textContent);
    if(!fullNorm) continue;
    for(var p2=0;p2<prepared.length;p2++){
      var pp = prepared[p2];
      if(pp.attr) continue;
      if(fullNorm === pp.norm){
        el.textContent = pp.to;
        break;
      }
    }
  }
  // Pass 2 — text-node level replacement for everything else.
  function walkText(node){
    if(node.nodeType===3){
      var t = node.textContent;
      var nt = tryReplace(t);
      if(nt !== t) node.textContent = nt;
    } else if(node.nodeType===1 && node.tagName!=='SCRIPT' && node.tagName!=='STYLE'){
      for(var c=node.firstChild;c;c=c.nextSibling) walkText(c);
    }
  }
  if(document.body) walkText(document.body);
  // Pass 3 — attributes (alt/title/placeholder/aria-label).
  for(var a=0;a<prepared.length;a++){
    var pa = prepared[a];
    if(!pa.attr) continue;
    var els = document.querySelectorAll('['+pa.attr+']');
    for(var j=0;j<els.length;j++){
      var v = els[j].getAttribute(pa.attr);
      if(!v) continue;
      var nv = v;
      if(v.indexOf(pa.from)!==-1){
        nv = v.split(pa.from).join(pa.to);
      } else if(pa.rx && pa.rx.test(v)){
        pa.rx.lastIndex = 0;
        nv = v.replace(pa.rx, pa.to);
      }
      if(nv !== v) els[j].setAttribute(pa.attr, nv);
    }
  }
  // Pass 4 — <title>.
  var titleEl = document.querySelector('title');
  if(titleEl){
    var tt = titleEl.textContent;
    var ntt = tryReplace(tt);
    if(ntt !== tt) titleEl.textContent = ntt;
  }
})();
<\/script>`;

    // Server-side replace: <title> e <meta content="..."> (il browser non li
    // gestisce dallo script DOM-replacer).
    let preparedHtml = originalHtml;
    for (const tp of serverSideTitlePairs) {
      const rx = new RegExp(`(<title[^>]*>)\\s*${escRxLiteral(escHtml(tp.from))}\\s*(<\\/title>)`, 'gi');
      const before = preparedHtml;
      preparedHtml = preparedHtml.replace(rx, `$1${escHtml(tp.to)}$2`);
      // fallback: prova senza escape se il <title> originale conteneva caratteri raw
      if (preparedHtml === before) {
        const rxRaw = new RegExp(`(<title[^>]*>)\\s*${escRxLiteral(tp.from)}\\s*(<\\/title>)`, 'gi');
        preparedHtml = preparedHtml.replace(rxRaw, `$1${escHtml(tp.to)}$2`);
      }
    }
    for (const mp of serverSideMetaPairs) {
      // <meta ... content="...">  e  <meta ... content='...'>
      const rxDQ = new RegExp(
        `(<meta\\b[^>]*\\bcontent=)"${escRxLiteral(escAttr(mp.from))}"`,
        'gi',
      );
      const rxSQ = new RegExp(
        `(<meta\\b[^>]*\\bcontent=)'${escRxLiteral(escAttr(mp.from))}'`,
        'gi',
      );
      preparedHtml = preparedHtml.replace(rxDQ, `$1"${escAttr(mp.to)}"`);
      preparedHtml = preparedHtml.replace(rxSQ, `$1'${escAttr(mp.to)}'`);
      // fallback: alcuni siti scrivono content senza escapare
      const rxRaw = new RegExp(
        `(<meta\\b[^>]*\\bcontent=)(["'])${escRxLiteral(mp.from)}\\2`,
        'gi',
      );
      preparedHtml = preparedHtml.replace(rxRaw, `$1$2${escAttr(mp.to)}$2`);
    }

    let resultHtml = preparedHtml;
    if (resultHtml.includes('</body>')) {
      resultHtml = resultHtml.replace('</body>', swipeScript + '</body>');
    } else {
      resultHtml += swipeScript;
    }

    const newTitle =
      serverSideTitlePairs[0]?.to ||
      (texts.length > 0 ? (replacementPairs.find((p) => !p.attr)?.to || '') : '');

    const totalReplacements =
      replacementPairs.length + serverSideTitlePairs.length + serverSideMetaPairs.length;

    return NextResponse.json({
      success: true,
      html: resultHtml,
      original_title: originalHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '',
      new_title: newTitle,
      original_length: originalHtml.length,
      new_length: resultHtml.length,
      totalTexts: texts.length,
      replacements: totalReplacements,
      replacements_dom: replacementPairs.length,
      replacements_title: serverSideTitlePairs.length,
      replacements_meta: serverSideMetaPairs.length,
      unresolved_text_ids: unresolvedIds,
      coverage_ratio: texts.length ? totalReplacements / texts.length : 0,
      provider: usedProvider,
      method_used: 'universal-extract+dom-replacement-batched',
      changes_made: replacementPairs.map((p) => ({ from: p.from.substring(0, 50), to: p.to.substring(0, 50) })),
    });
  } catch (error) {
    console.error('Swipe error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error during swipe' },
      { status: 500 },
    );
  }
}
