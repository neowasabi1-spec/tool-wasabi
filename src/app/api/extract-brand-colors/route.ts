import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * POST /api/extract-brand-colors
 *
 * Estrae una brand palette (primary / secondary / accent / background / text)
 * partendo, in ordine di preferenza:
 *   1. dal testo del brief / market research del Project
 *   2. da una foto del prodotto (imageUrl pubblico OPPURE imageDataUrl base64)
 *
 * Logica:
 * - Se nel testo trovo abbastanza hex colors (≥ 2) li uso così come sono.
 * - Altrimenti, se ho un'immagine, chiamo Gemini Vision per estrarre la palette.
 * - Altrimenti, se ho solo testo, chiedo a Gemini di "tradurre" in palette le
 *   parole-chiave di brand/mood/emozioni presenti nel brief.
 *
 * Response shape:
 * {
 *   ok: true,
 *   palette: { primary, secondary, accent, background, text, mood, source },
 * }
 */

type Palette = {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  mood?: string;
  source: 'text-hex' | 'text-llm' | 'image-llm';
};

interface Body {
  brief?: string;
  marketResearch?: string;
  productName?: string;
  productDescription?: string;
  imageUrl?: string;
  imageDataUrl?: string; // data:image/...;base64,...
  /** Se true forziamo l'analisi dell'immagine anche se il testo basterebbe. */
  forceImage?: boolean;
}

const HEX_RE = /#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/g;

function normaliseHex(h: string): string {
  let v = h.trim();
  if (!v.startsWith('#')) v = '#' + v;
  if (v.length === 4) {
    // #abc -> #aabbcc
    v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
  }
  return v.toLowerCase();
}

function extractHexFromText(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const matches = text.match(HEX_RE) || [];
  for (const m of matches) found.add(normaliseHex(m));
  return [...found];
}

function paletteFromHexList(hexes: string[]): Palette | null {
  if (hexes.length < 2) return null;
  const [a, b, c, d, e] = hexes;
  return {
    primary: a,
    secondary: b || a,
    accent: c || b || a,
    background: d || '#0b0f1a',
    text: e || '#ffffff',
    source: 'text-hex',
  };
}

async function geminiJson(
  systemInstruction: string,
  userParts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }>
): Promise<Record<string, unknown>> {
  // Accetta entrambi i nomi (il resto della codebase fa lo stesso): GEMINI_API_KEY
  // è il nome ufficiale di Google AI Studio, GOOGLE_GEMINI_API_KEY è il nome
  // usato storicamente in questo repo.
  const apiKey = (
    process.env.GOOGLE_GEMINI_API_KEY ??
    process.env.GEMINI_API_KEY ??
    ''
  ).trim();
  if (!apiKey) {
    throw new Error('GOOGLE_GEMINI_API_KEY (or GEMINI_API_KEY) not configured');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: userParts }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.4,
        maxOutputTokens: 1024,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const txt: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  try {
    return JSON.parse(txt);
  } catch {
    // a volte Gemini avvolge in ```json … ```
    const cleaned = txt.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  }
}

const PALETTE_SCHEMA_HINT = `Return STRICT JSON with this exact shape:
{
  "primary":    "#RRGGBB",
  "secondary":  "#RRGGBB",
  "accent":     "#RRGGBB",
  "background": "#RRGGBB",
  "text":       "#RRGGBB",
  "mood":       "1-3 words describing the brand vibe (e.g. 'medical clinical', 'luxury wellness', 'high-energy conspiracy')"
}
No prose, no markdown, no code fences. Every color MUST be a valid 6-digit hex.`;

