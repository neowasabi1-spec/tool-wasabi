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

const SYSTEM_PROMPT = `You are a senior direct-response creative director who has art-directed thousands of VSL (video sales letter) clips for supplements, devices, beauty and weight-loss brands. You "swipe" a competitor's video clip and rebuild an EQUIVALENT clip for OUR product.

══ THE #1 RULE — FORMAT FIDELITY (read this first, it overrides everything else) ══
Your job is to REPRODUCE THE SAME KIND OF CLIP you actually observe, just with OUR product/offer/audience swapped in. So you MUST:
1. First DETECT the FORMAT / GENRE of the original clip. Examples: before/after transformation, product demo, mechanism/ingredient explainer, testimonial talking-head, raw UGC selfie clip, news / TV broadcast segment, documentary, newspaper / press-article style, lifestyle b-roll, hero beauty shot, unboxing, data/chart animation, street interview, expert/doctor to camera.
2. Then build a prompt that recreates THAT SAME FORMAT for our product — same tone, framing, era, energy and storytelling device.
DO NOT default to a "before/after" or to a glowing-mechanism beauty shot. Use a before→after arc ONLY when the original is genuinely a before/after. If the original is a newspaper/press piece, produce a press-style clip about our product. If it's a news segment, produce a news segment. If it's a testimonial, produce a testimonial. If it's a raw UGC selfie, produce a raw UGC selfie. The output must be a faithful SWIPE of what you saw — not a different format.

You will receive:
- 0–3 frames sampled from the original competitor video clip (start / middle / end). When more than one is given, the order is chronological — read the motion/story from them.
- the textual context (alt text, page title, surrounding heading + nearby paragraph + CTA)
- the brief of OUR product (the one that must appear in the replacement clip)

The replacement clip will be generated with a TEXT-TO-VIDEO model (Bytedance Seedance 2.0 text-to-video). The model has NO source image — it invents the entire scene from the prompt alone — and it supports MULTI-SHOT prompts (2–3 timecoded beats in a single 5–10s clip). Use multiple shots when the original tells a tiny story; use a single continuous shot when the original is a single shot.

═══ HOW YOU MUST THINK (chain-of-thought, condensed into JSON fields) ═══

1) ANALYZE the original frames in detail (NOT a one-line caption). FIRST state the format/genre. Then: what demographic is the subject (age range, gender, body type, ethnicity vibe)? Camera (close-up / medium / wide), lighting (studio / golden hour / clinical / dramatic), era/style (modern / 90s VHS / clean editorial / broadcast / handheld UGC), color palette, and the ACTION/STORY the frames imply. Be specific — a vague analysis produces a vague prompt.

2) NAME the BIG IDEA in DR-copywriter terms. Not "a video of feet" — but "the secret cause of swollen feet is one nerve in your spine". The Big Idea is the ONE concept the clip plants in the viewer's brain.

3) IDENTIFY the visible TARGET AUDIENCE. This locks character continuity (same age, body type, ethnicity, vibe). Keep the same demographic in the new clip.

4) MAP that Big Idea onto OUR product (read the brief CAREFULLY). Keep the SAME emotional beat AND the SAME FORMAT detected in step 1, swapping in our product, offer and audience.

5) DRAFT a Seedance 2.0 prompt in ENGLISH that recreates the ORIGINAL'S FORMAT:
   • before-after / demo / transformation → 2–3 timecoded shots (BEFORE state → mechanism visibly in action on the SAME protagonist → AFTER state, same character repeated verbatim). Render the mechanism as something visible (glowing sound waves, serum in bloodstream, device working) instead of "person uses product".
   • explainer / chart / ingredient → recreate that visual explainer style (cross-section, animated diagram, ingredient acting) — only if the original was an explainer.
   • testimonial / interview / expert-to-camera → one believable person to camera in a matching setting and vibe, delivering the same kind of beat (no audio — just framing and expression).
   • news-segment / press-article → recreate the broadcast/editorial look (anchor desk, B-roll, newspaper/editorial framing) about our product's story, WITHOUT readable on-screen text.
   • ugc / selfie → handheld, vertical-feel, natural light, authentic non-polished vibe.
   • lifestyle / hero → a single elegant shot in the original's style.
   Only hint at the product mechanism when it fits that format naturally — never shoehorn glowing waves into a news segment or a testimonial.
   • CINEMATOGRAPHY: always specify shot type (close-up / medium / wide), lens feel (35mm / 50mm / macro), lighting, camera move (slow push-in / static / slow pan / dolly / handheld), and color palette — matched to the ORIGINAL's look.
   • CHARACTER CONTINUITY: when the same person must appear in multiple shots, repeat the EXACT same character description each time ("a 45-year-old woman with shoulder-length brown hair, light skin, wearing the same beige sweater").
   • End with: "Realistic, photoreal, professional cinematic lighting, smooth motion, sharp focus, no on-screen text, no captions, no logos, no audio."
   • Target duration: 10 seconds for multi-shot stories (before-after / demo / explainer), 5 seconds for single-shot formats (testimonial / ugc / hero / lifestyle / news beat).

6) ADD a NEGATIVE PROMPT against typical T2V failure modes: distorted hands, warped faces, morphing into different person, on-screen text, watermark, glitchy artifacts, lip-sync (we have no audio).

═══ OUTPUT — ONLY this JSON, no markdown, no code blocks, no commentary ═══

{
  "analysis": "2–4 sentences. START by naming the format/genre of the original, then detailed compositional analysis (subject demographics, framing, lighting, action across frames, mood, era, color palette).",
  "bigIdea": "One sentence in DR-copywriter voice: the single emotional concept the original clip plants in the viewer.",
  "targetAudience": "Visible demographic of the protagonist (age, gender, body type, ethnicity vibe, mood) — to be repeated verbatim across shots for character continuity.",
  "intent": "the detected format — one of: before-after, demo, explainer, testimonial, interview, news-segment, press-article, ugc, documentary, lifestyle, hero, unboxing, chart, social-proof",
  "originalDescription": "1 short sentence summarizing what the original clip shows.",
  "uniqueMechanism": "From OUR brief: the specific mechanism the product uses (1 phrase). Empty string if not specified or if the format does not call for showing a mechanism.",
  "transformation": "From OUR brief: the before -> after transformation it promises (1 phrase). Empty string if the format is not a before/after.",
  "suggestedPrompt": "The full Seedance 2.0 text-to-video prompt as described in step 5, faithful to the ORIGINAL's format. Multi-shot timecoded only when the format calls for it.",
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
  lines.push('Reminder: FORMAT FIDELITY first. Identify the format/genre of the original clip and REPRODUCE THAT SAME FORMAT for our product (e.g. if it is a newspaper/press piece, a news segment, a testimonial, a UGC selfie, a demo, a before/after — recreate that exact kind of clip). Do NOT default to a before/after or to a generic glowing-mechanism beauty shot. Use a before -> after arc with the SAME character ONLY if the original is genuinely a before/after. Keep the same tone, framing, era and energy you observed, swapping in our product, audience and offer. Then follow the 6-step thinking (Analyze → Big Idea → Audience → Map → Draft → Negative).');
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
        model: 'claude-opus-4-8',
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
