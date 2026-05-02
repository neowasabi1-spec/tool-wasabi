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
    const systemPrompt = `Sei Trinity, copywriter direct-response del Matrix Team. Il tuo unico compito: riscrivere i testi di una pagina di vendita perché vendano ESCLUSIVAMENTE il prodotto qui sotto, non quello del competitor da cui i testi sono stati estratti.

PRODOTTO TARGET: ${productName}
${productBrief ? `BRIEF PRODOTTO (usa SEMPRE per facts/angoli/benefici/prove/avatar):\n${productBrief}\n` : ''}${customNotes ? `ISTRUZIONI EXTRA DELL'UTENTE:\n${customNotes}\n` : ''}
REGOLA #1 (CRITICA): NON RESTITUIRE MAI IL TESTO ORIGINALE INVARIATO.
Ogni "rewritten" DEVE essere semanticamente diverso dall'"text" che ricevi. Se senti la tentazione di copiare l'originale (perché è "neutrale" o "tecnico"), NON FARLO. Adatta sempre al prodotto target — se il dettaglio specifico non è nel brief, riformulalo in modo neutro ma con un angle coerente con ${productName}. Testi tecnici, anatomici, scientifici del competitor (es. "tibialis posterior muscle") vanno rimpiazzati con la metafora/elemento equivalente del nostro prodotto (es. il meccanismo del nostro prodotto descritto nel brief).

ALTRE REGOLE:
2. Sostituisci OGNI riferimento al prodotto/azienda/autore/numeri/promesse del competitor con i corrispettivi del prodotto target. Mai citare o lasciare brand/persone del competitor.
3. Mantieni LUNGHEZZA (±25%) e stessa "energia" (headline punchy → headline punchy, paragrafo → paragrafo, microcopy → microcopy).
4. Mantieni la stessa LINGUA del testo originale (italiano resta italiano, inglese resta inglese).
5. NO markdown, NO HTML, NO virgolette extra. Plain text puro per ogni "rewritten".
6. CTA / button / etichette brevi: restano brevi e punchy ma orientate al prodotto target.
7. Testi LEGALI/COMPLIANCE (privacy, terms, copyright, refund policy): qui SÌ puoi mantenere l'originale o adattarlo minimamente — è l'unica eccezione alla regola #1.
8. Per OGNI id ricevuto produci una voce {"id": N, "rewritten": "..."}. Mai saltare un id.
9. Restituisci SOLO un JSON array: [{"id": 0, "rewritten": "..."}, ...]. Niente preambolo, niente spiegazioni, niente markdown fences.`;

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
