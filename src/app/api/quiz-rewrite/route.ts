import { NextRequest, NextResponse } from 'next/server';
import { extractAllTextsUniversal } from '@/lib/universal-text-extractor';
import { filterAndCap, DEFAULT_MAX_TEXTS } from '@/lib/swipe-text-filter';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const REWRITE_BATCH_SIZE = Math.max(
  8,
  Math.min(40, Number.parseInt(process.env.QUIZ_REWRITE_BATCH_SIZE || '24', 10) || 24),
);

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
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

    const productBrief = (productDescription || '').trim();
    const customNotes = (customPrompt || '').trim();
    const briefSection = productBrief
      ? `BRIEF / OFFERTA / POSITIONING (USA SEMPRE per facts, angoli, benefici, prove sociali, avatar, prezzi, struttura offerta, garanzie, bonus):\n${productBrief}\n\n`
      : '';
    const notesSection = customNotes ? `ISTRUZIONI EXTRA DELL'UTENTE:\n${customNotes}\n\n` : '';

    const systemPrompt = `Sei Trinity, copywriter direct-response del Matrix Team. Riscrivi i testi di una pagina di vendita perche vendano ESCLUSIVAMENTE il prodotto qui sotto, NON il prodotto del competitor da cui i testi sono stati estratti.

PRODOTTO TARGET: ${productName}
${briefSection}${notesSection}REGOLE OBBLIGATORIE:
1. NON RESTITUIRE MAI IL TESTO ORIGINALE INVARIATO. Ogni "rewritten" deve essere semanticamente diverso dall'"text" che ricevi e PARLARE DEL PRODOTTO TARGET. Se senti la tentazione di copiare l'originale (perche e "neutrale" o "tecnico"), NON FARLO. Adatta sempre al prodotto: usa avatar, meccanismo, benefici, prove sociali, angoli e prezzi del brief sopra.
2. Sostituisci OGNI riferimento a brand/prodotto/azienda/autore/numeri/promesse del competitor con i corrispettivi del prodotto target. Mai citare brand o persone del competitor.
3. Mantieni LUNGHEZZA simile (+/-25%) e stessa "energia" (headline punchy -> headline punchy, paragrafo -> paragrafo, microcopy -> microcopy).
4. Mantieni la stessa LINGUA del testo originale (italiano resta italiano, inglese resta inglese).
5. NO markdown, NO HTML, NO virgolette extra. Plain text puro nel campo "rewritten".
6. CTA / button / etichette brevi: restano brevi e punchy ma orientate al prodotto target.
7. Testi LEGALI/COMPLIANCE (privacy, terms, copyright, refund policy): qui SI puoi mantenere l'originale o adattarlo minimamente - unica eccezione alla regola #1.
8. Per OGNI id ricevuto produci una voce {"id": N, "rewritten": "..."}. Mai saltare un id.
9. Restituisci SOLO un JSON array: [{"id": 0, "rewritten": "..."}, ...]. Niente preambolo, niente spiegazioni, niente markdown fences.`;

    const batches: Array<Array<{ id: number; text: string; tag: string }>> = [];
    for (let i = 0; i < textsForAi.length; i += REWRITE_BATCH_SIZE) {
      batches.push(textsForAi.slice(i, i + REWRITE_BATCH_SIZE));
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/openclaw_messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        user_message: `Rewrite ${textsForAi.length} testi (browser-orchestrated) per "${productName}".`,
        system_prompt: systemPrompt,
        section: 'Rewrite',
        status: 'pending',
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
      return NextResponse.json(
        { error: `Failed to enqueue rewrite job: ${errText.substring(0, 200)}` },
        { status: 500 },
      );
    }

    const [inserted] = (await insertRes.json()) as Array<{ id: string }>;
    if (!inserted?.id) {
      return NextResponse.json({ error: 'No job ID returned from Supabase' }, { status: 500 });
    }

    console.log(
      `[quiz-rewrite/init] job=${inserted.id} texts=${textsForAi.length} batches=${batches.length} batchSize=${REWRITE_BATCH_SIZE}`,
    );

    return NextResponse.json({
      jobId: inserted.id,
      status: 'pending',
      totalTexts: textsForAi.length,
      totalBatches: batches.length,
      batchSize: REWRITE_BATCH_SIZE,
      batches,
      systemPrompt,
      provider: 'anthropic-chunked',
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[quiz-rewrite/init] Error:', errMsg);
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
