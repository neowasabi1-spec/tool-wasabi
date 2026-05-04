import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const BUCKET_NAME = 'generated-images';

// Nano Banana 2 = Gemini 3.1 Flash Image, hosted on fal.ai.
// Docs: https://fal.ai/models/fal-ai/nano-banana-2/api
const FAL_MODEL = 'fal-ai/nano-banana-2';
const FAL_QUEUE_BASE = `https://queue.fal.run/${FAL_MODEL}`;

// Inner sync polling budget. We must finish well below Netlify's serverless
// function wall (10s on Free, 26s on Pro). 8s leaves room for cold start +
// network. If fal hasn't finished by then we hand back a `requestId` and the
// client polls.
const SYNC_BUDGET_MS = 8_000;
// Poll budget when the client explicitly asks us to keep polling.
const POLL_BUDGET_MS = 8_000;
const POLL_INTERVAL_MS = 1_000;

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

interface FalResult {
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

function getFalKey(): string | null {
  return process.env.FAL_KEY || process.env.FAL_AI_API_KEY || null;
}

async function falSubmit(body: Record<string, unknown>, apiKey: string): Promise<FalQueueSubmitResponse> {
  const res = await fetch(FAL_QUEUE_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Key ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`fal.ai submit ${res.status}: ${errText.substring(0, 500)}`);
  }
  return res.json();
}

async function falStatus(statusUrl: string, apiKey: string): Promise<FalQueueStatusResponse> {
  const res = await fetch(statusUrl, {
    headers: { Authorization: `Key ${apiKey}` },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`fal.ai status ${res.status}: ${errText.substring(0, 300)}`);
  }
  return res.json();
}

async function falResult(responseUrl: string, apiKey: string): Promise<FalResult> {
  const res = await fetch(responseUrl, {
    headers: { Authorization: `Key ${apiKey}` },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`fal.ai result ${res.status}: ${errText.substring(0, 300)}`);
  }
  return res.json();
}

// Poll fal until COMPLETED or until budget is exceeded. Returns either the
// final result or null (caller should hand the requestId back to the client
// for further polling).
async function pollWithBudget(
  statusUrl: string,
  responseUrl: string,
  apiKey: string,
  budgetMs: number,
): Promise<FalResult | null> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const status = await falStatus(statusUrl, apiKey);
    if (status.status === 'COMPLETED') {
      return falResult(responseUrl, apiKey);
    }
    if (status.status === 'ERROR') {
      throw new Error(`fal.ai ERROR: ${JSON.stringify(status.logs || [])}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

// Best-effort: download the fal image and upload to Supabase Storage so the
// asset is hosted on a stable origin we control. If anything fails, we just
// return the fal CDN URL — fal.media URLs are persistent.
async function persistOrPassthrough(
  result: FalResult,
): Promise<{ url: string; revisedPrompt?: string; storage: 'supabase' | 'fal' }> {
  const imageEntry = result.images?.[0];
  if (!imageEntry?.url) {
    throw new Error(
      result.description
        ? `fal.ai non ha restituito un'immagine: ${result.description}`
        : "fal.ai non ha restituito un'immagine",
    );
  }
  const falUrl = imageEntry.url;
  const revisedPrompt = result.description?.trim() || undefined;

  try {
    const downloadRes = await fetch(falUrl);
    if (!downloadRes.ok) throw new Error(`download ${downloadRes.status}`);
    const buffer = Buffer.from(await downloadRes.arrayBuffer());
    const mimeType = imageEntry.content_type || 'image/png';
    const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';

    const sb = getSupabase();
    await ensureBucket(sb);
    const filename = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = `editor/${filename}`;

    const { error: uploadError } = await sb.storage
      .from(BUCKET_NAME)
      .upload(filePath, buffer, { contentType: mimeType, upsert: false });

    if (uploadError) {
      console.warn('[generate-image] Supabase upload failed:', uploadError.message);
      return { url: falUrl, revisedPrompt, storage: 'fal' };
    }

    const { data: publicUrlData } = sb.storage.from(BUCKET_NAME).getPublicUrl(filePath);
    return { url: publicUrlData.publicUrl, revisedPrompt, storage: 'supabase' };
  } catch (mirrorErr) {
    console.warn('[generate-image] mirror failed, returning fal URL:', mirrorErr);
    return { url: falUrl, revisedPrompt, storage: 'fal' };
  }
}

export async function POST(req: NextRequest) {
  let body: {
    prompt?: string;
    size?: string;
    style?: string;
    action?: 'submit' | 'poll';
    requestId?: string;
    statusUrl?: string;
    responseUrl?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Body non valido' }, { status: 400 });
  }

  const apiKey = getFalKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'FAL_KEY non configurata. Settala nelle env var (Netlify > Site configuration > Environment variables).' },
      { status: 500 },
    );
  }

  // ── PHASE: poll a previously submitted job ────────────────────────────────
  if (body.action === 'poll') {
    if (!body.requestId) {
      return NextResponse.json({ error: 'Missing requestId' }, { status: 400 });
    }
    const statusUrl = body.statusUrl || `${FAL_QUEUE_BASE}/requests/${body.requestId}/status`;
    const responseUrl = body.responseUrl || `${FAL_QUEUE_BASE}/requests/${body.requestId}`;
    try {
      const result = await pollWithBudget(statusUrl, responseUrl, apiKey, POLL_BUDGET_MS);
      if (!result) {
        return NextResponse.json({
          status: 'pending',
          requestId: body.requestId,
          statusUrl,
          responseUrl,
        });
      }
      const persisted = await persistOrPassthrough(result);
      return NextResponse.json({
        status: 'completed',
        ...persisted,
        model: FAL_MODEL,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown poll error';
      console.error('[generate-image] poll error:', message);
      return NextResponse.json({ status: 'error', error: message }, { status: 502 });
    }
  }

  // ── PHASE: submit (default) ───────────────────────────────────────────────
  const prompt = body.prompt;
  if (!prompt || typeof prompt !== 'string') {
    return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
  }

  const aspectRatio = sizeToAspectRatio(body.size);
  const styleHint =
    body.style === 'natural'
      ? 'Style: natural, photorealistic, accurate colors and lighting.'
      : 'Style: vivid, saturated colors, high contrast, cinematic lighting.';
  const finalPrompt = `${prompt.trim()}\n\n${styleHint}`;

  const falInput = {
    prompt: finalPrompt,
    num_images: 1,
    aspect_ratio: aspectRatio,
    resolution: '1K',
    output_format: 'png',
    limit_generations: true,
  };

  try {
    const submission = await falSubmit(falInput, apiKey);
    // Try to wait for completion within the sync budget. If it finishes in
    // time, return the URL directly (fast path).
    const result = await pollWithBudget(
      submission.status_url,
      submission.response_url,
      apiKey,
      SYNC_BUDGET_MS,
    );

    if (result) {
      const persisted = await persistOrPassthrough(result);
      return NextResponse.json({
        status: 'completed',
        ...persisted,
        model: FAL_MODEL,
      });
    }

    // Slow path: hand the requestId back, the client will poll.
    return NextResponse.json({
      status: 'pending',
      requestId: submission.request_id,
      statusUrl: submission.status_url,
      responseUrl: submission.response_url,
      model: FAL_MODEL,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[generate-image] submit error:', message);
    return NextResponse.json({ status: 'error', error: message }, { status: 502 });
  }
}
