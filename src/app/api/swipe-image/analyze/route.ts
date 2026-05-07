import { NextRequest, NextResponse } from 'next/server';

/**
 * Swipe Image Analyzer
 * --------------------
 * Riceve l'URL di un'immagine usata su una landing competitor + il
 * Project context del NOSTRO prodotto, e chiede a Claude di:
 *   1. capire cosa rappresenta l'immagine originale (intent + descrizione)
 *   2. proporre un prompt in inglese per un modello text-to-image
 *      (Nano Banana 2 / FLUX / GPT Image 2) che generi un'immagine
 *      EQUIVALENTE per il NOSTRO prodotto, mostrando il meccanismo
 *      unico e/o la trasformazione promessa dal brief — non un
 *      generico beauty shot.
 *
 * Output:
 *   {
 *     ok: true,
 *     intent: "hero" | "before-after" | "lifestyle" | "ingredient" |
 *             "diagram" | "testimonial" | "icon" | "chart" | "social-proof",
 *     originalDescription: "Close-up of swollen feet held in hands…",
 *     uniqueMechanism: "audio frequencies activate metabolic switch",
 *     transformation: "overweight -> slim",
 *     suggestedPrompt: "Photorealistic split-frame: left side <before>, right side <after>…",
 *     mode: "vision" | "text"   // vision quando Claude ha visto l'immagine
 *   }
 *
 * Se l'immagine non è raggiungibile, Claude lavora solo sul testo
 * (alt + brief): `mode = "text"`. Fallback meno preciso ma utile.
 */

interface ProductCtx {
  name?: string;
  description?: string;
  brief?: string;
}

interface SurroundingCtx {
  heading?: string;
  nearbyText?: string;
  cta?: string;
  position?: string;
}

interface RequestBody {
  imageUrl?: string;
  /** Data URL JPEG/PNG dell'immagine, estratta lato client. Se presente
   *  ha precedenza sul fetch lato server di `imageUrl` (utile quando il
   *  server non riesce a scaricare l'immagine per CORS, blocco UA, URL
   *  relativo non risolvibile, ecc.). Il browser ha sempre l'immagine
   *  in cache dal preview iframe, quindi questo fallback è molto più
   *  affidabile del fetch server-side. */
  imageDataUrl?: string;
  currentAlt?: string;
  pageTitle?: string;
  productContext?: ProductCtx;
  surroundingContext?: SurroundingCtx;
  /** Indicazioni libere fornite dall'utente per guidare la rigenerazione del
   *  prompt (es. "fai vedere persona prima grassa con cuffie e poi magra"). */
  userGuidance?: string;
}

interface AnalyzeResult {
  analysis: string;
  bigIdea: string;
  targetAudience: string;
  intent: string;
  originalDescription: string;
  uniqueMechanism: string;
  transformation: string;
  suggestedPrompt: string;
  negativePrompt: string;
}

