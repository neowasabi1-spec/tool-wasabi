import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// ═══════════════════════════════════════════════════════════════════════════
// Generic media-generation route. Supports 3 modes:
//   • text2image  — prompt -> image
//   • image2image — image + prompt -> edited image
//   • image2video — image + prompt -> short video clip
//
// Each mode exposes a curated list of fal.ai models. The route is single-shot:
// every invocation does ONE call to fal (submit OR status+result). Wait time
// is handled entirely by the client polling loop, so we never hit Netlify's
// 10s function wall.
// ═══════════════════════════════════════════════════════════════════════════

type Mode = 'text2image' | 'image2image' | 'image2video';
type MediaType = 'image' | 'video';

interface ModelDef {
  endpoint: string;
  mediaType: MediaType;
  buildInput: (opts: BuildInputOpts) => Record<string, unknown>;
  parseResult: (result: unknown) => { url: string; description?: string };
}

interface BuildInputOpts {
  prompt: string;
  aspectRatio: string;
  imageUrl?: string;
  duration?: number;
}

const MODELS: Record<string, ModelDef> = {
  // ── TEXT → IMAGE ─────────────────────────────────────────────────────────
  'nano-banana-2': {
    endpoint: 'fal-ai/nano-banana-2',
    mediaType: 'image',
    buildInput: ({ prompt, aspectRatio }) => ({
      prompt,
      num_images: 1,
      aspect_ratio: aspectRatio,
      resolution: '1K',
      output_format: 'png',
      limit_generations: true,
    }),
    parseResult: parseImagesResult,
  },
  'flux-schnell': {
    endpoint: 'fal-ai/flux/schnell',
    mediaType: 'image',
    buildInput: ({ prompt, aspectRatio }) => ({
      prompt,
      image_size: aspectRatioToFluxSize(aspectRatio),
      num_inference_steps: 4,
      num_images: 1,
      enable_safety_checker: true,
    }),
    parseResult: parseImagesResult,
  },
  'flux-dev': {
    endpoint: 'fal-ai/flux/dev',
    mediaType: 'image',
    buildInput: ({ prompt, aspectRatio }) => ({
      prompt,
      image_size: aspectRatioToFluxSize(aspectRatio),
      num_inference_steps: 28,
      num_images: 1,
      enable_safety_checker: true,
    }),
    parseResult: parseImagesResult,
  },
  imagen4: {
    endpoint: 'fal-ai/imagen4/preview/fast',
    mediaType: 'image',
    buildInput: ({ prompt, aspectRatio }) => ({
      prompt,
      aspect_ratio: aspectRatio === 'auto' ? '1:1' : aspectRatio,
      num_images: 1,
    }),
    parseResult: parseImagesResult,
  },
  // OpenAI's GPT Image 2 (ChatGPT Image 2). Hosted via fal as `openai/...`.
  // Note: this model is priced significantly higher than Nano Banana / Flux,
  // so we default `quality` to "medium" to keep cost predictable.
  'gpt-image-2': {
    endpoint: 'openai/gpt-image-2',
    mediaType: 'image',
    buildInput: ({ prompt, aspectRatio }) => ({
      prompt,
      image_size: aspectRatioToFluxSize(aspectRatio),
      quality: 'medium',
      num_images: 1,
      output_format: 'png',
    }),
    parseResult: parseImagesResult,
  },

  // ── IMAGE → IMAGE (edit) ─────────────────────────────────────────────────
  'nano-banana-2-edit': {
    endpoint: 'fal-ai/nano-banana-2/edit',
    mediaType: 'image',
    buildInput: ({ prompt, imageUrl }) => ({
      prompt,
      image_urls: imageUrl ? [imageUrl] : [],
      num_images: 1,
      output_format: 'png',
    }),
    parseResult: parseImagesResult,
  },
  'flux-kontext': {
    endpoint: 'fal-ai/flux-pro/kontext',
    mediaType: 'image',
    buildInput: ({ prompt, imageUrl }) => ({
      prompt,
      image_url: imageUrl,
      num_images: 1,
      output_format: 'png',
    }),
    parseResult: parseImagesResult,
  },
  'gpt-image-2-edit': {
    endpoint: 'openai/gpt-image-2/edit',
    mediaType: 'image',
    buildInput: ({ prompt, imageUrl }) => ({
      prompt,
      image_urls: imageUrl ? [imageUrl] : [],
      image_size: 'auto',
      quality: 'medium',
      num_images: 1,
      output_format: 'png',
    }),
    parseResult: parseImagesResult,
  },

  // ── IMAGE → VIDEO ────────────────────────────────────────────────────────
  'seedance-lite': {
    endpoint: 'fal-ai/bytedance/seedance/v1/lite/image-to-video',
    mediaType: 'video',
    buildInput: ({ prompt, imageUrl, duration }) => ({
      prompt,
      image_url: imageUrl,
      duration: clampSeedanceDuration(duration),
      resolution: '720p',
    }),
    parseResult: parseVideoResult,
  },
  'veo3-fast': {
    endpoint: 'fal-ai/veo3/fast/image-to-video',
    mediaType: 'video',
    buildInput: ({ prompt, imageUrl, duration }) => ({
      prompt,
      image_url: imageUrl,
      duration: `${clampVeoDuration(duration)}s`,
      generate_audio: false,
    }),
    parseResult: parseVideoResult,
  },
  'kling-21': {
    endpoint: 'fal-ai/kling-video/v2.1/standard/image-to-video',
    mediaType: 'video',
    buildInput: ({ prompt, imageUrl, duration }) => ({
      prompt,
      image_url: imageUrl,
      duration: clampKlingDuration(duration),
    }),
    parseResult: parseVideoResult,
  },
};

