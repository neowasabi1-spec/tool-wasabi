import { NextRequest, NextResponse } from 'next/server';
import { openaiImageKey } from '@/lib/openai-image';
import {
  GPT_JOB_MARKER,
  isGptImageJobId,
  newGptImageJobId,
  readGenerateImageJob,
  writeGenerateImageJob,
} from '@/lib/generate-image-job';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// ═══════════════════════════════════════════════════════════════════════════
// Generic media-generation route. Supports 4 modes:
//   • text2image  — prompt -> image
//   • image2image — image + prompt -> edited image
//   • image2video — image + prompt -> short video clip animating that image
//   • text2video  — prompt -> short video clip generated from scratch
//                   (used by "Swipe Video for Product" when the user wants
//                   the AI to invent a brand-new scene without supplying a
//                   first frame)
//
// Image generate/edit defaults to ChatGPT Image 2 on the OpenAI API (not fal).
// Video modes still use fal.ai. Both paths are submit-or-poll so this Next
// handler never waits on the model (OpenAI image gen is a background function).
// ═══════════════════════════════════════════════════════════════════════════

type Mode = 'text2image' | 'image2image' | 'image2video' | 'text2video';
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
  /** Seconda immagine (es. foto del NOSTRO prodotto) da fondere con
   *  `imageUrl` nei modelli edit multi-immagine (Nano Banana 2 / GPT Image 2).
   *  Permette "metti il nostro prodotto al posto di quello nella sorgente". */
  secondaryImageUrl?: string;
  /** Immagini aggiuntive (collage / più foto da combinare) per i modelli
   *  edit multi-immagine. Si accodano a [imageUrl, secondaryImageUrl]. */
  extraImageUrls?: string[];
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
    buildInput: ({ prompt, imageUrl, secondaryImageUrl, extraImageUrls }) => ({
      prompt,
      // Nano Banana 2 edit accetta piu' immagini: [sorgente, prodotto, ...collage].
      image_urls: [imageUrl, secondaryImageUrl, ...(extraImageUrls || [])].filter(Boolean) as string[],
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
    buildInput: ({ prompt, imageUrl, secondaryImageUrl, extraImageUrls }) => ({
      prompt,
      image_urls: [imageUrl, secondaryImageUrl, ...(extraImageUrls || [])].filter(Boolean) as string[],
      image_size: 'auto',
      quality: 'medium',
      num_images: 1,
      output_format: 'png',
    }),
    parseResult: parseImagesResult,
  },

  // ── IMAGE → VIDEO ────────────────────────────────────────────────────────
  'seedance-2': {
    // I modelli Bytedance NON usano il prefisso `fal-ai/` (riservato ai
    // modelli first-party fal). Con `fal-ai/...` il submit girava ma il
    // response_url ritornato puntava a `/seedance-2.0/image-to-video`,
    // generando 404 al polling: "Path /seedance-2.0/image-to-video not found".
    endpoint: 'bytedance/seedance-2.0/image-to-video',
    mediaType: 'video',
    buildInput: ({ prompt, imageUrl, duration }) => ({
      prompt,
      image_url: imageUrl,
      // L'API si aspetta una stringa enum ("4"..."15" oppure "auto"),
      // non un number — passargli un numero faceva fallire la validazione
      // su alcuni endpoint.
      duration: clampSeedanceDuration(duration),
      resolution: '720p',
      // Disabilitiamo l'audio sintetico (default true su Seedance 2.0):
      // l'animazione sostituisce un'immagine in pagina, audio non serve
      // e rischia di sorprendere l'utente con voiceover/SFX random.
      generate_audio: false,
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

  // ── TEXT → VIDEO (no source image — AI invents the scene) ────────────────
  // Stesso pattern di endpoint Bytedance: NO prefisso `fal-ai/`, duration
  // come stringa enum.
  'seedance-2-t2v': {
    endpoint: 'bytedance/seedance-2.0/text-to-video',
    mediaType: 'video',
    buildInput: ({ prompt, aspectRatio, duration }) => ({
      prompt,
      duration: clampSeedanceDuration(duration),
      resolution: '720p',
      aspect_ratio: aspectRatio === 'auto' ? '16:9' : aspectRatio,
      generate_audio: false,
    }),
    parseResult: parseVideoResult,
  },
  'seedance-2-t2v-fast': {
    endpoint: 'bytedance/seedance-2.0/fast/text-to-video',
    mediaType: 'video',
    buildInput: ({ prompt, aspectRatio, duration }) => ({
      prompt,
      duration: clampSeedanceDuration(duration),
      resolution: '720p',
      aspect_ratio: aspectRatio === 'auto' ? '16:9' : aspectRatio,
      generate_audio: false,
    }),
    parseResult: parseVideoResult,
  },
};

const DEFAULT_MODELS: Record<Mode, string> = {
  text2image: 'gpt-image-2',
  image2image: 'gpt-image-2-edit',
  image2video: 'seedance-2',
  text2video: 'seedance-2-t2v',
};

function isGptImageModel(modelKey: string): boolean {
  return modelKey === 'gpt-image-2' || modelKey === 'gpt-image-2-edit';
}

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

function clampSeedanceDuration(d?: number): string {
  // Seedance 2.0 wants a STRING enum: "auto" | "4".."15".
  // La UI espone 5 o 10, qui mappiamo (>=8 → "10", altrimenti "5").
  if (!d) return '5';
  if (d >= 15) return '15';
  if (d >= 8) return '10';
  if (d >= 4) return '5';
  return '5';
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
    if (res.status === 422) {
      throw new Error(
        `fal.ai 422: the model could not fetch the source image (cloned-page URLs are often blocked). Use ChatGPT Image 2 Edit instead. ${err.substring(0, 280)}`,
      );
    }
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
    secondaryImageUrl?: string;
    extraImageUrls?: string[];
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

  // ── POLL ─────────────────────────────────────────────────────────────────
  if (body.action === 'poll') {
    if (isGptImageJobId(body.requestId) || body.statusUrl === GPT_JOB_MARKER) {
      const jobId = String(body.requestId || '').trim();
      if (!jobId) {
        return NextResponse.json({ status: 'error', error: 'Missing job id' }, { status: 400 });
      }
      const job = await readGenerateImageJob(jobId);
      if (!job) {
        return NextResponse.json({ status: 'error', error: 'ChatGPT Image 2 job not found' }, { status: 404 });
      }
      if (job.status === 'completed' && job.url) {
        return NextResponse.json({
          status: 'completed',
          url: job.url,
          mediaType: 'image',
          model: 'openai/gpt-image-2',
          modelKey: body.modelKey || 'gpt-image-2',
        });
      }
      if (job.status === 'error') {
        return NextResponse.json(
          { status: 'error', error: job.error || 'ChatGPT Image 2 failed' },
          { status: 502 },
        );
      }
      return NextResponse.json({
        status: 'pending',
        requestId: jobId,
        statusUrl: GPT_JOB_MARKER,
        responseUrl: GPT_JOB_MARKER,
        modelKey: body.modelKey || 'gpt-image-2',
      });
    }

    const apiKey = getFalKey();
    if (!apiKey) {
      return NextResponse.json(
        {
          status: 'error',
          error:
            'FAL_KEY non configurata. Serve solo per i modelli video / fal, non per ChatGPT Image 2.',
        },
        { status: 500 },
      );
    }
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

  // ChatGPT Image 2: queue a background function. Waiting here 504s on Netlify.
  if (isGptImageModel(modelKey)) {
    if (!openaiImageKey()) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'OPENAI_API_KEY is missing. Image generate/edit uses ChatGPT Image 2 on the OpenAI API.',
        },
        { status: 500 },
      );
    }
    const refs = [
      body.imageUrl,
      body.secondaryImageUrl,
      ...(Array.isArray(body.extraImageUrls) ? body.extraImageUrls : []),
    ].filter((u): u is string => typeof u === 'string' && u.trim().length > 0);
    const jobId = newGptImageJobId();
    const writeErr = await writeGenerateImageJob(jobId, {
      status: 'pending',
      prompt: finalPrompt,
      imageUrls: mode === 'image2image' ? refs : [],
      size: typeof body.size === 'string' ? body.size : undefined,
      createdAt: Date.now(),
    });
    if (writeErr) {
      return NextResponse.json({ status: 'error', error: writeErr }, { status: 500 });
    }
    const origin = (process.env.URL || process.env.DEPLOY_PRIME_URL || req.nextUrl.origin).replace(/\/$/, '');
    let queued = false;
    try {
      const kick = await fetch(`${origin}/.netlify/functions/generate-image-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
        signal: AbortSignal.timeout(8_000),
      });
      queued = kick.status === 202 || kick.ok;
    } catch {
      queued = false;
    }
    return NextResponse.json({
      status: 'pending',
      requestId: jobId,
      statusUrl: GPT_JOB_MARKER,
      responseUrl: GPT_JOB_MARKER,
      modelKey,
      mediaType: 'image',
      model: 'openai/gpt-image-2',
      queued,
    });
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

  const input = modelDef.buildInput({
    prompt: finalPrompt,
    aspectRatio,
    imageUrl: body.imageUrl,
    secondaryImageUrl: body.secondaryImageUrl,
    extraImageUrls: body.extraImageUrls,
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