const SYSTEM_PROMPT = `You are a senior direct-response creative director who has art-directed thousands of static landing-page images for supplements, devices, beauty and weight-loss brands. You translate competitor landing-page images into equivalent images for OUR product — keeping the same persuasive INTENT and the same EMOTIONAL beat, while visualizing the MECHANISM and TRANSFORMATION promised by OUR product.

You will receive:
- (optionally) a single image — the ORIGINAL image used on the competitor landing page
- the textual context (alt text, page title, surrounding heading + nearby paragraph + CTA)
- the brief of OUR product (must appear in the replacement image)

The replacement image will be generated with a TEXT-TO-IMAGE model (Nano Banana 2 / FLUX / Imagen / GPT Image). The model has NO source image — it invents the entire composition from the prompt alone — so describe the WHOLE composition (subject, setting, props, lighting, style, palette, framing).

═══ HOW YOU MUST THINK (chain-of-thought, condensed into JSON fields) ═══

1) ANALYZE the original in detail (NOT a one-line caption). What demographic is the subject (age range, gender, body type, ethnicity vibe)? What is the framing (close-up / medium / wide / split-frame)? Lighting (studio / golden hour / clinical / dramatic)? Era/style (photoreal / 3D / clean infographic / illustrated / 90s editorial)? Color palette? What is the visual hierarchy (where does the eye land)? Be specific — vague analysis produces vague prompts.

2) NAME the BIG IDEA in DR-copywriter terms. Not "a photo of a woman" — but "you can shrink belly fat just by listening to the right frequency" or "your gut is the real cause of joint pain". The Big Idea is the ONE concept the image is meant to plant in the viewer's brain.

3) IDENTIFY the visible TARGET AUDIENCE. Demographics + body type + vibe of the protagonist. This locks character continuity in before/after split-frames (same age/body/skin/hair across both halves).

4) MAP the Big Idea onto OUR product's mechanism + transformation (read CAREFULLY from the brief). The new image must land the SAME emotional beat but with OUR mechanism as visible cause and OUR brief's promise as visible result.

5) DRAFT a text-to-image prompt in ENGLISH that is:
   • For intent = before-after → a SPLIT-FRAME composition. Describe both halves explicitly:
     "Photorealistic split-frame, vertical split. LEFT HALF: <SAME character description: age/gender/body/skin/hair>, in <before state, the pain/problem from the brief>, identical framing and lighting to the right. RIGHT HALF: <SAME character — repeat the description verbatim>, after <transformation from the brief>, identical pose/framing/lighting; only the body and the expression change."
     Add a subtle visual cue of the mechanism between/around the two halves (e.g. glowing audio waves, a soft halo of energy, a delicate ingredient stream).
   • For intent = diagram / ingredient / chart → a clean infographic-style composition that VISUALIZES the mechanism (e.g. cross-section of the body with audio waves traveling from headphones to brain to belly fat dissolving; ingredient molecules acting on cell receptors; a labeled but minimal flow). Mention the art style explicitly (clean editorial vector / 3D render / cross-section illustration).
   • For intent = hero / lifestyle / testimonial → a single elegant photoreal composition that hints at the mechanism (subtle halo of audio waves, glow of energy, a confident transformed look that reads "this just worked").
   • For intent = icon / social-proof → a clean iconic composition (badge, ribbon, stars + faces) on the same background style as the original.
   • CINEMATOGRAPHY: always specify framing (close-up / medium / wide / split-frame), camera angle, lens feel (35mm / 85mm portrait / macro), lighting (soft beauty / clinical white / golden hour / cinematic side light), color palette (warm desaturated / clean editorial / cinematic teal-orange / pastel) and art style.
   • CHARACTER CONTINUITY: when same character must appear twice (before/after), repeat the EXACT same character description on both halves so the model keeps it consistent.
   • End with: "Photorealistic, sharp focus, professional studio lighting, clean composition, no on-image text, no competitor logos, no watermark."

6) ADD a NEGATIVE PROMPT against typical T2I failure modes: distorted hands, extra fingers, warped faces, two different people across the split-frame, on-image text, watermark, low resolution, artifacts.

═══ OUTPUT — ONLY this JSON, no markdown, no code blocks, no commentary ═══

{
  "analysis": "2–4 sentences of detailed compositional analysis of the original (subject demographics, framing, lighting, mood, era, palette, visual hierarchy).",
  "bigIdea": "One sentence in DR-copywriter voice: the single emotional concept the original image plants in the viewer.",
  "targetAudience": "Visible demographic of the protagonist (age, gender, body type, ethnicity vibe, mood) — to be repeated verbatim on both sides of a split-frame for continuity.",
  "intent": "one of: hero, before-after, lifestyle, ingredient, diagram, testimonial, icon, chart, social-proof",
  "originalDescription": "1 short sentence summarizing what the original image shows.",
  "uniqueMechanism": "From OUR brief: the specific mechanism the product uses (1 phrase). Empty string if truly not specified.",
  "transformation": "From OUR brief: the before -> after transformation it promises (1 phrase). Empty string if truly not specified.",
  "suggestedPrompt": "The full text-to-image prompt as described in step 5.",
  "negativePrompt": "Comma-separated list of artifacts/things to avoid in this image."
}`;

