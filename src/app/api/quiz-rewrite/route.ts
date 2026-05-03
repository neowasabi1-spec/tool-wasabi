import { NextRequest, NextResponse } from 'next/server';
import { extractAllTextsUniversal } from '@/lib/universal-text-extractor';
import { filterAndCap, DEFAULT_MAX_TEXTS } from '@/lib/swipe-text-filter';
import { requireAnthropicKey } from '@/lib/anthropic-key';

export const maxDuration = 26;
export const dynamic = 'force-dynamic';

interface CompetitorSignals {
  title: string;
  ogTitle: string;
  ogSiteName: string;
  domain: string;
  brandCandidates: string[];
}

function extractCompetitorSignals(html: string): CompetitorSignals {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
  const ogTitle = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] || '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
  const ogSiteName = (html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] || '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] || '';
  let domain = '';
  if (canonical) {
    try {
      domain = new URL(canonical).hostname.replace(/^www\./, '');
    } catch {
      // ignore
    }
  }

  // brand candidates: top frequent capitalized tokens (1-3 words, length 3-30)
  // limited to body text to avoid script/style noise.
  const bodyHtml = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ');
  const tokens: Record<string, number> = {};
  const blacklist = new Set([
    'The', 'This', 'That', 'And', 'Or', 'But', 'For', 'With', 'You', 'Your', 'Our',
    'Get', 'Try', 'New', 'Now', 'Top', 'How', 'Why', 'When', 'Where', 'What',
    'Home', 'Privacy', 'Terms', 'Policy', 'Service', 'About', 'Contact',
    'Click', 'Order', 'Shop', 'Buy', 'Price', 'Save', 'Free', 'Money',
    'Step', 'Help', 'More', 'Less', 'Best', 'Most', 'All', 'One', 'Two', 'Three',
    'Day', 'Days', 'Week', 'Weeks', 'Month', 'Months', 'Year', 'Years', 'Min', 'Mins',
  ]);
  const re = /\b([A-Z][a-zA-Z0-9]{2,29})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyHtml)) !== null) {
    const w = m[1];
    if (blacklist.has(w)) continue;
    if (/^[A-Z]+$/.test(w) && w.length > 8) continue; // skip ALLCAPS lunghi (sezioni)
    tokens[w] = (tokens[w] || 0) + 1;
  }
  const brandCandidates = Object.entries(tokens)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);

  return { title, ogTitle, ogSiteName, domain, brandCandidates };
}

interface FactBox {
  productName: string;
  oneLiner: string;
  mechanism: string;
  durationOrFormat: string;
  primaryAvatar: string;
  topPainPoints: string[];
  topBenefits: string[];
  expertOrAuthor: string;
  priceAndOffer: string;
  guarantee: string;
  bonuses: string[];
  numericFacts: string[];
}

async function callAnthropicJSON(system: string, user: string, timeoutMs: number): Promise<string> {
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
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errBody.substring(0, 200)}`);
  }
  const data = (await res.json()) as { content?: Array<{ text?: string }> };
  return data.content?.[0]?.text || '';
}

async function buildFactBox(productName: string, brief: string): Promise<FactBox | null> {
  if (!brief || brief.length < 200) return null;
  const sys = `Sei un assistente che estrae da un brief di marketing un FACT BOX strutturato in JSON.
