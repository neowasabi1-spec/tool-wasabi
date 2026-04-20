import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Extract texts from HTML
function extractTextsFromHtml(html: string): Array<{ original: string; tag: string; position: number }> {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '');

  const bodyMatch = stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : stripped;

  const texts: Array<{ original: string; tag: string; position: number }> = [];
  const seen = new Set<string>();

  const blockTags = new Set(['div', 'section', 'article', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'blockquote', 'form', 'button']);
  const textTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'label', 'a', 'button', 'details', 'summary'];

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
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    // Extract texts from HTML
    const texts = extractTextsFromHtml(html);
    if (texts.length === 0) {
      return NextResponse.json({ error: 'No text found in the HTML to rewrite' }, { status: 400 });
    }

    // Limit to 80 texts to keep prompt manageable
    const textsForAi = texts.slice(0, 80).map((t, i) => ({ id: i, text: t.original, tag: t.tag }));

    // Build the Trinity rewrite prompt
    const userMessage = `Sei Trinity, la copywriter del Matrix Team. Devi riscrivere i testi di questa pagina HTML per il prodotto: ${productName}.

DESCRIZIONE PRODOTTO: ${productDescription}
ISTRUZIONI EXTRA: ${customPrompt || 'Nessuna'}

Testi da riscrivere (JSON):
${JSON.stringify(textsForAi, null, 2)}

Riscrivi ogni testo per il prodotto ${productName}. Mantieni lunghezza simile, stesso tono persuasivo, stessa lingua.
Restituisci SOLO un JSON array: [{"id": 0, "rewritten": "testo riscritto"}, ...]`;

    const systemPrompt = `You are Trinity, a direct-response copywriter for the Matrix Team. You rewrite marketing texts for specific products while keeping the same tone, style, length, and persuasion structure.

RULES:
1. Rewrite each text to sell THE PRODUCT, keeping the same emotional angle and copywriting technique.
2. Keep roughly the same length (±20%).
3. Keep the same language/tone (if original is casual, stay casual; if urgent, stay urgent).
4. Do NOT add markdown, HTML tags, or formatting — return plain text only for each item.
5. If a text is a button label, CTA, or short phrase, keep it short and punchy.
6. Return a JSON array ONLY: [{"id": 0, "rewritten": "new text"}, ...]`;

    // Insert async job into openclaw_messages
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/openclaw_messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        user_message: userMessage,
        system_prompt: systemPrompt,
        section: 'Rewrite',
        status: 'pending',
        // Store original HTML + texts in chat_history for reconstruction when job completes
        chat_history: {
          html,
          texts: texts.slice(0, 80).map(t => ({ original: t.original, tag: t.tag })),
          productName,
          totalTextsInPage: texts.length,
        },
      }),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('[quiz-rewrite] Supabase insert failed:', errText);
      return NextResponse.json({ error: `Failed to enqueue rewrite job: ${errText.substring(0, 200)}` }, { status: 500 });
    }

    const [inserted] = await insertRes.json() as Array<{ id: string }>;
    if (!inserted?.id) {
      return NextResponse.json({ error: 'No job ID returned from Supabase' }, { status: 500 });
    }

    console.log(`[quiz-rewrite] Async job enqueued: ${inserted.id}, texts: ${textsForAi.length}`);

    return NextResponse.json({
      jobId: inserted.id,
      status: 'pending',
      totalTexts: textsForAi.length,
      message: 'Rewrite job queued. Poll /api/quiz-rewrite/status/' + inserted.id,
    });

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[quiz-rewrite] Error:', errMsg);
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
