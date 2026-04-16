import { NextRequest, NextResponse } from 'next/server';
import { requireAnthropicKey } from '@/lib/anthropic-key';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const REWRITE_MODEL = 'claude-3-5-haiku-20241022';

async function callAnthropic(systemPrompt: string, userPrompt: string, timeoutMs = 60_000): Promise<string> {
  const apiKey = requireAnthropicKey();

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: REWRITE_MODEL,
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err.substring(0, 300)}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

interface ExtractedText {
  original: string;
  tag: string;
  position: number;
}

function extractTextsFromHtml(html: string): ExtractedText[] {
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

  const attrRegex = /(alt|title|placeholder|aria-label)=["']([^"']{3,200})["']/gi;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(bodyHtml)) !== null) {
    const val = attrMatch[2].trim();
    if (val.length < 3 || !/[a-zA-Z]/.test(val) || seen.has(val) || val.startsWith('http')) continue;
    seen.add(val);
    texts.push({ original: val, tag: `attr:${attrMatch[1]}`, position: 0 });
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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      html: string;
      productName: string;
      productDescription: string;
      customPrompt?: string;
    };

    const { html, productName, productDescription, customPrompt } = body;

    if (!html || html.length < 50) {
      return NextResponse.json({ error: 'HTML too short or missing' }, { status: 400 });
    }
    if (!productName) {
      return NextResponse.json({ error: 'Product name required' }, { status: 400 });
    }

    const texts = extractTextsFromHtml(html);
    if (texts.length === 0) {
      return NextResponse.json({ error: 'No text found in the HTML to rewrite' }, { status: 400 });
    }

    const textsForAi = texts.map((t, i) => ({ id: i, text: t.original, tag: t.tag }));

    const systemPrompt = `You are a direct-response copywriter. You rewrite marketing texts for a specific product while keeping the EXACT SAME tone, style, length, and persuasion structure.

PRODUCT: ${productName}
DESCRIPTION: ${productDescription}
${customPrompt ? `ADDITIONAL INSTRUCTIONS: ${customPrompt}` : ''}

RULES:
1. Rewrite each text to sell THIS product, keeping the same emotional angle and copywriting technique.
2. Keep roughly the same length (±20%).
3. Keep the same language/tone (if original is casual, stay casual; if urgent, stay urgent).
4. Do NOT add markdown, HTML tags, or formatting — return plain text only for each item.
5. If a text is a button label, CTA, or short phrase, keep it short and punchy.
6. If a text is clearly structural (like "Step 1", "FAQ", numbers), keep it unchanged or adapt minimally.
7. Return a JSON array of objects: [{"id": 0, "rewritten": "new text"}, ...]
8. Return ONLY the JSON array, nothing else.`;

    const BATCH_SIZE = 40;
    const CONCURRENCY = 4;
    const batches: typeof textsForAi[] = [];
    for (let i = 0; i < textsForAi.length; i += BATCH_SIZE) {
      batches.push(textsForAi.slice(i, i + BATCH_SIZE));
    }

    console.log(`[quiz-rewrite] Total texts=${texts.length}, batches=${batches.length}, batch_size=${BATCH_SIZE}, concurrency=${CONCURRENCY}`);

    const rewrites: Array<{ id: number; rewritten: string }> = [];
    const batchErrors: string[] = [];
    const usedProvider = 'anthropic';

    async function processBatch(batch: typeof textsForAi, batchIdx: number): Promise<Array<{ id: number; rewritten: string }>> {
      const batchPrompt = `Rewrite these ${batch.length} texts for the product "${productName}":\n\n${JSON.stringify(batch, null, 2)}`;
      try {
        const aiText = await callAnthropic(systemPrompt, batchPrompt, 55_000);
        const cleaned = cleanAiOutput(aiText);
        try {
          const parsed = JSON.parse(cleaned) as Array<{ id: number; rewritten: string }>;
          console.log(`[quiz-rewrite] batch ${batchIdx + 1}/${batches.length} OK (${parsed.length} rewrites)`);
          return parsed;
        } catch (parseErr) {
          const msg = `batch ${batchIdx + 1}: JSON parse failed — raw start: ${cleaned.substring(0, 200)}`;
          batchErrors.push(msg);
          console.error(`[quiz-rewrite] ${msg}`);
          return [];
        }
      } catch (err) {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        batchErrors.push(`batch ${batchIdx + 1}: ${msg}`);
        console.error(`[quiz-rewrite] batch ${batchIdx + 1}/${batches.length} failed:`, msg);
        return [];
      }
    }

    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const slice = batches.slice(i, i + CONCURRENCY);
      const results = await Promise.all(slice.map((b, j) => processBatch(b, i + j)));
      for (const r of results) rewrites.push(...r);
    }

    if (rewrites.length === 0) {
      const reason = batchErrors[0] || 'unknown';
      return NextResponse.json({
        error: `Anthropic all ${batches.length} batches failed. First error: ${reason}`,
        batches_total: batches.length,
        batches_failed: batchErrors.length,
        first_errors: batchErrors.slice(0, 5),
      }, { status: 502 });
    }

    let resultHtml = html;
    let replacements = 0;

    for (const rw of rewrites) {
      const original = texts[rw.id];
      if (!original || !rw.rewritten || original.original === rw.rewritten) continue;

      const escaped = original.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'g');
      const before = resultHtml;
      resultHtml = resultHtml.replace(regex, rw.rewritten);
      if (resultHtml !== before) replacements++;
    }

    return NextResponse.json({
      success: true,
      html: resultHtml,
      totalTexts: texts.length,
      replacements,
      originalLength: html.length,
      newLength: resultHtml.length,
      provider: usedProvider,
    });
  } catch (error) {
    console.error('Quiz rewrite error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