Restituisci SOLO un oggetto JSON valido (niente markdown, niente preambolo) con queste chiavi (stringhe brevi, italiano se il brief e in italiano, inglese altrimenti):
{
  "productName": "...",
  "oneLiner": "una frase che sintetizza cos'e il prodotto",
  "mechanism": "il meccanismo / come funziona in 1-2 frasi",
  "durationOrFormat": "es. '8 minuti al giorno', 'pillola quotidiana', '60 giorni di programma'",
  "primaryAvatar": "chi e l'avatar principale",
  "topPainPoints": ["dolore 1", "dolore 2", "dolore 3"],
  "topBenefits": ["beneficio 1", "beneficio 2", "beneficio 3"],
  "expertOrAuthor": "nome e credenziali se presenti, altrimenti ''",
  "priceAndOffer": "prezzo + struttura offerta in 1 frase",
  "guarantee": "garanzia in 1 frase",
  "bonuses": ["bonus 1", "bonus 2"],
  "numericFacts": ["fatti numerici chiave: 8 minuti, 90 giorni, $39, ecc."]
}
Se un campo non e nel brief, lascia stringa vuota o array vuoto. NIENTE invenzione.`;
  const user = `PRODOTTO: ${productName}\n\nBRIEF:\n${brief}\n\nRestituisci il JSON.`;
  try {
    const raw = await callAnthropicJSON(sys, user, 18_000);
    let cleaned = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    const a = cleaned.indexOf('{');
    const b = cleaned.lastIndexOf('}');
    if (a >= 0 && b > a) cleaned = cleaned.substring(a, b + 1);
    const parsed = JSON.parse(cleaned) as FactBox;
    return parsed;
  } catch (e) {
    console.error('[quiz-rewrite/init] FactBox extraction failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

function renderFactBox(fb: FactBox): string {
  const list = (a: string[] | undefined) => (a && a.length ? a.map((x) => `  - ${x}`).join('\n') : '  (nessuno)');
  return `=== FACT BOX PRODOTTO TARGET (USARE COME FONTE DI VERITA' NELLA RISCRITTURA) ===
- Nome: ${fb.productName || '(da brief)'}
- One-liner: ${fb.oneLiner || ''}
- Meccanismo: ${fb.mechanism || ''}
- Durata/Formato: ${fb.durationOrFormat || ''}
- Avatar primario: ${fb.primaryAvatar || ''}
- Top pain points:
${list(fb.topPainPoints)}
- Top benefici:
${list(fb.topBenefits)}
- Expert/Autore: ${fb.expertOrAuthor || ''}
- Prezzo & Offerta: ${fb.priceAndOffer || ''}
- Garanzia: ${fb.guarantee || ''}
- Bonus:
${list(fb.bonuses)}
- Fatti numerici:
${list(fb.numericFacts)}`;
}

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

    // Estrai segnali del competitor dall'HTML clonato (brand da NON lasciare invariato)
    const signals = extractCompetitorSignals(html);
    console.log(
      `[quiz-rewrite/init] competitor signals title="${signals.title}" og="${signals.ogTitle}" site="${signals.ogSiteName}" domain="${signals.domain}" brands=${signals.brandCandidates.join(',')}`,
    );

    // Pre-genera FACT BOX strutturato dal brief (1 sola call, ~5-15s).
    // Senza FactBox il brief verboso veniva ignorato sui dettagli specifici.
    let factBox: FactBox | null = null;
    if (productBrief.length >= 200) {
      console.log(`[quiz-rewrite/init] Building FactBox from brief (${productBrief.length} chars)...`);
      const t0 = Date.now();
      factBox = await buildFactBox(productName, productBrief);
      console.log(`[quiz-rewrite/init] FactBox built in ${Date.now() - t0}ms`, factBox ? '(ok)' : '(failed, fallback to raw brief)');
    }

    const competitorSection = `=== COMPETITOR DA NEUTRALIZZARE (questi sono nomi/brand/persone/segnali del prodotto ORIGINALE che NON DEVONO MAI restare invariati) ===
- Page title: "${signals.title}"
- og:title: "${signals.ogTitle}"
- og:site_name: "${signals.ogSiteName}"
- Dominio: "${signals.domain}"
- Brand/nomi propri ricorrenti: ${signals.brandCandidates.length ? signals.brandCandidates.join(', ') : '(nessuno rilevato)'}

REGOLA FERREA: ogni occorrenza di questi termini (anche varianti maiuscole/minuscole/plurali/possessivi) DEVE essere sostituita con il nome del prodotto target o con un riferimento al meccanismo/benefit del prodotto target. Mai lasciare il brand del competitor nel testo riscritto.`;

    const factBoxSection = factBox ? `${renderFactBox(factBox)}\n` : '';
    const briefSection = productBrief
      ? `=== BRIEF INTEGRALE (riferimento per dettagli, tono, avatar, claims) ===\n${productBrief}\n`
      : '';
    const notesSection = customNotes ? `=== ISTRUZIONI EXTRA DELL'UTENTE ===\n${customNotes}\n` : '';

    const systemPrompt = `Sei Trinity, copywriter direct-response del Matrix Team. Il tuo compito e' UNICO: riscrivere i testi di una pagina di vendita di un competitor perche vendano ESCLUSIVAMENTE il PRODOTTO TARGET. Non stai "adattando" — stai SOSTITUENDO la materia prima copy del competitor con quella del prodotto target.

PRODOTTO TARGET: ${productName}

${competitorSection}

${factBoxSection}${briefSection}${notesSection}=== REGOLE OBBLIGATORIE ===

1. **NON LASCIARE MAI IL TESTO ORIGINALE INVARIATO.** Ogni "rewritten" deve essere semanticamente diverso dall'"text" che ricevi e PARLARE DEL PRODOTTO TARGET. Se sembra "neutrale" o "tecnico", riformulalo comunque agganciandolo al meccanismo/avatar/promessa del prodotto target.

2. **SOSTITUZIONE OBBLIGATORIA DI BRAND, NUMERI, DURATE, PREZZI, EXPERT, GEO DEL COMPETITOR**:
   - Brand/nome del competitor (vedi lista sopra) -> sostituisci con "${productName}" o variante adatta al contesto.
   - Numeri specifici (es. "15-Min", "30 days", "$49", "%20"): sostituisci con i corrispettivi del FACT BOX ("Durata/Formato", "Prezzo & Offerta", "Fatti numerici"). Se il fact non e' nel brief, ometti il numero e usa una formulazione generica coerente col prodotto target.
   - Nome di expert/dottore/autore citato: sostituisci con quello del FACT BOX ("Expert/Autore"). Se non c'e', usa formulazione generica ("uno dei principali esperti...").
   - Citta'/luoghi/zone: sostituisci con un'altra citta' coerente con l'avatar del prodotto target.

3. **ESEMPIO** (pagina del competitor "Nooro Foot Massager 15-Min"):
   - Originale: "BREAKTHROUGH: Nooro Foot Massager is SELLING OUT faster than expected!"
   - CATTIVO (lascia brand/numero competitor): "BREAKTHROUGH: Nooro Foot Massager is SELLING OUT..."
   - BUONO (sostituisce brand): "BREAKTHROUGH: ${productName} sta esaurendo le scorte piu' velocemente del previsto!"
   - Originale: "Try This 15-Min Electric Massage If Your Feet Roll Inward"
   - CATTIVO: "Try This 15-Min Electric Massage If Your Metabolism Slows Down" (numero del competitor sopravvive!)
   - BUONO: "Prova questo protocollo da [DURATA-FACT-BOX] di ${productName} se il tuo metabolismo rallenta"

4. Mantieni LUNGHEZZA simile (+/-25%) e stessa "energia" (headline punchy -> headline punchy, paragrafo -> paragrafo, microcopy -> microcopy).

5. Mantieni la stessa LINGUA del testo originale (italiano resta italiano, inglese resta inglese). Eccezione: se il prodotto target e' italiano e l'originale e' inglese, riscrivi nella lingua del prodotto target (verra' specificato altrove se serve).

6. NO markdown, NO HTML, NO virgolette extra. Plain text puro nel campo "rewritten".

7. CTA / button / etichette brevi: restano brevi e punchy ma orientate al prodotto target.

8. Testi LEGALI/COMPLIANCE (privacy, terms, copyright, refund policy): qui SI puoi mantenere l'originale o adattarlo minimamente - unica eccezione alla regola #1.

9. Per OGNI id ricevuto produci una voce {"id": N, "rewritten": "..."}. Mai saltare un id.

10. Restituisci SOLO un JSON array: [{"id": 0, "rewritten": "..."}, ...]. Niente preambolo, niente spiegazioni, niente markdown fences.`;

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
          competitorSignals: signals,
          factBox,
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