async function paletteFromImage(
  imageUrl: string | undefined,
  imageDataUrl: string | undefined,
  productName: string
): Promise<Palette> {
  let mimeType = 'image/jpeg';
  let base64 = '';

  if (imageDataUrl) {
    const m = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('imageDataUrl is not a valid data URL');
    mimeType = m[1];
    base64 = m[2];
  } else if (imageUrl) {
    const r = await fetch(imageUrl);
    if (!r.ok) throw new Error(`Failed to fetch imageUrl: ${r.status}`);
    const ct = r.headers.get('content-type') || 'image/jpeg';
    mimeType = ct.split(';')[0].trim();
    const buf = Buffer.from(await r.arrayBuffer());
    base64 = buf.toString('base64');
  } else {
    throw new Error('No image provided');
  }

  const sys = `You are a senior brand designer. Look at the product photo and propose a brand color palette
for a landing page that SELLS that product. Pick colors that are PRESENT or strongly evocative of the
product (its packaging, its category, its target emotion). Avoid muddy/grey palettes — go for high
contrast, conversion-ready combos. Background should usually be either a very dark near-black or a
very clean near-white depending on which works best with the product photo.

${PALETTE_SCHEMA_HINT}`;

  const productHint = productName
    ? `Product name (for context only, do NOT let it override what you SEE): ${productName}`
    : 'No product name provided.';

  const json = (await geminiJson(sys, [
    { text: productHint },
    { inline_data: { mime_type: mimeType, data: base64 } },
  ])) as Partial<Palette>;

  return {
    primary: json.primary || '#3b82f6',
    secondary: json.secondary || '#1e40af',
    accent: json.accent || '#f59e0b',
    background: json.background || '#0b0f1a',
    text: json.text || '#ffffff',
    mood: json.mood,
    source: 'image-llm',
  };
}

async function paletteFromTextLLM(
  brief: string,
  marketResearch: string,
  productName: string,
  productDescription: string
): Promise<Palette> {
  const sys = `You are a senior brand designer. Read the product brief + market research and pick a
conversion-ready brand color palette for the landing page. Prefer colors that match the niche
conventions (e.g. red/gold for urgency-conspiracy, teal/white for medical, green/cream for natural,
purple/pink for feminine wellness, navy/gold for premium). High contrast, no muddy greys.

${PALETTE_SCHEMA_HINT}`;

  const userText = [
    productName && `PRODUCT NAME: ${productName}`,
    productDescription && `DESCRIPTION: ${productDescription}`,
    brief && `BRIEF:\n${brief.slice(0, 4000)}`,
    marketResearch && `MARKET RESEARCH:\n${marketResearch.slice(0, 4000)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const json = (await geminiJson(sys, [{ text: userText || 'No data provided' }])) as Partial<Palette>;

  return {
    primary: json.primary || '#3b82f6',
    secondary: json.secondary || '#1e40af',
    accent: json.accent || '#f59e0b',
    background: json.background || '#0b0f1a',
    text: json.text || '#ffffff',
    mood: json.mood,
    source: 'text-llm',
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: Body = await request.json();
    const {
      brief = '',
      marketResearch = '',
      productName = '',
      productDescription = '',
      imageUrl = '',
      imageDataUrl = '',
      forceImage = false,
    } = body;

    const fullText = `${brief}\n\n${marketResearch}`.trim();

    // 1. Try fast hex extraction from the brief
    if (!forceImage) {
      const hexes = extractHexFromText(fullText);
      const fromHex = paletteFromHexList(hexes);
      if (fromHex) {
        return NextResponse.json({ ok: true, palette: fromHex });
      }
    }

    // 2. Image-based extraction (preferred when available)
    if (imageUrl || imageDataUrl) {
      try {
        const palette = await paletteFromImage(imageUrl, imageDataUrl, productName);
        return NextResponse.json({ ok: true, palette });
      } catch (imgErr) {
        // se fallisce e abbiamo testo, fallback al testo
        if (fullText) {
          const palette = await paletteFromTextLLM(brief, marketResearch, productName, productDescription);
          return NextResponse.json({
            ok: true,
            palette,
            warning: `Image analysis failed (${imgErr instanceof Error ? imgErr.message : 'unknown'}), used text fallback.`,
          });
        }
        throw imgErr;
      }
    }

    // 3. Text-only LLM extraction
    if (fullText || productName || productDescription) {
      const palette = await paletteFromTextLLM(brief, marketResearch, productName, productDescription);
      return NextResponse.json({ ok: true, palette });
    }

    // 4. Nothing usable → ask the client to provide a photo
    return NextResponse.json(
      {
        ok: false,
        needsImage: true,
        error:
          'No brief, market research, product name or image available. Please upload a product photo to extract a brand palette.',
      },
      { status: 422 }
    );
  } catch (error) {
    console.error('[api/extract-brand-colors] Error:', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error extracting brand colors',
      },
      { status: 500 }
    );
  }
}
