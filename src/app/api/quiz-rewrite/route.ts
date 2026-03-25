import { NextRequest, NextResponse } from 'next/server';
import { getOpenClawConfig } from '@/lib/openclaw-config';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

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

    const config = await getOpenClawConfig();
    if (!config.apiKey) {
      return NextResponse.json({ error: 'OpenClaw API key not configured' }, { status: 500 });
    }

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

    const userPrompt = `Rewrite these ${texts.length} texts for the product "${productName}":\n\n${JSON.stringify(textsForAi, null, 2)}`;

    // Call OpenClaw via OpenAI-compatible API
    const apiUrl = `${config.baseUrl}/v1/chat/completions`;
    console.log(`[quiz-rewrite] Calling OpenClaw: ${apiUrl} model=${config.model} texts=${texts.length}`);

    let aiText = '';

    // Try non-streaming first (more reliable), fallback to streaming
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.6,
          max_tokens: 16000,
          stream: false,
        }),
        signal: AbortSignal.timeout(90000),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.substring(0, 300)}`);
      }

      const contentType = res.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        const data = await res.json();
        aiText = data.choices?.[0]?.message?.content || '';
      } else {
        // Server returned SSE even with stream:false — collect it
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const json = JSON.parse(line.slice(6));
                  const delta = json.choices?.[0]?.delta?.content || json.choices?.[0]?.message?.content || '';
                  if (delta) aiText += delta;
                } catch { /* skip */ }
              }
            }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown';
      console.error(`[quiz-rewrite] OpenClaw error: ${msg}`);
      return NextResponse.json({ error: `OpenClaw connection failed: ${msg}` }, { status: 502 });
    }

    if (!aiText.trim()) {
      return NextResponse.json({ error: 'OpenClaw returned empty response. Check if the bot is running.' }, { status: 500 });
    }

    console.log(`[quiz-rewrite] OpenClaw response length: ${aiText.length}`);

    const cleaned = cleanAiOutput(aiText);

    let rewrites: Array<{ id: number; rewritten: string }>;
    try {
      rewrites = JSON.parse(cleaned);
    } catch {
      return NextResponse.json({ error: 'AI returned invalid JSON', raw: cleaned.substring(0, 500) }, { status: 500 });
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
    });
  } catch (error) {
    console.error('Quiz rewrite error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
