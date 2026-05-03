import { NextRequest, NextResponse } from 'next/server';
import { extractAllTextsUniversal } from '@/lib/universal-text-extractor';
import { filterAndCap, DEFAULT_MAX_TEXTS } from '@/lib/swipe-text-filter';
import { requireAnthropicKey } from '@/lib/anthropic-key';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const REWRITE_BATCH_SIZE = Math.max(
  8,
  Math.min(40, Number.parseInt(process.env.QUIZ_REWRITE_BATCH_SIZE || '28', 10) || 28),
);
const REWRITE_GAP_FILL_PASSES = Math.max(
  0,
  Math.min(6, Number.parseInt(process.env.QUIZ_REWRITE_GAP_FILL || '2', 10) || 2),
);

function cleanAiOutput(text: string): string {
  let cleaned = text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const a = cleaned.indexOf('[');
  const b = cleaned.lastIndexOf(']');
  if (a >= 0 && b > a) cleaned = cleaned.substring(a, b + 1);
  return cleaned.trim();
}

async function callAnthropic(systemPrompt: string, userPrompt: string): Promise<string> {
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
    const errBody = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errBody.substring(0, 300)}`);
  }
  const data = (await res.json()) as { content?: Array<{ text?: string }> };
  return data.content?.[0]?.text || '';
}

async function rewriteBatch(
  systemPrompt: string,
  batch: Array<{ id: number; text: string; tag: string }>,
  label: string,
): Promise<Array<{ id: number; rewritten: string }>> {
  if (batch.length === 0) return [];
  const userPrompt = `${label}: produci ESATTAMENTE una voce JSON {"id","rewritten"} per ognuno dei ${batch.length} id qui sotto. Mai saltare un id, mai restituire l'originale identico (eccezione: copy legale/compliance).

${JSON.stringify(batch, null, 2)}