async function fetchImageAsBase64(
  url: string,
): Promise<{ data: string; mediaType: string } | null> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { 'User-Agent': 'Mozilla/5.0 (Tool-Wasabi Swipe-Image Analyzer)' },
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
      intent: typeof o.intent === 'string' ? o.intent : 'hero',
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
  hasImage: boolean,
  userGuidance: string,
): string {
  const lines: string[] = [];
  lines.push(
    hasImage
      ? 'The image attached is the ORIGINAL image used on the competitor landing page that you must replace.'
      : 'No image is available — work only from the textual context below.',
  );
  if (currentAlt) lines.push(`Original image alt text: "${currentAlt}".`);
  if (pageTitle) lines.push(`Landing page title: "${pageTitle}".`);

  const sc = surroundingContext || {};
  const surroundingLines: string[] = [];
  if (sc.heading) surroundingLines.push(`Section heading: "${sc.heading}".`);
  if (sc.nearbyText)
    surroundingLines.push(
      `Nearby copy (gives the role of the image in the funnel narrative): "${sc.nearbyText.slice(0, 600)}".`,
    );
  if (sc.cta) surroundingLines.push(`Section CTA: "${sc.cta}".`);
  if (sc.position)
    surroundingLines.push(`Position on the page: ${sc.position}.`);
  if (surroundingLines.length > 0) {
    lines.push('---');
    lines.push('CONTEXT AROUND THE IMAGE (use this to infer the role the image plays in the funnel):');
    surroundingLines.forEach((l) => lines.push(`- ${l}`));
  }

  lines.push('---');
  lines.push('OUR PRODUCT (must be the protagonist of the replacement image):');
  if (productContext.name) lines.push(`- Name: ${productContext.name}`);
  if (productContext.description)
    lines.push(`- What it is: ${productContext.description}`);
  if (productContext.brief)
    lines.push(`- Brief (read CAREFULLY — extract from here BOTH the unique mechanism AND the transformation it promises; the image must visualize them):\n${productContext.brief.slice(0, 2000)}`);
  lines.push('---');
  lines.push('Reminder: follow the 6-step thinking from the system instructions (Analyze → Big Idea → Audience → Map → Draft → Negative). Do NOT default to a generic beauty/lifestyle photo with our packshot floating in the air. Visualize the mechanism (audio waves, ingredient stream, device cross-section, glow of energy) AND for before/after intents force a SPLIT-FRAME with the SAME character description repeated on both halves.');
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
  const imageUrl = (body.imageUrl || '').trim();
  const imageDataUrl = (body.imageDataUrl || '').trim();

  let imageBlock: {
    data: string;
    mediaType: string;
  } | null = null;

  /* Priorità 1: data URL inviata dal client (più affidabile, bypassa CORS). */
  if (imageDataUrl) {
    const m = /^data:(image\/(?:jpeg|png|webp|jpg));base64,(.+)$/i.exec(imageDataUrl);
    if (m) {
      const mediaType = m[1].toLowerCase().replace('image/jpg', 'image/jpeg');
      const data = m[2];
      /* Limit: 5MB base64 (~ 3.7MB di immagine). */
      if (data.length > 0 && data.length <= 5 * 1024 * 1024) {
        imageBlock = { data, mediaType };
      }
    }
  }

  /* Priorità 2: fetch via URL (fallback se il client non ha estratto la data URL). */
  if (!imageBlock && imageUrl && /^https?:\/\//i.test(imageUrl)) {
    imageBlock = await fetchImageAsBase64(imageUrl);
  }

  const userGuidance = (body.userGuidance || '').trim();
  const userText = buildUserMessage(
    productContext,
    surroundingContext,
    currentAlt,
    pageTitle,
    Boolean(imageBlock),
    userGuidance,
  );

  type ContentPart =
    | { type: 'text'; text: string }
    | {
        type: 'image';
        source: { type: 'base64'; media_type: string; data: string };
      };
  const userContent: ContentPart[] = [];
  if (imageBlock) {
    userContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: imageBlock.mediaType,
        data: imageBlock.data,
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
    mode: imageBlock ? 'vision' : 'text',
  });
}
