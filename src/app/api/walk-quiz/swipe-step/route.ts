import { NextRequest, NextResponse } from 'next/server';
import { extractAllTextsUniversal } from '@/lib/universal-text-extractor';
import { requireAnthropicKey } from '@/lib/anthropic-key';

/**
 * Swipe sincrono di un SINGOLO step di un quiz multi-step.
 *
 * Riusa il pattern del classico /api/quiz-rewrite ma in versione molto piu'
 * semplice: l'HTML di un singolo step e' piccolo (10-50KB) e ha pochi
 * testi (20-80 tipicamente), quindi facciamo UNA call a Claude col system
 * prompt + tutti i testi in JSON, raccogliamo le riscritture e
 * sostituiamo nell'HTML.
 *
 * Lambda max 26s, niente worker, niente queue. Per HTML grossi (improbabile
 * per un singolo step) il caller deve invece passare per la pipeline
 * batch della sezione Clone/Swipe classica.
 *
 * Input:  { html, productName, productDescription?, customPrompt? }
 * Output: { ok, html, replacements, totalTexts, originalLength, newLength }
 */
export const runtime = 'nodejs';
export const maxDuration = 26;
export const dynamic = 'force-dynamic';

const SYSTEM_PROMPT = `You are a direct-response copywriter. You rewrite marketing texts for a specific product while keeping the same tone, persuasion structure, and emotional angle.

RULES:
1. Rewrite each text to sell THE PRODUCT, keeping the same emotional angle and copywriting technique.
2. LENGTH IS FREE: rewrite at whatever length serves the message best.
3. Keep the same language/tone (if original is casual, stay casual; if urgent, stay urgent).
4. Do NOT add markdown, HTML tags, or formatting — return plain text only for each item.
5. If a text is a button label, CTA, or short phrase, keep it short and punchy.
6. If a text is clearly structural ("Step 1", "FAQ", "Question 2 of 5", numbers), keep it unchanged or adapt minimally.
7. Return a JSON array of objects: [{"id": 0, "rewritten": "new text"}, ...]
8. Return ONLY the JSON array, nothing else.`;

interface RewriteItem {
  id: number;
  rewritten: string;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function callClaude(systemPrompt: string, userPrompt: string, timeoutMs: number): Promise<string> {
  const apiKey = requireAnthropicKey();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json() as { content?: Array<{ text?: string }> };
    const text = data.content?.[0]?.text || '';
    if (!text) throw new Error('Empty response from Anthropic');
    return text;
  } finally {
    clearTimeout(t);
  }
}

function parseRewriteArray(raw: string): RewriteItem[] {
  // Striscia eventuali code-fence di markdown e tutto cio' che sta prima del
  // primo `[` / dopo l'ultimo `]`.
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Risposta Claude non contiene un array JSON');
  }
  const arr = JSON.parse(s.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('Risposta Claude non e\' un array');
  return arr.filter((x) => x && typeof x === 'object' && typeof x.id === 'number' && typeof x.rewritten === 'string');
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      html?: string;
      productName?: string;
      productDescription?: string;
      customPrompt?: string;
    };
    const html = body.html;
    if (!html || typeof html !== 'string') {
      return NextResponse.json({ ok: false, error: 'html is required' }, { status: 400 });
    }
    if (html.length > 500_000) {
      return NextResponse.json(
        { ok: false, error: 'HTML troppo grande per la pipeline sync (>500KB). Usa la sezione Clone/Swipe classica.' },
        { status: 413 },
      );
    }

    const productName = (body.productName || '').trim() || 'the product';
    const productDescription = (body.productDescription || '').trim();
    const customPrompt = (body.customPrompt || '').trim();

    const extracted = extractAllTextsUniversal(html);
    const totalTexts = extracted.length;
    if (totalTexts === 0) {
      return NextResponse.json(
        { ok: true, html, replacements: 0, totalTexts: 0, originalLength: html.length, newLength: html.length },
      );
    }

    // Hard cap difensivo: in un singolo step >300 testi indica HTML enorme
    // o estrattore impazzito. Tronchiamo e mandiamo il resto a chi sa
    // gestirlo (la pipeline batch).
    const MAX_TEXTS = 300;
    const usedTexts = extracted.slice(0, MAX_TEXTS);

    const userPrompt = [
      `PRODUCT: ${productName}`,
      productDescription ? `PRODUCT DESCRIPTION: ${productDescription}` : '',
      customPrompt ? `EXTRA INSTRUCTIONS: ${customPrompt}` : '',
      '',
      `Rewrite each of these ${usedTexts.length} marketing texts to sell the product above. Return ONLY the JSON array as specified by the rules.`,
      '',
      JSON.stringify(usedTexts.map((t) => ({ id: t.id, text: t.text })), null, 2),
    ].filter(Boolean).join('\n');

    const claudeRaw = await callClaude(SYSTEM_PROMPT, userPrompt, 22_000);
    const rewrites = parseRewriteArray(claudeRaw);

    const byId = new Map<number, string>();
    for (const r of rewrites) byId.set(r.id, r.rewritten);

    let out = html;
    let replacements = 0;
    // Ordiniamo per lunghezza decrescente del testo originale: prima
    // sostituiamo le stringhe piu' lunghe, cosi' non rischiamo che una
    // stringa breve matchi pezzo di una piu' lunga e la rompa.
    const sorted = [...usedTexts].sort((a, b) => b.text.length - a.text.length);
    for (const t of sorted) {
      const rewritten = byId.get(t.id);
      if (rewritten == null) continue;
      if (rewritten === t.text) continue;
      const re = new RegExp(escapeForRegex(t.text), 'g');
      const before = out;
      out = out.replace(re, rewritten.replace(/\$/g, '$$$$'));
      if (out !== before) replacements++;
    }

    return NextResponse.json({
      ok: true,
      html: out,
      replacements,
      totalTexts,
      usedTexts: usedTexts.length,
      truncated: totalTexts > MAX_TEXTS,
      originalLength: html.length,
      newLength: out.length,
    });
  } catch (error) {
    console.error('[walk-quiz/swipe-step] error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Error' },
      { status: 500 },
    );
  }
}