Output: SOLO un JSON array nella forma [{"id": 0, "rewritten": "..."}, ...]. Niente preambolo, niente spiegazioni, niente markdown fences.`;
  const aiText = await callAnthropic(systemPrompt, userPrompt);
  if (!aiText.trim()) throw new Error('Empty batch response from Anthropic');
  const cleaned = cleanAiOutput(aiText);
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('Anthropic batch: expected JSON array');
  return parsed as Array<{ id: number; rewritten: string }>;
}

async function collectAllRewrites(
  systemPrompt: string,
  textsForAi: Array<{ id: number; text: string; tag: string }>,
): Promise<Map<number, string>> {
  const idToOriginal = new Map<number, string>();
  for (const t of textsForAi) idToOriginal.set(t.id, t.text);
  const idToRewrite = new Map<number, string>();
  const totalBatches = Math.ceil(textsForAi.length / REWRITE_BATCH_SIZE);

  for (let i = 0; i < textsForAi.length; i += REWRITE_BATCH_SIZE) {
    const slice = textsForAi.slice(i, i + REWRITE_BATCH_SIZE);
    const idx = Math.floor(i / REWRITE_BATCH_SIZE) + 1;
    try {
      const rewrites = await rewriteBatch(systemPrompt, slice, `Batch ${idx}/${totalBatches}`);
      for (const rw of rewrites) {
        if (typeof rw.id !== 'number' || typeof rw.rewritten !== 'string') continue;
        const trimmed = rw.rewritten.trim();
        if (!trimmed) continue;
        const orig = idToOriginal.get(rw.id);
        // anti-echo: se claude rispedisce identico l'originale per un testo lungo,
        // lo lasciamo "missing" così entra nel gap-fill aggressivo.
        if (orig && trimmed === orig && orig.length > 20) continue;
        idToRewrite.set(rw.id, trimmed);
      }
    } catch (e) {
      console.error(`[quiz-rewrite] batch ${idx} failed:`, e instanceof Error ? e.message : e);
    }
  }

  for (let pass = 1; pass <= REWRITE_GAP_FILL_PASSES; pass++) {
    const missing = textsForAi.filter((t) => !idToRewrite.has(t.id));
    if (missing.length === 0) break;
    console.log(`[quiz-rewrite] Gap-fill p${pass}: ${missing.length} testi mancanti`);
    const fillSize = Math.max(8, Math.floor(REWRITE_BATCH_SIZE / 2));
    for (let j = 0; j < missing.length; j += fillSize) {
      const slice = missing.slice(j, j + fillSize);
      try {
        const rewrites = await rewriteBatch(
          systemPrompt,
          slice,
          `GAP-FILL p${pass} - return ONLY ids [${slice.map((s) => s.id).join(', ')}]; ogni id obbligatorio, niente echo, adatta sempre al prodotto target`,
        );
        for (const rw of rewrites) {
          if (typeof rw.id !== 'number' || typeof rw.rewritten !== 'string') continue;
          const trimmed = rw.rewritten.trim();
          if (!trimmed) continue;
          // ultimo pass: accettiamo anche output identico per chiudere il job
          idToRewrite.set(rw.id, trimmed);
        }
      } catch (e) {
        console.error(`[quiz-rewrite] gap-fill p${pass} failed:`, e instanceof Error ? e.message : e);
      }
    }
  }

  return idToRewrite;
}

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

    console.log(
      `[quiz-rewrite] Extracted ${rawUniversal.length} raw -> ${filtered.length} marketing-safe texts`,
    );

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

    const aiBudgetMs = Math.max(
      60_000,
      Math.min(280_000, Number.parseInt(process.env.QUIZ_REWRITE_AI_BUDGET_MS || '260000', 10) || 260_000),
    );

    let idToRewrite: Map<number, string>;
    try {
      console.log(
        `[quiz-rewrite] Anthropic batched rewrite, texts=${textsForAi.length}, batch=${REWRITE_BATCH_SIZE}`,
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`AI budget exceeded (${aiBudgetMs}ms)`)), aiBudgetMs);
      });
      idToRewrite = (await Promise.race([
        collectAllRewrites(systemPrompt, textsForAi),
        timeoutPromise,
      ])) as Map<number, string>;
    } catch (e) {
      console.error('[quiz-rewrite] Anthropic loop failed:', e instanceof Error ? e.message : e);
      return NextResponse.json(
        { error: `Anthropic rewrite failed: ${e instanceof Error ? e.message : 'unknown'}` },
        { status: 502 },
      );
    }

    const rewritesArray: Array<{ id: number; rewritten: string }> = [];
    for (const [id, rewritten] of idToRewrite) rewritesArray.push({ id, rewritten });
    const unresolvedIds = textsForAi.filter((t) => !idToRewrite.has(t.id)).map((t) => t.id);

    const responseJson = JSON.stringify(rewritesArray);

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/openclaw_messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        user_message: `Riscrivi questi testi per il prodotto "${productName}".`,
        system_prompt: systemPrompt,
        section: 'Rewrite',
        status: 'completed',
        response: responseJson,
        completed_at: new Date().toISOString(),
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
        { error: `Failed to store rewrite job: ${errText.substring(0, 200)}` },
        { status: 500 },
      );
    }

    const [inserted] = (await insertRes.json()) as Array<{ id: string }>;
    if (!inserted?.id) {
      return NextResponse.json({ error: 'No job ID returned from Supabase' }, { status: 500 });
    }

    console.log(
      `[quiz-rewrite] Done: ${rewritesArray.length}/${textsForAi.length} rewrites, ${unresolvedIds.length} unresolved, jobId=${inserted.id}`,
    );

    return NextResponse.json({
      jobId: inserted.id,
      status: 'completed',
      totalTexts: textsForAi.length,
      replacements: rewritesArray.length,
      unresolved_text_ids: unresolvedIds,
      coverage_ratio: textsForAi.length ? rewritesArray.length / textsForAi.length : 0,
      provider: 'anthropic-batched',
      message: 'Rewrite completed. Poll /api/quiz-rewrite/status/' + inserted.id,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[quiz-rewrite] Error:', errMsg);
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
