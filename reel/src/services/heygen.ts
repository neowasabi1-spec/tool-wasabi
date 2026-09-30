/**
 * HeyGen v3 API client.
 * Workflow A (audio pre-generato): upload mp3 → asset_id → POST /v3/videos
 * con avatar_id + audio_asset_id → poll status → download mp4.
 *
 * Engine: selezionato automaticamente da HeyGen in base all'avatar_id.
 * Avatar 4 (quality/turbo) è il top realismo disponibile al 2026-04-25.
 * Avatar 5 (in arrivo) sarà selezionato automaticamente quando uscirà,
 * basta che l'avatar_id passato lo supporti.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const BASE_URL = "https://api.heygen.com/v3";

function apiKey(): string {
  const k = process.env.HEYGEN_API_KEY;
  if (!k) throw new Error("HEYGEN_API_KEY not set in .env");
  return k;
}

export interface UploadAssetResult {
  assetId: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Upload di un file audio (mp3 o wav, max 32 MB) come asset HeyGen.
 * Ritorna l'asset_id da usare come `audio_asset_id` in POST /v3/videos.
 */
export async function uploadAudioAsset(audioPath: string): Promise<UploadAssetResult> {
  const buf = await readFile(audioPath);
  const filename = basename(audioPath);
  const mime = filename.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg";

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: mime }), filename);

  const res = await fetch(`${BASE_URL}/assets`, {
    method: "POST",
    headers: { "x-api-key": apiKey() },
    body: form,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HeyGen upload-asset failed: ${res.status} ${txt}`);
  }

  const json = (await res.json()) as {
    data: { asset_id: string; url: string; mime_type: string; size_bytes: number };
  };
  return {
    assetId: json.data.asset_id,
    url: json.data.url,
    mimeType: json.data.mime_type,
    sizeBytes: json.data.size_bytes,
  };
}

export interface CreateAvatarVideoOptions {
  avatarId: string;
  audioAssetId: string;
  aspectRatio?: "9:16" | "16:9";
  resolution?: "720p" | "1080p" | "4k";
  title?: string;
  callbackUrl?: string;
}

export interface CreateVideoResult {
  videoId: string;
  status: string;
}

/**
 * Crea un video avatar usando audio pre-generato.
 * Engine selezionato in automatico da HeyGen (avatar_4_quality default per
 * photo avatars, future avatar_5 quando l'avatar lo supporterà).
 */
export async function createAvatarVideo(
  options: CreateAvatarVideoOptions
): Promise<CreateVideoResult> {
  const body = {
    type: "avatar" as const,
    avatar_id: options.avatarId,
    audio_asset_id: options.audioAssetId,
    aspect_ratio: options.aspectRatio ?? "9:16",
    resolution: options.resolution ?? "1080p",
    output_format: "mp4" as const,
    ...(options.title ? { title: options.title } : {}),
    ...(options.callbackUrl ? { callback_url: options.callbackUrl } : {}),
  };

  const res = await fetch(`${BASE_URL}/videos`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HeyGen create-video failed: ${res.status} ${txt}`);
  }

  const json = (await res.json()) as {
    data: { video_id: string; status: string };
  };
  return { videoId: json.data.video_id, status: json.data.status };
}

export interface VideoStatus {
  status: "pending" | "processing" | "completed" | "failed" | string;
  videoUrl?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  failureCode?: string;
  failureMessage?: string;
}

/**
 * GET /v3/videos/{video_id} — stato corrente.
 */
export async function getVideoStatus(videoId: string): Promise<VideoStatus> {
  const res = await fetch(`${BASE_URL}/videos/${videoId}`, {
    method: "GET",
    headers: { "x-api-key": apiKey() },
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HeyGen get-video failed: ${res.status} ${txt}`);
  }

  const json = (await res.json()) as {
    data: {
      status: string;
      video_url?: string;
      thumbnail_url?: string;
      duration?: number;
      failure_code?: string;
      failure_message?: string;
    };
  };
  return {
    status: json.data.status,
    videoUrl: json.data.video_url,
    thumbnailUrl: json.data.thumbnail_url,
    durationSec: json.data.duration,
    failureCode: json.data.failure_code,
    failureMessage: json.data.failure_message,
  };
}

/**
 * Polling con backoff esponenziale fino a completed/failed o timeout.
 * Default: 5s iniziale, +20% ogni iterazione, max 30s, timeout totale 10 min.
 */
export async function pollVideoUntilReady(
  videoId: string,
  options?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    timeoutMs?: number;
    onUpdate?: (status: VideoStatus, elapsedMs: number) => void;
  }
): Promise<VideoStatus> {
  const initial = options?.initialDelayMs ?? 5000;
  const maxDelay = options?.maxDelayMs ?? 30000;
  const timeout = options?.timeoutMs ?? 10 * 60 * 1000;

  const start = Date.now();
  let delay = initial;

  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, delay));
    const status = await getVideoStatus(videoId);
    options?.onUpdate?.(status, Date.now() - start);

    if (status.status === "completed") return status;
    if (status.status === "failed") {
      throw new Error(
        `HeyGen video ${videoId} failed: ${status.failureCode ?? "unknown"} - ${status.failureMessage ?? "no message"}`
      );
    }

    delay = Math.min(maxDelay, Math.round(delay * 1.2));
  }

  throw new Error(`HeyGen video ${videoId} timeout dopo ${timeout / 1000}s`);
}

/**
 * Scarica il video completato e lo salva su disco.
 */
export async function downloadVideo(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HeyGen video download failed: ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
}

/**
 * High-level: dato un audio mp3 locale e un avatar_id, ritorna il path
 * locale del video avatar mp4 generato. Gestisce upload + create + poll +
 * download in un'unica chiamata.
 */
export async function generateAvatarVideoFromAudio(args: {
  audioPath: string;
  avatarId: string;
  outputPath: string;
  aspectRatio?: "9:16" | "16:9";
  resolution?: "720p" | "1080p" | "4k";
  title?: string;
  onProgress?: (msg: string) => void;
}): Promise<{ outputPath: string; durationSec?: number; videoId: string }> {
  const log = args.onProgress ?? (() => {});

  log("⬆️  Upload audio asset...");
  const asset = await uploadAudioAsset(args.audioPath);
  log(`   asset_id=${asset.assetId} (${(asset.sizeBytes / 1024).toFixed(0)} KB)`);

  log("🎬 Create avatar video...");
  const create = await createAvatarVideo({
    avatarId: args.avatarId,
    audioAssetId: asset.assetId,
    aspectRatio: args.aspectRatio ?? "9:16",
    resolution: args.resolution ?? "1080p",
    title: args.title,
  });
  log(`   video_id=${create.videoId} status=${create.status}`);

  log("⏳ Polling status...");
  const final = await pollVideoUntilReady(create.videoId, {
    onUpdate: (s, elapsed) => {
      log(`   [${(elapsed / 1000).toFixed(0)}s] status=${s.status}`);
    },
  });

  if (!final.videoUrl) {
    throw new Error(`HeyGen video ${create.videoId} completed senza video_url`);
  }

  log("⬇️  Download video...");
  await downloadVideo(final.videoUrl, args.outputPath);
  log(`   saved → ${args.outputPath}`);

  return { outputPath: args.outputPath, durationSec: final.durationSec, videoId: create.videoId };
}