const DEFAULT_MODELS: Record<Mode, string> = {
  text2image: 'nano-banana-2',
  image2image: 'nano-banana-2-edit',
  image2video: 'seedance-lite',
};

// ── helpers ────────────────────────────────────────────────────────────────

function aspectRatioToFluxSize(aspectRatio: string): string {
  switch (aspectRatio) {
    case '16:9':
      return 'landscape_16_9';
    case '9:16':
      return 'portrait_16_9';
    case '4:3':
      return 'landscape_4_3';
    case '3:4':
      return 'portrait_4_3';
    case '1:1':
    case 'auto':
    default:
      return 'square_hd';
  }
}

function clampSeedanceDuration(d?: number): number {
  // Seedance Lite supports 5 or 10 seconds.
  return d && d >= 8 ? 10 : 5;
}

function clampVeoDuration(d?: number): number {
  // Veo 3 Fast: 4-8 seconds typically. Map to 5 or 8.
  return d && d >= 6 ? 8 : 5;
}

function clampKlingDuration(d?: number): string {
  return d && d >= 8 ? '10' : '5';
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

// ── result parsers ─────────────────────────────────────────────────────────

interface FalImage { url: string; content_type?: string; width?: number; height?: number }

function parseImagesResult(result: unknown): { url: string; description?: string } {
  const r = result as { images?: FalImage[]; description?: string };
  const url = r.images?.[0]?.url;
  if (!url) {
    throw new Error(
      r.description
        ? `Modello non ha restituito immagine: ${r.description}`
        : "Modello non ha restituito un'immagine",
    );
  }
  return { url, description: r.description?.trim() || undefined };
}

function parseVideoResult(result: unknown): { url: string; description?: string } {
  // Most fal video models return either `video.url` or `video_url`. Cover both.
  const r = result as {
    video?: { url?: string };
    video_url?: string;
    description?: string;
  };
  const url = r.video?.url || r.video_url;
  if (!url) {
    throw new Error("Modello video non ha restituito un URL");
  }
  return { url, description: r.description?.trim() || undefined };
}

// ── fal API wrappers ───────────────────────────────────────────────────────

interface FalSubmit { request_id: string; status_url: string; response_url: string }
interface FalStatus {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'ERROR';
  error?: string;
  error_type?: string;
}

function getFalKey(): string | null {
  return process.env.FAL_KEY || process.env.FAL_AI_API_KEY || null;
}

async function falSubmit(endpoint: string, input: Record<string, unknown>, apiKey: string): Promise<FalSubmit> {
  const res = await fetch(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${apiKey}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`fal.ai submit ${res.status}: ${err.substring(0, 500)}`);
  }
  return res.json();
}

