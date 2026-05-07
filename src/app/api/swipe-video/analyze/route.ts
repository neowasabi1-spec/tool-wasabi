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

interface RequestBody {
  posterUrl?: string;
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

const SYSTEM_PROMPT = `You are a senior direct-response copywriter + art director. You help replace the videos used on a competitor's landing page with equivalent videos for the user's own product, KEEPING the same persuasive intent (demo / before-after / lifestyle / testimonial / hero / explainer / social-proof) but VISUALIZING the unique mechanism and the transformation promised by OUR product — not just a generic aesthetic shot.

You will receive:
- (optionally) a single image — it is the POSTER or a frame of a video clip used on a competitor landing page
- the textual context (alt text, page title)
- the brief of OUR product (the one that should appear in the replacement clip)

The replacement clip will be generated with a TEXT-TO-VIDEO model (Bytedance Seedance 2.0 text-to-video). The model has NO source image: it invents the entire scene from the prompt alone. It also supports MULTI-SHOT prompts (it can render 2–3 connected beats inside a single 5–10s clip), so use this to tell a tiny story instead of giving back a single static beauty shot.

CRITICAL — what makes a prompt good:
- It MUST visualize the unique mechanism of OUR product (extract this from the brief: how the product actually works), not just somebody using it.
- It MUST show the transformation promised by the brief (the before-state, the trigger, the after-state). If the brief promises weight loss, show before/after body. If it promises pain relief, show the pain disappearing. If it's a fat-burning audio mechanism, show the sound waves activating something visible (brain, body silhouette, energy) and a clear before→after arc.
- The original clip's intent stays the same (if it was before/after, you write before/after; if it was a doctor explainer, you write a doctor explainer) but with OUR product's mechanism in it.
- NEVER mention the competitor product or its claims. Refer to OUR product by name if useful.
- Use 2–3 shots (timecoded) when the intent is before-after / demo / explainer. Use a single elegant shot only for hero / lifestyle.

Return ONLY a valid JSON object with these exact keys:
{
  "intent": "one of: demo, before-after, lifestyle, testimonial, hero, explainer, social-proof",
  "originalDescription": "1-2 short sentences describing what the ORIGINAL clip shows (subject, action, mood, type of shot). If you couldn't see the image, summarize from the textual context.",
  "uniqueMechanism": "Pull from OUR product's brief: the specific mechanism the product uses to deliver the result (1 short phrase). Empty string if truly not specified.",
  "transformation": "Pull from OUR product's brief: the before -> after transformation it promises (1 short phrase). Empty string if truly not specified.",
  "suggestedPrompt": "A text-to-video prompt in ENGLISH for Bytedance Seedance 2.0 text-to-video that VISUALIZES the unique mechanism and the transformation. It must:\\n- when intent is before-after / demo / explainer: be structured in 2–3 timecoded beats, e.g. 'Shot 1 (0-3s): <before state, the pain>. Shot 2 (3-7s): <product in use showing the mechanism — make the mechanism visually concrete: glowing audio waves entering the head, fat melting, joints unswelling, etc.>. Shot 3 (7-10s): <after state, the transformation, same person now improved>.'\\n- when intent is lifestyle / hero: write a single elegant shot that still hints at the mechanism (a halo of audio waves, a smile of relief, etc.).\\n- specify camera moves (slow push-in, static medium shot, slow pan, jump-cut between beats).\\n- consistent character continuity across shots when the same person is shown before and after.\\n- end with: 'realistic, professional, cinematic lighting, smooth motion, no on-screen text, no audio.'\\n- target duration: 10 seconds for before-after / demo / explainer, 5 seconds for hero / lifestyle."
}

No markdown, no code blocks, no commentary outside the JSON.`;

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
      intent: typeof o.intent === 'string' ? o.intent : 'lifestyle',
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
      ? 'The image attached is the poster (or a frame) of the competitor video clip you must replace.'
      : 'No image is available — work only from the textual context below.',
  );
  if (currentAlt) lines.push(`Original clip alt text: "${currentAlt}".`);
  if (pageTitle) lines.push(`Landing page title: "${pageTitle}".`);
  lines.push('---');
  lines.push('OUR PRODUCT (must be the protagonist of the replacement clip):');
  if (productContext.name) lines.push(`- Name: ${productContext.name}`);
  if (productContext.description)
    lines.push(`- What it is: ${productContext.description}`);
  if (productContext.brief)
    lines.push(`- Brief (read CAREFULLY — extract from here BOTH the unique mechanism AND the transformation it promises; the video must visualize them):\n${productContext.brief.slice(0, 2000)}`);
  lines.push('---');
  lines.push('Reminder: do NOT default to a generic beauty/lifestyle shot. Visualize the mechanism (e.g. if it works through audio frequencies, render the audio waves entering the head/body and the body responding; if it works through ingredients, render the molecules acting; if it works through a device, render the device working) AND show a clear before -> after transformation arc with the SAME character, when the intent is before-after / demo / explainer.');
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
  const posterUrl = (body.posterUrl || '').trim();

  let imageBlock: {
    data: string;
    mediaType: string;
  } | null = null;
  if (posterUrl && /^https?:\/\//i.test(posterUrl)) {
    imageBlock = await fetchPosterAsBase64(posterUrl);
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
    suggestedDuration:
      parsed.intent === 'before-after' ||
      parsed.intent === 'demo' ||
      parsed.intent === 'explainer'
        ? 10
        : 5,
  });
}
