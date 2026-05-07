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

interface RequestBody {
  imageUrl?: string;
  currentAlt?: string;
  pageTitle?: string;
  productContext?: ProductCtx;
  /** Indicazioni libere fornite dall'utente per guidare la rigenerazione del
   *  prompt (es. "fai vedere persona prima grassa con cuffie e poi magra"). */
  userGuidance?: string;
}

interface AnalyzeResult {
  intent: string;
  originalDescription: string;
  uniqueMechanism: string;
  transformation: string;
  suggestedPrompt: string;
}

const SYSTEM_PROMPT = `You are a senior direct-response copywriter + art director. You help replace the images used on a competitor's landing page with equivalent images for the user's own product, KEEPING the same persuasive intent (hero / before-after / lifestyle / ingredient / diagram / testimonial / icon / chart / social-proof) but VISUALIZING the unique mechanism and the transformation promised by OUR product — not just a generic aesthetic photo.

You will receive:
- (optionally) a single image — it is the original image used on the competitor landing page
- the textual context (alt text, page title)
- the brief of OUR product (the one that should appear in the replacement image)

The replacement image will be generated with a TEXT-TO-IMAGE model (Nano Banana 2 / FLUX / Imagen / GPT Image). The model has NO source image: it invents the entire scene from the prompt alone. So the prompt must describe the WHOLE composition (subject, setting, props, lighting, style, color palette, framing) — not just an animation of a still frame and not just "our product on a white background".

CRITICAL — what makes a prompt good:
- It MUST visualize the unique mechanism of OUR product (extract this from the brief: how the product actually works), not just somebody holding it.
- It MUST show, when the intent allows it, the transformation promised by the brief. For "before-after" intents use a SPLIT-FRAME composition (left = before, right = after) of the SAME person, identical pose/framing, only the result changes. For "hero" / "lifestyle" embed a visual hint of the mechanism (glowing audio waves around the head, a halo of energy on the body, a subtle infographic overlay, etc.).
- The original image's intent stays the same (if it was a hero close-up, you write a hero close-up; if it was a before-after split, you write a before-after split; if it was a doctor testimonial portrait, you write a doctor portrait) but with OUR product / OUR mechanism in it.
- NEVER mention the competitor product or its claims. Refer to OUR product by name if useful.
- Specify framing, lens feel, lighting, style (photorealistic / 3D render / clean infographic, depending on the original) and exact color palette when relevant.
- End the prompt with constraints: "photorealistic, sharp focus, professional studio lighting, no on-image text unless explicitly requested, no logos other than our product, square aspect ratio if no aspect is implied by the original."

Return ONLY a valid JSON object with these exact keys:
{
  "intent": "one of: hero, before-after, lifestyle, ingredient, diagram, testimonial, icon, chart, social-proof",
  "originalDescription": "1-2 short sentences describing what the ORIGINAL image shows (subject, framing, mood, style). If you couldn't see the image, summarize from the textual context.",
  "uniqueMechanism": "Pull from OUR product's brief: the specific mechanism the product uses to deliver the result (1 short phrase). Empty string if truly not specified.",
  "transformation": "Pull from OUR product's brief: the before -> after transformation it promises (1 short phrase). Empty string if truly not specified.",
  "suggestedPrompt": "A text-to-image prompt in ENGLISH for Nano Banana / FLUX / Imagen that VISUALIZES the unique mechanism and (when applicable) the transformation. It must:\\n- when intent is before-after: be a SPLIT-FRAME describing both sides explicitly ('left half: <before, the pain/problem state>. right half: <after, the transformation promised by the brief>. Same person, same pose, same framing, same lighting; only the body/state changes.').\\n- when intent is diagram / ingredient / chart: be a clean infographic-style composition that explicitly visualizes how the product works (e.g. cross-section of the body with audio waves entering the brain and reaching the body, ingredient molecules acting on cells), label-free unless explicitly needed.\\n- when intent is hero / lifestyle / testimonial: a single elegant photo-realistic composition that still hints at the mechanism (a subtle halo of audio waves, a glow of energy, a confident transformed look).\\n- always specify: framing (close-up / medium / wide), camera angle, lighting, color palette, art style.\\n- end with: 'photorealistic, sharp focus, professional studio lighting, clean composition, no on-image text, no competitor logos.'"
}

No markdown, no code blocks, no commentary outside the JSON.`;

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
      intent: typeof o.intent === 'string' ? o.intent : 'hero',
      originalDescription:
        typeof o.originalDescription === 'string' ? o.originalDescription : '',
      uniqueMechanism:
        typeof o.uniqueMechanism === 'string' ? o.uniqueMechanism : '',
      transformation:
        typeof o.transformation === 'string' ? o.transformation : '',
      suggestedPrompt:
        typeof o.suggestedPrompt === 'string' ? o.suggestedPrompt : '',
    };
  } catch {
    return null;
  }
}

function buildUserMessage(
  productContext: ProductCtx,
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
  lines.push('---');
  lines.push('OUR PRODUCT (must be the protagonist of the replacement image):');
  if (productContext.name) lines.push(`- Name: ${productContext.name}`);
  if (productContext.description)
    lines.push(`- What it is: ${productContext.description}`);
  if (productContext.brief)
    lines.push(`- Brief (read CAREFULLY — extract from here BOTH the unique mechanism AND the transformation it promises; the image must visualize them):\n${productContext.brief.slice(0, 2000)}`);
  lines.push('---');
  lines.push('Reminder: do NOT default to a generic beauty/lifestyle photo with our packshot floating in the air. Visualize the mechanism (e.g. if it works through audio frequencies, render the audio waves entering the head/body and the body responding; if it works through ingredients, render the molecules acting on the target tissue; if it works through a device, render the device working) AND show a clear before -> after transformation arc with the SAME person and SAME framing on both halves of a split-frame, when the intent is before-after.');
  if (userGuidance && userGuidance.trim()) {
    lines.push('---');
    lines.push(
      `EXPLICIT USER GUIDANCE for this rewrite (highest priority — bake this into the suggestedPrompt):\n"${userGuidance.trim().slice(0, 600)}"`,
    );
  }
  lines.push('Return the JSON described in the system instructions.');
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
  const currentAlt = (body.currentAlt || '').trim();
  const pageTitle = (body.pageTitle || '').trim();
  const imageUrl = (body.imageUrl || '').trim();

  let imageBlock: {
    data: string;
    mediaType: string;
  } | null = null;
  if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
    imageBlock = await fetchImageAsBase64(imageUrl);
  }

  const userGuidance = (body.userGuidance || '').trim();
  const userText = buildUserMessage(
    productContext,
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
        max_tokens: 1024,
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
    intent: parsed.intent,
    originalDescription: parsed.originalDescription,
    uniqueMechanism: parsed.uniqueMechanism,
    transformation: parsed.transformation,
    suggestedPrompt: parsed.suggestedPrompt,
    mode: imageBlock ? 'vision' : 'text',
  });
}