async function falStatus(statusUrl: string, apiKey: string): Promise<FalStatus> {
  const res = await fetch(statusUrl, {
    headers: { Authorization: `Key ${apiKey}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`fal.ai status ${res.status}: ${err.substring(0, 300)}`);
  }
  return res.json();
}

async function falResult(responseUrl: string, apiKey: string): Promise<unknown> {
  const res = await fetch(responseUrl, {
    headers: { Authorization: `Key ${apiKey}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`fal.ai result ${res.status}: ${err.substring(0, 300)}`);
  }
  return res.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// Route handler
// ═══════════════════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  let body: {
    prompt?: string;
    size?: string;
    style?: string;
    mode?: Mode;
    model?: string;
    imageUrl?: string;
    duration?: number;
    action?: 'submit' | 'poll';
    requestId?: string;
    statusUrl?: string;
    responseUrl?: string;
    modelKey?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ status: 'error', error: 'Body non valido' }, { status: 400 });
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

  // ── POLL ─────────────────────────────────────────────────────────────────
  if (body.action === 'poll') {
    if (!body.requestId || !body.statusUrl || !body.responseUrl || !body.modelKey) {
      return NextResponse.json(
        { status: 'error', error: 'Missing requestId / statusUrl / responseUrl / modelKey' },
        { status: 400 },
      );
    }
    const modelDef = MODELS[body.modelKey];
    if (!modelDef) {
      return NextResponse.json({ status: 'error', error: `Unknown model: ${body.modelKey}` }, { status: 400 });
    }
    try {
      const status = await falStatus(body.statusUrl, apiKey);
      if (status.status === 'COMPLETED') {
        const result = await falResult(body.responseUrl, apiKey);
        const { url, description } = modelDef.parseResult(result);
        return NextResponse.json({
          status: 'completed',
          url,
          revisedPrompt: description,
          mediaType: modelDef.mediaType,
          model: modelDef.endpoint,
        });
      }
      if (status.status === 'ERROR') {
        return NextResponse.json(
          { status: 'error', error: status.error || `fal.ai job failed (${status.error_type || 'unknown'})` },
          { status: 502 },
        );
      }
      return NextResponse.json({
        status: 'pending',
        falStatus: status.status,
        requestId: body.requestId,
        statusUrl: body.statusUrl,
        responseUrl: body.responseUrl,
        modelKey: body.modelKey,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown poll error';
      console.error('[generate-image] poll error:', message);
      return NextResponse.json({ status: 'error', error: message }, { status: 502 });
    }
  }

  // ── SUBMIT ───────────────────────────────────────────────────────────────
  const mode: Mode = body.mode || 'text2image';
  const modelKey = body.model || DEFAULT_MODELS[mode];
  const modelDef = MODELS[modelKey];
  if (!modelDef) {
    return NextResponse.json({ status: 'error', error: `Unknown model: ${modelKey}` }, { status: 400 });
  }

  const prompt = (body.prompt || '').trim();
  if (!prompt) {
    return NextResponse.json({ status: 'error', error: 'Prompt is required' }, { status: 400 });
  }

  if ((mode === 'image2image' || mode === 'image2video') && !body.imageUrl) {
    return NextResponse.json(
      { status: 'error', error: `Per ${mode} serve un'immagine sorgente (imageUrl)` },
      { status: 400 },
    );
  }

  const aspectRatio = sizeToAspectRatio(body.size);
  const styleHint =
    body.style === 'natural'
      ? 'Style: natural, photorealistic, accurate colors and lighting.'
      : 'Style: vivid, saturated colors, high contrast, cinematic lighting.';
  const finalPrompt =
    mode === 'text2image' ? `${prompt}\n\n${styleHint}` : prompt;

  const input = modelDef.buildInput({
    prompt: finalPrompt,
    aspectRatio,
    imageUrl: body.imageUrl,
    duration: body.duration,
  });

  try {
    const submission = await falSubmit(modelDef.endpoint, input, apiKey);
    return NextResponse.json({
      status: 'pending',
      requestId: submission.request_id,
      statusUrl: submission.status_url,
      responseUrl: submission.response_url,
      modelKey,
      mediaType: modelDef.mediaType,
      model: modelDef.endpoint,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[generate-image] submit error:', message);
    return NextResponse.json({ status: 'error', error: message }, { status: 502 });
  }
}
