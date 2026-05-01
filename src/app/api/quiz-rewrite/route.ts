import { NextRequest, NextResponse } from 'next/server';
import { extractAllTextsUniversal } from '@/lib/universal-text-extractor';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// La funzione extractTextsFromHtml è stata rimossa.
// Ora usiamo extractAllTextsUniversal dal modulo universal-text-extractor

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

    // Extract ALL texts from HTML using universal extractor
    const extractedTexts = extractAllTextsUniversal(html);
    if (extractedTexts.length === 0) {
      return NextResponse.json({ error: 'No text found in the HTML to rewrite' }, { status: 400 });
    }

    // Convert to format expected by the rest of the code
    const texts = extractedTexts.map(t => ({ 
      original: t.text, 
      tag: t.context, 
      position: t.position 
    }));
    
    const textsForAi = extractedTexts.map(t => ({ 
      id: t.id, 
      text: t.text, 
      tag: t.context 
    }));
    
    console.log(`[quiz-rewrite] Extracted ${texts.length} texts from HTML (universal extractor)`);

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
        // Store original HTML + ALL texts in chat_history for reconstruction when job completes
        chat_history: {
          html,
          texts: texts.map(t => ({ original: t.original, tag: t.tag })), // No more slice limit!
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
