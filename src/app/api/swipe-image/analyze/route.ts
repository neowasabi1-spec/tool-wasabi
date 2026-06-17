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

const SYSTEM_PROMPT = `You are a senior direct-response creative director who has art-directed thousands of static landing-page images for supplements, devices, beauty and weight-loss brands. You "swipe" a competitor's landing-page image and rebuild an EQUIVALENT image for OUR product.

══ THE #1 RULE — FORMAT FIDELITY (read this first, it overrides everything else) ══
Your job is to REPRODUCE THE SAME KIND OF IMAGE you actually observe, just with OUR product/offer/audience swapped in. So you MUST:
1. First DETECT the FORMAT / GENRE of the original image. Examples: before/after split-frame, product hero/packshot, lifestyle photo, ingredient close-up, mechanism diagram / cross-section, infographic / chart, testimonial portrait, newspaper / press-article clipping, magazine editorial, news / screenshot, comparison table, UGC selfie photo, icon / badge / social-proof, scientific figure.
2. Then build a prompt that recreates THAT SAME FORMAT for our product — same tone, framing, era, layout and style.
DO NOT default to a "before/after split-frame" or to a glowing-mechanism beauty shot. Use a split-frame before→after ONLY when the original is genuinely a before/after. If the original is a newspaper/press clipping, produce a press-clipping-style image about our product. If it's a testimonial portrait, produce a testimonial portrait. If it's an ingredient close-up, produce an ingredient close-up. The output must be a faithful SWIPE of what you saw — not a different format.

You will receive:
- (optionally) a single image — the ORIGINAL image used on the competitor landing page
- the textual context (alt text, page title, surrounding heading + nearby paragraph + CTA)
- the brief of OUR product (must appear in the replacement image)

The replacement image will be generated with a TEXT-TO-IMAGE model (Nano Banana 2 / FLUX / Imagen / GPT Image). The model has NO source image — it invents the entire composition from the prompt alone — so describe the WHOLE composition (subject, setting, props, lighting, style, palette, framing) faithful to the original's format.

═══ HOW YOU MUST THINK (chain-of-thought, condensed into JSON fields) ═══

1) ANALYZE the original in detail (NOT a one-line caption). FIRST name the format/genre. Then: subject demographics (age/gender/body/ethnicity vibe), framing (close-up / medium / wide / split-frame), lighting, era/style (photoreal / 3D / clean infographic / illustrated / editorial / press), color palette, and the visual hierarchy. Be specific.

2) NAME the BIG IDEA in DR-copywriter terms (the ONE concept the image plants in the viewer's brain).

3) IDENTIFY the visible TARGET AUDIENCE (demographics + body type + vibe). Locks character continuity when the same person must appear more than once.

4) MAP the Big Idea onto OUR product (read the brief CAREFULLY). The new image must land the SAME emotional beat AND keep the SAME FORMAT detected in step 1, swapping in our product, offer and audience.

5) DRAFT a text-to-image prompt in ENGLISH that recreates the ORIGINAL'S FORMAT:
   • before-after → a SPLIT-FRAME, describing BOTH halves with the SAME character repeated verbatim (only the body/expression changes). Add a subtle mechanism cue only if it fits.
   • diagram / ingredient / chart / infographic → recreate that explainer/infographic style (cross-section, labeled minimal flow, ingredient acting) — only if the original was one.
   • hero / packshot / lifestyle → a single elegant composition in the original's style.
   • testimonial / portrait → a believable portrait of a matching person in a matching setting.
   • press-article / news / editorial → recreate the newspaper/magazine/screenshot look (column text blocks WITHOUT readable body text, headline area, photo placement) about our product — match the publication style, not a before/after.
   • ugc / selfie → casual handheld phone-photo look, natural light, authentic vibe.
   • icon / social-proof → a clean iconic composition (badge, ribbon, stars + faces) in the original's background style.
   Only hint at the product mechanism when it fits that format naturally — never shoehorn a glowing halo into a press clipping or an ingredient shot.
   • CINEMATOGRAPHY: always specify framing, camera angle, lens feel (35mm / 85mm portrait / macro), lighting, color palette and art style — matched to the ORIGINAL's look.
   • CHARACTER CONTINUITY: when the same character appears twice, repeat the EXACT same character description so the model keeps it consistent.
   • End with: "Photorealistic, sharp focus, professional studio lighting, clean composition, no on-image text, no competitor logos, no watermark."

6) ADD a NEGATIVE PROMPT against typical T2I failure modes: distorted hands, extra fingers, warped faces, two different people across a split-frame, on-image text, watermark, low resolution, artifacts.

═══ OUTPUT — ONLY this JSON, no markdown, no code blocks, no commentary ═══

{
  "analysis": "2–4 sentences. START by naming the format/genre, then detailed compositional analysis (subject demographics, framing, lighting, mood, era, palette, visual hierarchy).",
  "bigIdea": "One sentence in DR-copywriter voice: the single emotional concept the original image plants in the viewer.",
  "targetAudience": "Visible demographic of the protagonist (age, gender, body type, ethnicity vibe, mood) — to be repeated verbatim when the same character appears twice.",
  "intent": "the detected format — one of: hero, before-after, lifestyle, ingredient, diagram, infographic, testimonial, press-article, news, comparison, ugc, icon, chart, social-proof",
  "originalDescription": "1 short sentence summarizing what the original image shows.",
  "uniqueMechanism": "From OUR brief: the specific mechanism the product uses (1 phrase). Empty string if not specified or if the format does not call for showing a mechanism.",
  "transformation": "From OUR brief: the before -> after transformation it promises (1 phrase). Empty string if the format is not a before/after.",
  "suggestedPrompt": "The full text-to-image prompt as described in step 5, faithful to the ORIGINAL's format.",
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
  lines.push('Reminder: FORMAT FIDELITY first. Identify the format/genre of the original image and REPRODUCE THAT SAME FORMAT for our product (e.g. if it is a newspaper/press clipping, an ingredient close-up, a testimonial portrait, an infographic, a before/after split-frame — recreate that exact kind of image). Do NOT default to a before/after split-frame or to a generic beauty photo with our packshot floating in the air. Use a SPLIT-FRAME before/after with the SAME character repeated ONLY if the original is genuinely a before/after. Keep the same tone, framing, era and layout you observed, swapping in our product, audience and offer. Then follow the 6-step thinking (Analyze → Big Idea → Audience → Map → Draft → Negative).');
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
    mode: imageBlock ? 'vision' : 'text',
  });
}
