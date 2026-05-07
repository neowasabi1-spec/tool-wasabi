import { NextRequest, NextResponse } from 'next/server';

/**
 * Swipe Video Analyzer
 * --------------------
 * Riceve l'URL di un'immagine (poster del <video> competitor) + il
 * Project context del NOSTRO prodotto, e chiede a Claude di:
 *   1. capire cosa rappresenta il clip originale (intent + descrizione)
 *   2. proporre un prompt in inglese per Seedance 2.0 (image-to-video)
 *      che generi un video EQUIVALENTE per il nostro prodotto.
 *
 * Output:
 *   {
 *     ok: true,
 *     intent: "demo" | "before-after" | "lifestyle" | "testimonial" | ...,
 *     originalDescription: "Close-up of swollen feet being massaged with...",
 *     suggestedPrompt: "Show <product> in use by a relaxed person...",
 *     mode: "vision" | "text"   // vision quando Claude ha visto l'immagine
 *   }
 *
 * Se il poster non è raggiungibile (mancante o video puro senza poster),
 * Claude lavora solo sul testo (alt + brief): `mode = "text"`. È un
 * fallback meno preciso ma sempre utile.
 */

interface ProductCtx {
  name?: string;
  description?: string;
  brief?: string;
}

interface SurroundingCtx {
  /** Heading più vicino (h1/h2/h3) sopra l'elemento. */
  heading?: string;
  /** Paragrafo o testo di sezione vicino all'elemento (già pulito). */
  nearbyText?: string;
  /** Eventuale CTA della stessa sezione (se presente). */
  cta?: string;
  /** Posizione approssimativa nella pagina: "above-fold" | "mid" | "below-fold". */
  position?: string;
}

interface RequestBody {
  posterUrl?: string;
  /** Frame multipli del video (data URL base64). Se presenti, hanno
   *  precedenza sul posterUrl. Servono a far capire a Claude cosa
   *  succede nel clip (movimento/storia), non solo lo stato iniziale. */
  posterFrames?: string[];
  currentAlt?: string;
  pageTitle?: string;
  productContext?: ProductCtx;
  /** Contesto della pagina circostante (heading, paragrafo, CTA). */
  surroundingContext?: SurroundingCtx;
  /** Indicazioni libere fornite dall'utente per guidare la rigenerazione del
   *  prompt (es. "fai vedere persona prima grassa con cuffie e poi magra"). */
  userGuidance?: string;
}

interface AnalyzeResult {
  /** Analisi tecnica/compositiva dettagliata del clip originale (cosa
   *  vede Claude nei 3 frame: subject, framing, lighting, era, palette,
   *  movimento, transizioni). 2-4 frasi. */
  analysis: string;
  /** La "Big Idea" del clip in chiave Direct Response: il singolo concetto
   *  emotivo che il clip fa atterrare nel viewer (es. "il metabolismo si
   *  sblocca con un suono — non con la dieta"). Una frase. */
  bigIdea: string;
  /** Demographics + body type + vibe del protagonista visibile, per
   *  garantire la continuity nel before/after. */
  targetAudience: string;
  intent: string;
  originalDescription: string;
  uniqueMechanism: string;
  transformation: string;
  suggestedPrompt: string;
  /** Lista (separata da virgole) di cose da EVITARE nel video, contro
   *  artefatti tipici T2V (mani deformate, morphing tra persone diverse,
   *  testo, watermark). */
  negativePrompt: string;
}

