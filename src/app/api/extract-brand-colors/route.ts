import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * POST /api/extract-brand-colors
 *
 * Estrae una brand palette (primary / secondary / accent / background / text)
 * partendo, in ordine di preferenza:
 *   1. dal testo del brief / market research del Project (regex hex)
 *   2. da una foto del prodotto (imageUrl pubblico OPPURE imageDataUrl base64)
 *      → vision LLM
 *   3. solo dal testo → text LLM
 *
 * Doppio provider con failover automatico:
 *   - prima tenta Gemini (gemini-2.5-flash, gratis e veloce)
 *   - se Gemini fallisce (chiave invalida, quota, 5xx, network, ecc.) ripiega
 *     SUBITO su Claude (Anthropic Sonnet) usando ANTHROPIC_API_KEY
 *   - se entrambi falliscono restituisce 500
 *
 * Questo serve perché in produzione la chiave Gemini può scadere / essere
 * revocata / esaurire quota e l'utente vede il bottone "Brand Colors"
 * spaccarsi. Con il failover automatico, finché Claude funziona la feature
 * resta operativa.
 *
 * Response shape:
 * {
 *   ok: true,
 *   palette: { primary, secondary, accent, background, text, mood, source },
 *   provider: 'gemini' | 'claude'
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

function parseJsonLoose(txt: string): Record<string, unknown> {
  try {
    return JSON.parse(txt);
  } catch {
    const cleaned = txt
      .replace(/^```json?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    // ultimo tentativo: trova la prima { e l'ultima } e parsa solo quello
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('LLM did not return valid JSON');
  }
}

/* ───────────────────────── Provider: Gemini ───────────────────────── */

function geminiKey(): string {
  return (
    process.env.GOOGLE_GEMINI_API_KEY ??
    process.env.GEMINI_API_KEY ??
    ''
  ).trim();
}

async function geminiJson(
  systemInstruction: string,
  userParts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }>,
): Promise<Record<string, unknown>> {
  const apiKey = geminiKey();
  if (!apiKey) throw new Error('Gemini key not configured');

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
  return parseJsonLoose(txt);
}

/* ───────────────────────── Provider: Claude ───────────────────────── */

function claudeKey(): string {
  return (process.env.ANTHROPIC_API_KEY ?? '').trim();
}

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } };

async function claudeJson(
  systemInstruction: string,
  contentBlocks: ClaudeContentBlock[],
): Promise<Record<string, unknown>> {
  const apiKey = claudeKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system:
      systemInstruction +
      '\n\nIMPORTANT: respond with ONLY the raw JSON object. No prose, no markdown, no code fences.',
    messages: [
      {
        role: 'user',
        content: contentBlocks,
      },
    ],
  });

  const txt =
    response.content[0] && response.content[0].type === 'text'
      ? response.content[0].text
      : '';
  return parseJsonLoose(txt);
}

/* ───────────────────────── Smart routing ───────────────────────── */

type ProviderUsed = 'gemini' | 'claude';

interface ProviderResult {
  json: Record<string, unknown>;
  provider: ProviderUsed;
}

interface ProviderInputs {
  systemInstruction: string;
  textOnly: string;
  image?: { mimeType: string; base64: string };
}

/** Esegue la richiesta su Gemini, e se fallisce per QUALSIASI motivo
 *  (chiave invalida, quota, 5xx, parse error, ecc.) ripiega su Claude. */
async function callLLMWithFailover(inp: ProviderInputs): Promise<ProviderResult> {
  // ── 1. Gemini ──
  if (geminiKey()) {
    try {
      const parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> = [
        { text: inp.textOnly },
      ];
      if (inp.image) {
        parts.push({
          inline_data: { mime_type: inp.image.mimeType, data: inp.image.base64 },
        });
      }
      const json = await geminiJson(inp.systemInstruction, parts);
      return { json, provider: 'gemini' };
    } catch (err) {
      console.warn(
        '[extract-brand-colors] Gemini failed, falling back to Claude:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── 2. Claude (fallback) ──
  if (!claudeKey()) {
    throw new Error(
      'Both providers unavailable: Gemini failed/missing and ANTHROPIC_API_KEY not configured',
    );
  }

  const blocks: ClaudeContentBlock[] = [{ type: 'text', text: inp.textOnly }];
  if (inp.image) {
    const mt = inp.image.mimeType;
    const supportedMime =
      mt === 'image/jpeg' || mt === 'image/png' || mt === 'image/gif' || mt === 'image/webp'
        ? mt
        : 'image/jpeg';
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: supportedMime, data: inp.image.base64 },
    });
  }
  const json = await claudeJson(inp.systemInstruction, blocks);
  return { json, provider: 'claude' };
}

/* ───────────────────────── Palette extraction ───────────────────────── */

async function paletteFromImage(
  imageUrl: string | undefined,
  imageDataUrl: string | undefined,
  productName: string,
): Promise<{ palette: Palette; provider: ProviderUsed }> {
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

  const { json, provider } = await callLLMWithFailover({
    systemInstruction: sys,
    textOnly: productHint,
    image: { mimeType, base64 },
  });

  const j = json as Partial<Palette>;
  return {
    palette: {
      primary: j.primary || '#3b82f6',
      secondary: j.secondary || '#1e40af',
      accent: j.accent || '#f59e0b',
      background: j.background || '#0b0f1a',
      text: j.text || '#ffffff',
      mood: j.mood,
      source: 'image-llm',
    },
    provider,
  };
}

async function paletteFromTextLLM(
  brief: string,
  marketResearch: string,
  productName: string,
  productDescription: string,
): Promise<{ palette: Palette; provider: ProviderUsed }> {
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

  const { json, provider } = await callLLMWithFailover({
    systemInstruction: sys,
    textOnly: userText || 'No data provided',
  });

  const j = json as Partial<Palette>;
  return {
    palette: {
      primary: j.primary || '#3b82f6',
      secondary: j.secondary || '#1e40af',
      accent: j.accent || '#f59e0b',
      background: j.background || '#0b0f1a',
      text: j.text || '#ffffff',
      mood: j.mood,
      source: 'text-llm',
    },
    provider,
  };
}

/* ───────────────────────── Handler ───────────────────────── */

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

    // 1. Hex regex shortcut (zero API calls)
    if (!forceImage) {
      const hexes = extractHexFromText(fullText);
      const fromHex = paletteFromHexList(hexes);
      if (fromHex) {
        return NextResponse.json({ ok: true, palette: fromHex, provider: 'hex' });
      }
    }

    // 2. Image-based (preferred when available) — con failover Gemini → Claude
    if (imageUrl || imageDataUrl) {
      try {
        const { palette, provider } = await paletteFromImage(imageUrl, imageDataUrl, productName);
        return NextResponse.json({ ok: true, palette, provider });
      } catch (imgErr) {
        if (fullText) {
          const { palette, provider } = await paletteFromTextLLM(brief, marketResearch, productName, productDescription);
          return NextResponse.json({
            ok: true,
            palette,
            provider,
            warning: `Image analysis failed (${imgErr instanceof Error ? imgErr.message : 'unknown'}), used text fallback.`,
          });
        }
        throw imgErr;
      }
    }

    // 3. Text-only — con failover Gemini → Claude
    if (fullText || productName || productDescription) {
      const { palette, provider } = await paletteFromTextLLM(brief, marketResearch, productName, productDescription);
      return NextResponse.json({ ok: true, palette, provider });
    }

    // 4. Niente di usabile → chiede al client la foto prodotto
    return NextResponse.json(
      {
        ok: false,
        needsImage: true,
        error:
          'No brief, market research, product name or image available. Please upload a product photo to extract a brand palette.',
      },
      { status: 422 },
    );
  } catch (error) {
    console.error('[api/extract-brand-colors] Error:', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error extracting brand colors',
      },
      { status: 500 },
    );
  }
}
