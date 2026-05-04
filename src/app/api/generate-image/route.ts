import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const BUCKET_NAME = 'generated-images';

// Nano Banana 2 = Gemini 3.1 Flash Image, hosted on fal.ai.
// Docs: https://fal.ai/models/fal-ai/nano-banana-2/api
const FAL_MODEL = 'fal-ai/nano-banana-2';
// Sync endpoint blocks until generation completes (typically 5–10s).
const FAL_SYNC_ENDPOINT = `https://fal.run/${FAL_MODEL}`;
// Queue fallback for environments with tight HTTP timeouts.
const FAL_QUEUE_SUBMIT_ENDPOINT = `https://queue.fal.run/${FAL_MODEL}`;

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

// fal-ai/nano-banana-2 supports:
// auto, 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16, 4:1, 1:4, 8:1, 1:8
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
    case '21:9':
      return '21:9';
    case '1024x1024':
    case '1:1':
      return '1:1';
    default:
      return 'auto';
  }
}

interface FalImage {
  url: string;
  content_type?: string;
  file_name?: string;
  width?: number;
  height?: number;
}

interface FalSyncResponse {
  images?: FalImage[];
  description?: string;
}

interface FalQueueSubmitResponse {
  request_id: string;
  status_url: string;
  response_url: string;
}

interface FalQueueStatusResponse {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'ERROR';
  response_url?: string;
  logs?: { message: string }[];
}

async function callFalSync(
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<FalSyncResponse> {
  const res = await fetch(FAL_SYNC_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Key ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`fal.ai ${res.status}: ${errText.substring(0, 500)}`);
  }
  return res.json();
}

async function callFalQueue(
  body: Record<string, unknown>,
  apiKey: string,
): Promise<FalSyncResponse> {
  // Submit
  const submitRes = await fetch(FAL_QUEUE_SUBMIT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Key ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`fal.ai queue submit ${submitRes.status}: ${errText.substring(0, 500)}`);
  }
  const submission = (await submitRes.json()) as FalQueueSubmitResponse;

  // Poll status (up to ~90s with exponential-ish backoff)
  const start = Date.now();
  const MAX_WAIT_MS = 90_000;
  let wait = 1000;
  while (Date.now() - start < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait + 500, 3000);

    const statusRes = await fetch(submission.status_url, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!statusRes.ok) continue;
    const statusData = (await statusRes.json()) as FalQueueStatusResponse;

    if (statusData.status === 'COMPLETED') {
      const resultRes = await fetch(submission.response_url, {
        headers: { Authorization: `Key ${apiKey}` },
      });
      if (!resultRes.ok) {
        const errText = await resultRes.text();
        throw new Error(`fal.ai queue result ${resultRes.status}: ${errText.substring(0, 500)}`);
      }
      return resultRes.json();
    }
    if (statusData.status === 'ERROR') {
      throw new Error(`fal.ai queue ERROR: ${JSON.stringify(statusData.logs || [])}`);
    }
  }
  throw new Error('fal.ai queue: timeout aspettando il completamento (>90s)');
}

export async function POST(req: NextRequest) {
  try {
    const { prompt, size, style, useQueue } = await req.json();

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    const apiKey = process.env.FAL_KEY || process.env.FAL_AI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'FAL_KEY non configurata. Settala nelle env var (Netlify > Site configuration > Environment variables).' },
        { status: 500 },
      );
    }

    const aspectRatio = sizeToAspectRatio(size);
    const styleHint =
      style === 'natural'
        ? 'Style: natural, photorealistic, accurate colors and lighting.'
        : 'Style: vivid, saturated colors, high contrast, cinematic lighting.';
    const finalPrompt = `${prompt.trim()}\n\n${styleHint}`;

    const body = {
      prompt: finalPrompt,
      num_images: 1,
      aspect_ratio: aspectRatio,
      resolution: '1K',
      output_format: 'png',
      limit_generations: true,
    };

    let falResult: FalSyncResponse;
    try {
      if (useQueue) {
        falResult = await callFalQueue(body, apiKey);
      } else {
        falResult = await callFalSync(body, apiKey);
      }
    } catch (callErr) {
      const msg = callErr instanceof Error ? callErr.message : String(callErr);
      console.error('[generate-image] fal.ai call failed:', msg);
      // If sync timed out at the network layer (uncommon at 5-10s), retry via queue.
      if (!useQueue && /aborted|timeout|ETIMEDOUT/i.test(msg)) {
        console.warn('[generate-image] retrying via queue endpoint');
        try {
          falResult = await callFalQueue(body, apiKey);
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          return NextResponse.json({ error: retryMsg }, { status: 504 });
        }
      } else {
        return NextResponse.json({ error: msg }, { status: 502 });
      }
    }

    const imageEntry = falResult.images?.[0];
    if (!imageEntry?.url) {
      console.error('[generate-image] fal.ai returned no image:', falResult);
      return NextResponse.json(
        {
          error: falResult.description
            ? `fal.ai non ha restituito un'immagine: ${falResult.description}`
            : "fal.ai non ha restituito un'immagine",
        },
        { status: 502 },
      );
    }

    const falUrl = imageEntry.url;
    const revisedPrompt = falResult.description?.trim() || undefined;

    // Mirror to Supabase Storage as best effort. If it fails, return the
    // fal.media URL directly — fal CDN URLs are persistent.
    try {
      const downloadRes = await fetch(falUrl);
      if (!downloadRes.ok) throw new Error(`download ${downloadRes.status}`);
      const arrayBuf = await downloadRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      const mimeType = imageEntry.content_type || 'image/png';
      const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';

      const sb = getSupabase();
      await ensureBucket(sb);
      const filename = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const filePath = `editor/${filename}`;

      const { error: uploadError } = await sb.storage
        .from(BUCKET_NAME)
        .upload(filePath, buffer, {
          contentType: mimeType,
          upsert: false,
        });

      if (uploadError) {
        console.warn('[generate-image] Supabase upload failed, returning fal URL:', uploadError.message);
        return NextResponse.json({
          url: falUrl,
          revisedPrompt,
          storage: 'fal',
          model: FAL_MODEL,
        });
      }

      const { data: publicUrlData } = sb.storage.from(BUCKET_NAME).getPublicUrl(filePath);
      return NextResponse.json({
        url: publicUrlData.publicUrl,
        revisedPrompt,
        storage: 'supabase',
        model: FAL_MODEL,
      });
    } catch (mirrorErr) {
      console.warn('[generate-image] Supabase mirror failed, returning fal URL directly:', mirrorErr);
      return NextResponse.json({
        url: falUrl,
        revisedPrompt,
        storage: 'fal',
        model: FAL_MODEL,
      });
    }
  } catch (err: unknown) {
    console.error('[generate-image] error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