const SYSTEM_PROMPT = `You are a senior direct-response creative director who has art-directed thousands of VSL (video sales letter) clips for supplements, devices, beauty and weight-loss brands. You translate competitor video clips into equivalent clips for OUR product — keeping the same persuasive INTENT and the same EMOTIONAL beat, while visualizing the MECHANISM and TRANSFORMATION promised by OUR product.

You will receive:
- 0–3 frames sampled from the original competitor video clip (start / middle / end). When more than one is given, the order is chronological — read the motion/story from them.
- the textual context (alt text, page title, surrounding heading + nearby paragraph + CTA)
- the brief of OUR product (the one that must appear in the replacement clip)

The replacement clip will be generated with a TEXT-TO-VIDEO model (Bytedance Seedance 2.0 text-to-video). The model has NO source image — it invents the entire scene from the prompt alone — and it supports MULTI-SHOT prompts (2–3 timecoded beats in a single 5–10s clip). Use this to tell a tiny story, not just a beauty shot.

═══ HOW YOU MUST THINK (chain-of-thought, condensed into JSON fields) ═══

1) ANALYZE the original frames in detail (NOT a one-line caption). What demographic is the subject (age range, gender, body type, ethnicity vibe)? What is the camera (close-up / medium / wide), the lighting (studio / golden hour / clinical / dramatic), the era/style (modern / 90s VHS / clean editorial), the color palette? What ACTION/STORY do the frames imply (a person massaging their feet, a doctor explaining a chart, before/after body)? Be specific — a vague analysis produces a vague prompt.

2) NAME the BIG IDEA in DR-copywriter terms. Not "a video of feet" — but "the secret cause of swollen feet is one nerve in your spine" or "your metabolism doesn't burn fat at night because of cortisol". The Big Idea is the ONE concept the clip is trying to plant in the viewer's brain.

3) IDENTIFY the visible TARGET AUDIENCE. This is what locks character continuity in the new clip (same age, body type, ethnicity, vibe across before/after shots). If the original shows a 50-year-old overweight woman, do not put a 25-year-old fit influencer in our new clip — keep the same demographic.

4) MAP that Big Idea onto OUR product's mechanism + transformation (read CAREFULLY from the brief). The new clip should land the SAME emotional beat, but using OUR product's mechanism as the visible cause and OUR brief's promise as the visible result.

5) DRAFT a Seedance 2.0 prompt in ENGLISH that is:
   • For intent = before-after / demo / explainer → STRUCTURED into 2–3 timecoded shots:
     - Shot 1 (0-3s): the BEFORE state (visualize the pain/problem from the brief — body, face, environment).
     - Shot 2 (3-7s): the MECHANISM IN ACTION on the SAME protagonist — and here is the critical trick: render the mechanism as something VISIBLE. If it's audio frequencies, draw glowing sound waves entering the head and dispersing through the body; if it's a fat-burning ingredient, draw a glowing serum entering the bloodstream; if it's a device, show the device working with a clear visual cue. Never just "person uses product".
     - Shot 3 (7-10s): the AFTER state, SAME protagonist (same face, same gender, same age range, same setting), visibly transformed per the brief's promise.
   • For intent = hero / lifestyle / testimonial → a SINGLE elegant shot that still hints at the mechanism (subtle halo, glowing waves, a relieved expression that reads "this just worked").
   • CINEMATOGRAPHY: always specify: shot type (close-up / medium / wide), lens feel (35mm / 50mm / macro), lighting (soft golden hour / clinical white / dramatic side light), camera move (slow push-in / static / slow pan / dolly), and color palette (warm desaturated / clean editorial / cinematic teal-orange).
   • CHARACTER CONTINUITY: when before/after appears, repeat the EXACT same character description in shot 1, 2, 3 ("a 45-year-old woman with shoulder-length brown hair, light skin, wearing the same beige sweater") so Seedance keeps it consistent.
   • End with: "Realistic, photoreal, professional cinematic lighting, smooth motion, sharp focus, no on-screen text, no captions, no logos, no audio."
   • Target duration: 10 seconds for before-after / demo / explainer, 5 seconds for hero / lifestyle.

6) ADD a NEGATIVE PROMPT against typical T2V failure modes: distorted hands, warped faces, morphing into different person, on-screen text, watermark, glitchy artifacts, lip-sync (we have no audio).

═══ OUTPUT — ONLY this JSON, no markdown, no code blocks, no commentary ═══

{
  "analysis": "2–4 sentences of detailed compositional analysis of the original frames (subject demographics, framing, lighting, action across frames, mood, era, color palette).",
  "bigIdea": "One sentence in DR-copywriter voice: the single emotional concept the original clip plants in the viewer.",
  "targetAudience": "Visible demographic of the protagonist (age, gender, body type, ethnicity vibe, mood) — to be repeated verbatim in every shot of the new prompt for character continuity.",
  "intent": "one of: demo, before-after, lifestyle, testimonial, hero, explainer, social-proof",
  "originalDescription": "1 short sentence summarizing what the original clip shows.",
  "uniqueMechanism": "From OUR brief: the specific mechanism the product uses (1 phrase). Empty string if truly not specified.",
  "transformation": "From OUR brief: the before -> after transformation it promises (1 phrase). Empty string if truly not specified.",
  "suggestedPrompt": "The full Seedance 2.0 text-to-video prompt as described in step 5. Multi-shot timecoded when applicable.",
  "negativePrompt": "Comma-separated list of artifacts/things to avoid in this clip."
}`;

