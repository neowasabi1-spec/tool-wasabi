import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const BUCKET_NAME = 'generated-images';

// Nano Banana 2 = Gemini 3.1 Flash Image Preview.
// Endpoint: https://ai.google.dev/gemini-api/docs/image-generation
const GEMINI_MODEL = 'gemini-3.1-flash-image-preview';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Missing Supabase credentials');
  return createClient(url, key);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureBucket(sb: any) {
  const { data } = await sb.storage.getBucket(BUCKET_NAME);
  if (!data) {
    await sb.storage.createBucket(BUCKET_NAME, { public: true });
  }
}

// Map legacy DALL-E size strings to Gemini aspect ratios. The front-end
// (VisualHtmlEditor.tsx) still sends `1024x1024` / `1792x1024` / `1024x1792`.
function sizeToAspectRatio(size: unknown): string {
  switch (size) {
    case '1792x1024':
    case '16:9':
      return '16:9';
    case '1024x1792':
    case '9:16':
      return '9:16';
    case '4:3':
      return '4:3';
    case '3:4':
      return '3:4';
    case '1024x1024':
    case '1:1':
    default:
      return '1:1';
  }
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}

export async function POST(req: NextRequest) {
  try {
    const { prompt, size, style } = await req.json();

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'GOOGLE_GEMINI_API_KEY not configured' },
        { status: 500 },
      );
    }

    const aspectRatio = sizeToAspectRatio(size);
    // Gemini doesn't expose a "style" enum like DALL-E. Inline a hint into the
    // prompt so vivid/natural still has an effect on the output.
    const styleHint =
      style === 'natural'
        ? 'Style: natural, photorealistic, accurate colors and lighting.'
        : 'Style: vivid, saturated colors, high contrast, cinematic lighting.';

    const finalPrompt = `${prompt.trim()}\n\n${styleHint}`;

    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [{ text: finalPrompt }],
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio,
          imageSize: '1K',
        },
      },
    };

    const geminiRes = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      let parsed: { error?: { message?: string; status?: string } } | null = null;
      try {
        parsed = JSON.parse(errText);
      } catch {
        /* not JSON */
      }
      const msg = parsed?.error?.message || errText.substring(0, 500) || 'Unknown Gemini error';
      console.error('[generate-image] Gemini error', geminiRes.status, msg);
      return NextResponse.json(
        { error: `Gemini ${GEMINI_MODEL} ${geminiRes.status}: ${msg}` },
        { status: geminiRes.status >= 400 && geminiRes.status < 600 ? geminiRes.status : 500 },
      );
    }

    const geminiData = await geminiRes.json();
    const parts: GeminiPart[] = geminiData?.candidates?.[0]?.content?.parts || [];

    let b64: string | undefined;
    let mimeType = 'image/png';
    const textChunks: string[] = [];

    for (const part of parts) {
      const inline = part.inlineData ?? part.inline_data;
      if (inline?.data) {
        b64 = inline.data;
        mimeType = inline.mimeType ?? inline.mime_type ?? mimeType;
      } else if (part.text) {
        textChunks.push(part.text);
      }
    }

    if (!b64) {
      const fallbackText = textChunks.join('\n').substring(0, 500);
      console.error('[generate-image] No image returned by Gemini, text:', fallbackText);
      return NextResponse.json(
        {
          error: fallbackText
            ? `Gemini non ha restituito un'immagine. Risposta testuale: ${fallbackText}`
            : 'Nessuna immagine generata',
        },
        { status: 502 },
      );
    }

    const revisedPrompt = textChunks.length > 0 ? textChunks.join(' ').trim() : undefined;

    // Try to upload to Supabase Storage; fall back to inline data URL if the
    // bucket / RLS isn't configured.
    try {
      const sb = getSupabase();
      await ensureBucket(sb);

      const buffer = Buffer.from(b64, 'base64');
      const ext = mimeType.includes('jpeg') ? 'jpg' : 'png';
      const filename = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const filePath = `editor/${filename}`;

      const { error: uploadError } = await sb.storage
        .from(BUCKET_NAME)
        .upload(filePath, buffer, {
          contentType: mimeType,
          upsert: false,
        });

      if (uploadError) {
        console.warn('[generate-image] Supabase upload failed, falling back to data URL:', uploadError.message);
        const dataUrl = `data:${mimeType};base64,${b64}`;
        return NextResponse.json({
          url: dataUrl,
          revisedPrompt,
          storage: 'inline',
          model: GEMINI_MODEL,
        });
      }

      const { data: publicUrlData } = sb.storage.from(BUCKET_NAME).getPublicUrl(filePath);

      return NextResponse.json({
        url: publicUrlData.publicUrl,
        revisedPrompt,
        storage: 'supabase',
        model: GEMINI_MODEL,
      });
    } catch (storageErr) {
      console.warn('[generate-image] Storage path errored, returning data URL:', storageErr);
      const dataUrl = `data:${mimeType};base64,${b64}`;
      return NextResponse.json({
        url: dataUrl,
        revisedPrompt,
        storage: 'inline',
        model: GEMINI_MODEL,
      });
    }
  } catch (err: unknown) {
    console.error('[generate-image] error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
