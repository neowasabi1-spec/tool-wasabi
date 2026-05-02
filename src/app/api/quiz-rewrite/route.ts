import { NextRequest, NextResponse } from 'next/server';
import { extractAllTextsUniversal } from '@/lib/universal-text-extractor';
import { filterAndCap, DEFAULT_MAX_TEXTS } from '@/lib/swipe-text-filter';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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

    const maxTexts = Math.max(
      50,
      Math.min(800, Number.parseInt(process.env.QUIZ_REWRITE_MAX_TEXTS || String(DEFAULT_MAX_TEXTS), 10) || DEFAULT_MAX_TEXTS),
    );

    const rawUniversal = extractAllTextsUniversal(html);
    const filtered = filterAndCap(rawUniversal, { maxTexts });
    if (filtered.length === 0) {
      return NextResponse.json({ error: 'No text found in the HTML to rewrite' }, { status: 400 });
    }

    const texts = filtered.map((t) => ({
      original: t.original,
      tag: t.tag,
      position: t.position,
    }));

    const textsForAi = filtered.map((t, i) => ({
      id: i,
      text: t.original,
      tag: t.tag,
    }));

    console.log(
      `[quiz-rewrite] Extracted ${rawUniversal.length} raw -> ${filtered.length} marketing-safe texts`,
    );

    // IMPORTANTE: il brief del prodotto va nel SYSTEM prompt, non nello user message.
    // Così sopravvive al batching che il worker fa per non far esplodere il context
    // del modello locale: ogni batch ricrea SOLO il blocco "Testi da riscrivere
    // (JSON):" ma riusa l'intero system prompt → il prodotto è sempre presente.
    const productBrief = (productDescription || '').trim();
    const customNotes = (customPrompt || '').trim();
    const systemPrompt = `Sei Trinity, copywriter direct-response del Matrix Team. Riscrivi i testi marketing per UN prodotto specifico mantenendo tono, stile, lunghezza e struttura persuasiva del testo originale.

PRODOTTO: ${productName}
${productBrief ? `DESCRIZIONE/BRIEF PRODOTTO:\n${productBrief}\n` : ''}${customNotes ? `ISTRUZIONI EXTRA DELL'UTENTE:\n${customNotes}\n` : ''}
REGOLE OBBLIGATORIE:
1. Riscrivi OGNI testo per vendere ESATTAMENTE questo prodotto. Sostituisci nomi di prodotti competitor, tagline, benefici, prove sociali, autori e numeri specifici con quelli del prodotto qui sopra. Quando il dettaglio non è nel brief, usa formulazioni neutre ma sempre allineate al prodotto (mai inventare claim medici/legali).
2. Mantieni stessa LUNGHEZZA (±25%) e stessa "energia" (headline punchy → headline punchy, paragrafo → paragrafo, microcopy → microcopy).
3. Mantieni la stessa LINGUA del testo originale. Se l'originale è in italiano, scrivi italiano; se è in inglese, inglese; ecc.
4. NON aggiungere markdown, HTML, virgolette extra. Plain text puro per ogni "rewritten".
5. Se un testo è una CTA / button / etichetta breve, resta breve e punchy.
6. Testi legali/compliance: riscrivi solo se sicuro, altrimenti mantieni l'originale.
7. Per OGNI id ricevuto restituisci una voce {"id": N, "rewritten": "..."}. Non saltare mai un id, anche se cambia poco.
8. Restituisci SOLO un JSON array: [{"id": 0, "rewritten": "..."}, ...]. Niente preambolo, niente spiegazioni.`;

    const userMessage = `Riscrivi questi testi per il prodotto "${productName}".

Testi da riscrivere (JSON):
${JSON.stringify(textsForAi, null, 2)}

Riscrivi ogni testo per il prodotto ${productName}. Restituisci SOLO un JSON array nella forma [{"id": 0, "rewritten": "..."}, ...] con UNA voce per OGNI id sopra.`;

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
        // chat_history: HTML originale + lista testi (per applicare le rewrites
        // nello status route) + brief prodotto (per debugging / gap-fill).
        chat_history: {
          html,
          texts: texts.map((t) => ({ original: t.original, tag: t.tag })),
          productName,
          productDescription: productBrief,
          customPrompt: customNotes,
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