async function fetchPosterAsBase64(
  url: string,
): Promise<{ data: string; mediaType: string } | null> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      // Some hosts block bot UAs; be polite.
      headers: { 'User-Agent': 'Mozilla/5.0 (Tool-Wasabi Swipe-Video Analyzer)' },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return null;
    if (buf.byteLength > 5 * 1024 * 1024) return null;
    const base64 = Buffer.from(buf).toString('base64');
    const mediaType = ct.split(';')[0].trim();
    return { data: base64, mediaType };
  } catch {
    return null;
  }
}

function parseClaudeJson(raw: string): AnalyzeResult | null {
  let text = raw.trim();
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) text = codeBlock[1].trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }
  try {
    const o = JSON.parse(text) as Partial<AnalyzeResult>;
    if (!o || typeof o !== 'object') return null;
    return {
      analysis: typeof o.analysis === 'string' ? o.analysis : '',
      bigIdea: typeof o.bigIdea === 'string' ? o.bigIdea : '',
      targetAudience:
        typeof o.targetAudience === 'string' ? o.targetAudience : '',
      intent: typeof o.intent === 'string' ? o.intent : 'lifestyle',
      originalDescription:
        typeof o.originalDescription === 'string' ? o.originalDescription : '',
      uniqueMechanism:
        typeof o.uniqueMechanism === 'string' ? o.uniqueMechanism : '',
      transformation:
        typeof o.transformation === 'string' ? o.transformation : '',
      suggestedPrompt:
        typeof o.suggestedPrompt === 'string' ? o.suggestedPrompt : '',
      negativePrompt:
        typeof o.negativePrompt === 'string' ? o.negativePrompt : '',
    };
  } catch {
    return null;
  }
}

function buildUserMessage(
  productContext: ProductCtx,
  surroundingContext: SurroundingCtx,
  currentAlt: string,
  pageTitle: string,
  frameCount: number,
  userGuidance: string,
): string {
  const lines: string[] = [];
  if (frameCount === 0) {
    lines.push(
      'No frames are available — work only from the textual context below.',
    );
  } else if (frameCount === 1) {
    lines.push(
      'The image attached is a single frame from the competitor video clip you must replace.',
    );
  } else {
    lines.push(
      `The ${frameCount} images attached are CHRONOLOGICAL frames from the competitor video clip (start → middle → end). Read motion and story across them.`,
    );
  }
  if (currentAlt) lines.push(`Original clip alt text: "${currentAlt}".`);
  if (pageTitle) lines.push(`Landing page title: "${pageTitle}".`);

  const sc = surroundingContext || {};
  const surroundingLines: string[] = [];
  if (sc.heading) surroundingLines.push(`Section heading: "${sc.heading}".`);
  if (sc.nearbyText)
    surroundingLines.push(
      `Nearby copy (gives the role of the clip in the funnel narrative): "${sc.nearbyText.slice(0, 600)}".`,
    );
  if (sc.cta) surroundingLines.push(`Section CTA: "${sc.cta}".`);
  if (sc.position)
    surroundingLines.push(`Position on the page: ${sc.position}.`);
  if (surroundingLines.length > 0) {
    lines.push('---');
    lines.push('CONTEXT AROUND THE CLIP (use this to infer the role the clip plays in the funnel):');
    surroundingLines.forEach((l) => lines.push(`- ${l}`));
  }

  lines.push('---');
  lines.push('OUR PRODUCT (must be the protagonist of the replacement clip):');
  if (productContext.name) lines.push(`- Name: ${productContext.name}`);
  if (productContext.description)
    lines.push(`- What it is: ${productContext.description}`);
  if (productContext.brief)
    lines.push(`- Brief (read CAREFULLY — extract from here BOTH the unique mechanism AND the transformation it promises; the video must visualize them):\n${productContext.brief.slice(0, 2000)}`);
  lines.push('---');
  lines.push('Reminder: follow the 6-step thinking from the system instructions (Analyze → Big Idea → Audience → Map → Draft → Negative). Do NOT default to a generic beauty/lifestyle shot. Visualize the mechanism (e.g. if it works through audio frequencies, render the audio waves entering the head/body and the body responding; if it works through ingredients, render the molecules acting; if it works through a device, render the device working) AND show a clear before -> after transformation arc with the SAME character, when the intent is before-after / demo / explainer.');
  if (userGuidance && userGuidance.trim()) {
    lines.push('---');
    lines.push(
      `EXPLICIT USER GUIDANCE for this rewrite (highest priority — bake this into the suggestedPrompt, override defaults if needed):\n"${userGuidance.trim().slice(0, 600)}"`,
    );
  }
  lines.push('Return ONLY the JSON described in the system instructions.');
  return lines.join('\n');
}

