import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// Nano Banana 2 = Gemini 3.1 Flash Image, hosted on fal.ai.
// Docs: https://fal.ai/models/fal-ai/nano-banana-2/api
const FAL_MODEL = 'fal-ai/nano-banana-2';
const FAL_QUEUE_BASE = `https://queue.fal.run/${FAL_MODEL}`;

// Single-shot route: every request does ONE call to fal (submit OR status+result).
// This means each function invocation completes in well under 2s — there is no
// way it can ever hit Netlify's serverless function wall (10s on Free, 26s on
// Pro). The client side is responsible for polling.

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
  error?: string;
  error_type?: string;
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
    cache: 'no-store',
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
    cache: 'no-store',
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`fal.ai result ${res.status}: ${errText.substring(0, 300)}`);
  }
  return res.json();
}

function unwrapImage(result: FalResult): { url: string; revisedPrompt?: string } {
  const imageEntry = result.images?.[0];
  if (!imageEntry?.url) {
    throw new Error(
      result.description
        ? `fal.ai non ha restituito un'immagine: ${result.description}`
        : "fal.ai non ha restituito un'immagine",
    );
  }
  return {
    url: imageEntry.url,
    revisedPrompt: result.description?.trim() || undefined,
  };
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
      {
        status: 'error',
        error:
          'FAL_KEY non configurata. Settala nelle env var (Netlify > Site configuration > Environment variables) e ridepoia.',
      },
      { status: 500 },
    );
  }

  // ── POLL phase: one shot status check + (if ready) result fetch ─────────────
  if (body.action === 'poll') {
    if (!body.requestId) {
      return NextResponse.json({ status: 'error', error: 'Missing requestId' }, { status: 400 });
    }
    const statusUrl = body.statusUrl || `${FAL_QUEUE_BASE}/requests/${body.requestId}/status`;
    const responseUrl = body.responseUrl || `${FAL_QUEUE_BASE}/requests/${body.requestId}`;
    try {
      const status = await falStatus(statusUrl, apiKey);

      if (status.status === 'COMPLETED') {
        const result = await falResult(responseUrl, apiKey);
        const { url, revisedPrompt } = unwrapImage(result);
        return NextResponse.json({
          status: 'completed',
          url,
          revisedPrompt,
          storage: 'fal',
          model: FAL_MODEL,
        });
      }

      if (status.status === 'ERROR') {
        return NextResponse.json(
          {
            status: 'error',
            error: status.error || `fal.ai job failed (${status.error_type || 'unknown'})`,
          },
          { status: 502 },
        );
      }

      return NextResponse.json({
        status: 'pending',
        falStatus: status.status,
        requestId: body.requestId,
        statusUrl,
        responseUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown poll error';
      console.error('[generate-image] poll error:', message);
      return NextResponse.json({ status: 'error', error: message }, { status: 502 });
    }
  }

  // ── SUBMIT phase: enqueue and return immediately ───────────────────────────
  const prompt = body.prompt;
  if (!prompt || typeof prompt !== 'string') {
    return NextResponse.json({ status: 'error', error: 'Prompt is required' }, { status: 400 });
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