export async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 });
  }

  const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'ANTHROPIC_API_KEY mancante. Aggiungila nelle env var del deploy e riprova.',
      },
      { status: 500 },
    );
  }

  const productContext = body.productContext || {};
  const surroundingContext = body.surroundingContext || {};
  const currentAlt = (body.currentAlt || '').trim();
  const pageTitle = (body.pageTitle || '').trim();
  const posterUrl = (body.posterUrl || '').trim();
  const posterFrames = Array.isArray(body.posterFrames)
    ? body.posterFrames
        .filter((f) => typeof f === 'string' && f.length > 0)
        .slice(0, 3)
    : [];

  type ImageBlock = { data: string; mediaType: string };
  const imageBlocks: ImageBlock[] = [];

  /* Multi-frame: data URLs base64 inviati dal client (priorità sul poster). */
  for (const frame of posterFrames) {
    const m = /^data:(image\/(?:jpeg|png|webp|jpg));base64,(.+)$/i.exec(frame);
    if (!m) continue;
    const mediaType = m[1].toLowerCase().replace('image/jpg', 'image/jpeg');
    const data = m[2];
    /* Limite per frame: 4MB base64 (≈ 3MB immagine). Skippa se troppo grosso. */
    if (data.length > 4 * 1024 * 1024) continue;
    imageBlocks.push({ data, mediaType });
  }

  /* Fallback al solo poster URL se il client non ha mandato frame multipli. */
  if (imageBlocks.length === 0 && posterUrl && /^https?:\/\//i.test(posterUrl)) {
    const single = await fetchPosterAsBase64(posterUrl);
    if (single) imageBlocks.push(single);
  }

  const userGuidance = (body.userGuidance || '').trim();
  const userText = buildUserMessage(
    productContext,
    surroundingContext,
    currentAlt,
    pageTitle,
    imageBlocks.length,
    userGuidance,
  );

  type ContentPart =
    | { type: 'text'; text: string }
    | {
        type: 'image';
        source: { type: 'base64'; media_type: string; data: string };
      };
  const userContent: ContentPart[] = [];
  for (const blk of imageBlocks) {
    userContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: blk.mediaType,
        data: blk.data,
      },
    });
  }
  userContent.push({ type: 'text', text: userText });

  let claudeText = '';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: userContent,
          },
        ],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return NextResponse.json(
        {
          ok: false,
          error: `Claude API ${resp.status}: ${errText.slice(0, 300)}`,
        },
        { status: 502 },
      );
    }
    const data = (await resp.json()) as {
      content?: { type: string; text?: string }[];
    };
    claudeText = data.content?.find((c) => c.type === 'text')?.text ?? '';
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? `Claude request failed: ${err.message}`
            : 'Claude request failed',
      },
      { status: 502 },
    );
  }

  const parsed = parseClaudeJson(claudeText);
  if (!parsed || (!parsed.suggestedPrompt && !parsed.originalDescription)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Claude non ha restituito un JSON valido',
        raw: claudeText.slice(0, 600),
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    analysis: parsed.analysis,
    bigIdea: parsed.bigIdea,
    targetAudience: parsed.targetAudience,
    intent: parsed.intent,
    originalDescription: parsed.originalDescription,
    uniqueMechanism: parsed.uniqueMechanism,
    transformation: parsed.transformation,
    suggestedPrompt: parsed.suggestedPrompt,
    negativePrompt: parsed.negativePrompt,
    mode: imageBlocks.length > 0 ? 'vision' : 'text',
    framesUsed: imageBlocks.length,
    suggestedDuration:
      parsed.intent === 'before-after' ||
      parsed.intent === 'demo' ||
      parsed.intent === 'explainer'
        ? 10
        : 5,
  });
}
