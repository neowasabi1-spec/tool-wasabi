/**
 * Higgsfield MCP HTTP client + video generation wrappers.
 *
 * Implementa il protocollo MCP via HTTP JSON-RPC con bearer token (gestito da
 * higgsfield-auth.ts). Wrappers per:
 *   - uploadMediaFile(localPath) → media_id confermato, pronto come start_image
 *   - generateVideoSeedance(mediaId, prompt, opts) → video URL (con polling)
 *   - generateVideoKlingHF(mediaId, prompt, opts) → video URL (con polling)
 *   - downloadVideo(url, outputPath) → download del clip finale
 *
 * Pattern internalizzati dal pilot 2026-05-27 (vedi
 * [[project-pilot-seedance-vs-kling-2026-05-27]]):
 *   - Rate limit: max 6 concurrent jobs su piano Plus (semaforo configurabile)
 *   - Bug "waiting" timeout: job possono rimanere bloccati in "waiting" stato
 *     → retry automatico dopo HIGGSFIELD_JOB_TIMEOUT_MIN minuti (default 8)
 *   - Falso positivo preset_recommendation "IN THE DARK": bypass con
 *     declined_preset_id (passato come campo top-level dei params)
 *
 * Vedi anche [[feedback-memory-into-tools]]: tutto il know-how del pilot è
 * internalizzato qui, niente memorie passive "ricordati di X".
 */

import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ensureValidAccessToken } from "./higgsfield-auth.js";

const MCP_ENDPOINT = process.env.HIGGSFIELD_MCP_URL ?? "https://mcp.higgsfield.ai/mcp";
const MAX_CONCURRENT = parseInt(process.env.HIGGSFIELD_MAX_CONCURRENT ?? "6", 10);
const JOB_TIMEOUT_MIN = parseInt(process.env.HIGGSFIELD_JOB_TIMEOUT_MIN ?? "8", 10);
const DECLINED_PRESET_ID = process.env.HIGGSFIELD_DECLINED_PRESET_ID ?? "24bae836-2c4a-48e0-89b6-49fcc0b21612"; // "IN THE DARK" false positive

let _requestId = 0;
function nextId(): number {
  return ++_requestId;
}

// ---------------------------------------------------------------------------
// JSON-RPC MCP layer
// ---------------------------------------------------------------------------

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

async function mcpRpc<T = unknown>(method: string, params: unknown): Promise<T> {
  const token = await ensureValidAccessToken();
  const response = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId(),
      method,
      params,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MCP ${method} HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  // Supporto sia application/json (single response) sia text/event-stream
  const contentType = response.headers.get("content-type") ?? "";
  let json: JsonRpcResponse<T>;
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    // Estrai il primo evento "message" o "data:"
    const match = text.match(/data:\s*(\{[\s\S]*?\})\s*$/m);
    if (!match) throw new Error(`MCP ${method}: SSE response senza data: ${text.slice(0, 300)}`);
    json = JSON.parse(match[1]) as JsonRpcResponse<T>;
  } else {
    json = (await response.json()) as JsonRpcResponse<T>;
  }

  if (json.error) {
    throw new Error(`MCP ${method} error: ${json.error.code} ${json.error.message}`);
  }
  if (json.result === undefined) {
    throw new Error(`MCP ${method}: result mancante`);
  }
  return json.result;
}

/**
 * Chiama un tool MCP per nome e parsa il payload dal structuredContent o
 * dal blocco di testo se il tool ritorna solo testo.
 */
async function mcpToolCall<T = unknown>(toolName: string, args: unknown): Promise<T> {
  const result = await mcpRpc<McpToolResult>("tools/call", {
    name: toolName,
    arguments: args,
  });

  if (result.isError) {
    const errText = result.content?.find((c) => c.type === "text")?.text ?? "unknown error";
    throw new Error(`Tool ${toolName} error: ${errText}`);
  }

  // Preferenza al structuredContent (oggetto tipizzato)
  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }

  // Fallback: parsa primo blocco di testo come JSON
  const textBlock = result.content?.find((c) => c.type === "text")?.text;
  if (textBlock) {
    try {
      return JSON.parse(textBlock) as T;
    } catch {
      return textBlock as unknown as T;
    }
  }

  throw new Error(`Tool ${toolName}: response vuota`);
}

// ---------------------------------------------------------------------------
// Semaforo concorrenza
// ---------------------------------------------------------------------------

class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    if (this.permits <= 0) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.permits--;
    try {
      return await fn();
    } finally {
      this.permits++;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

const videoSem = new Semaphore(MAX_CONCURRENT);

// ---------------------------------------------------------------------------
// Media upload
// ---------------------------------------------------------------------------

interface MediaUploadResult {
  uploads: Array<{
    upload_url: string;
    media_id: string;
    url: string;
    content_type: string;
    method: "PUT";
  }>;
}

interface MediaConfirmResult {
  results: Array<{
    media_id: string;
    status: "uploaded" | "error";
  }>;
}

/**
 * Carica un'immagine locale su Higgsfield in 2 step (presigned PUT + confirm).
 * Ritorna il media_id confermato, usabile come `start_image` in generate_video.
 */
export async function uploadMediaFile(localPath: string): Promise<string> {
  const filename = basename(localPath);
  const ext = filename.split(".").pop()?.toLowerCase() ?? "png";
  const contentType =
    ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";

  // Step 1: ottieni presigned URL
  const uploadResult = await mcpToolCall<MediaUploadResult>("media_upload", {
    files: [{ filename, content_type: contentType }],
  });

  const upload = uploadResult.uploads?.[0];
  if (!upload) {
    throw new Error(`media_upload: nessun upload URL ritornato`);
  }

  // Step 2: PUT del file binario
  const buffer = await readFile(localPath);
  const putResponse = await fetch(upload.upload_url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: buffer as unknown as BodyInit,
  });
  if (!putResponse.ok) {
    throw new Error(`PUT presigned URL fallito: ${putResponse.status}`);
  }

  // Step 3: confirm
  const confirmResult = await mcpToolCall<MediaConfirmResult>("media_confirm", {
    type: "image",
    media_ids: [upload.media_id],
  });
  const confirmed = confirmResult.results?.[0];
  if (!confirmed || confirmed.status !== "uploaded") {
    throw new Error(`media_confirm fallito per ${upload.media_id}`);
  }

  return upload.media_id;
}

// ---------------------------------------------------------------------------
// Video generation + polling
// ---------------------------------------------------------------------------

interface GenerateVideoResponse {
  results?: Array<{
    id: string;
    type: "video";
    status: "pending" | "in_progress" | "waiting" | "completed" | "failed";
  }>;
  notice?: {
    type: "preset_recommendation";
    data?: { preset?: { id: string } };
  };
}

interface JobStatusResponse {
  generation?: {
    id: string;
    status: "pending" | "in_progress" | "waiting" | "completed" | "failed";
    results?: { rawUrl?: string; thumbnailUrl?: string };
    createdAt?: number;
  };
  poll_after_seconds?: number;
}

interface SeedanceOptions {
  duration?: 4 | 5 | 6 | 8 | 10 | 12 | 15;
  resolution?: "480p" | "720p" | "1080p";
  mode?: "fast" | "std";
  aspectRatio?: "9:16" | "16:9" | "1:1" | "4:3" | "3:4" | "21:9";
}

interface KlingHFOptions {
  duration?: 3 | 5 | 8 | 10 | 15;
  mode?: "std" | "pro" | "4k";
  sound?: "on" | "off";
  aspectRatio?: "9:16" | "16:9" | "1:1";
}

/**
 * Genera un video con Seedance 2.0 (default mode=fast) usando il keyframe come
 * start_image. Ritorna l'URL del video pronto al download.
 *
 * Rispetta il semaforo di concorrenza (default 6) e retry automatico se il job
 * resta in "waiting" oltre HIGGSFIELD_JOB_TIMEOUT_MIN minuti (bug noto Higgsfield).
 */
export async function generateVideoSeedance(
  mediaId: string,
  prompt: string,
  options: SeedanceOptions = {}
): Promise<string> {
  return videoSem.acquire(async () => {
    const params = {
      model: "seedance_2_0",
      prompt,
      duration: options.duration ?? 5,
      aspect_ratio: options.aspectRatio ?? "9:16",
      resolution: options.resolution ?? "720p",
      mode: options.mode ?? "fast",
      declined_preset_id: DECLINED_PRESET_ID,
      medias: [{ role: "start_image", value: mediaId }],
    };
    return await launchAndPoll(params);
  });
}

/**
 * Genera un video con Kling 3.0 via Higgsfield (default mode=std, sound=off).
 */
export async function generateVideoKlingHF(
  mediaId: string,
  prompt: string,
  options: KlingHFOptions = {}
): Promise<string> {
  return videoSem.acquire(async () => {
    const params = {
      model: "kling3_0",
      prompt,
      duration: options.duration ?? 5,
      aspect_ratio: options.aspectRatio ?? "9:16",
      mode: options.mode ?? "std",
      sound: options.sound ?? "off",
      declined_preset_id: DECLINED_PRESET_ID,
      medias: [{ role: "start_image", value: mediaId }],
    };
    return await launchAndPoll(params);
  });
}

/**
 * Wrapper interno: lancia generate_video, gestisce preset_recommendation false
 * positive con auto-retry passando declined_preset_id, poi polla fino al
 * completamento o timeout (con 1 retry su waiting timeout).
 */
async function launchAndPoll(params: unknown, attempt: number = 1): Promise<string> {
  const response = await mcpToolCall<GenerateVideoResponse>("generate_video", { params });

  // Falso positivo preset_recommendation → retry passando declined_preset_id
  if (response.notice?.type === "preset_recommendation") {
    if (attempt > 2) {
      throw new Error(
        `generate_video: preset_recommendation persistente dopo ${attempt} tentativi`
      );
    }
    // Aggiungi/aggiorna declined_preset_id (anche se già presente, ribadiamo)
    const newParams = {
      ...(params as Record<string, unknown>),
      declined_preset_id: response.notice.data?.preset?.id ?? DECLINED_PRESET_ID,
    };
    return launchAndPoll(newParams, attempt + 1);
  }

  const jobId = response.results?.[0]?.id;
  if (!jobId) {
    throw new Error(`generate_video: nessun jobId ritornato`);
  }

  return pollJobUntilDone(jobId);
}

/**
 * Polla un job fino al completamento. Se resta in "waiting" oltre il timeout
 * configurato, ritorna errore (caller può scegliere di riprovare lanciando un
 * nuovo job).
 */
async function pollJobUntilDone(jobId: string): Promise<string> {
  const startedAt = Date.now();
  const timeoutMs = JOB_TIMEOUT_MIN * 60 * 1000;
  let lastWaitingAt: number | null = null;
  let pollInterval = 5_000;

  while (true) {
    const status = await mcpToolCall<JobStatusResponse>("job_status", { jobId });
    const gen = status.generation;
    if (!gen) {
      throw new Error(`job_status ${jobId}: generation mancante`);
    }

    if (gen.status === "completed") {
      const url = gen.results?.rawUrl;
      if (!url) throw new Error(`Job ${jobId} completed senza rawUrl`);
      return url;
    }
    if (gen.status === "failed") {
      throw new Error(`Job ${jobId} failed`);
    }

    // Track "waiting" persistent: timeout watchdog
    if (gen.status === "waiting") {
      if (lastWaitingAt === null) lastWaitingAt = Date.now();
      if (Date.now() - lastWaitingAt > timeoutMs) {
        throw new Error(
          `Job ${jobId} bloccato in 'waiting' per >${JOB_TIMEOUT_MIN} min (bug Higgsfield noto: riprova lanciando un nuovo job)`
        );
      }
    } else {
      lastWaitingAt = null;
    }

    // Timeout assoluto: 3× JOB_TIMEOUT_MIN
    if (Date.now() - startedAt > 3 * timeoutMs) {
      throw new Error(`Job ${jobId} timeout assoluto dopo ${3 * JOB_TIMEOUT_MIN} min`);
    }

    // Usa poll_after_seconds suggerito dal server, fallback 5s
    pollInterval = Math.max(2_000, (status.poll_after_seconds ?? 5) * 1000);
    await new Promise((r) => setTimeout(r, pollInterval));
  }
}

/**
 * Scarica un MP4 da un URL Higgsfield (CDN cloudfront) al path locale.
 */
export async function downloadVideo(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outputPath, buffer);
}

/**
 * Health check: verifica auth + connettività MCP. Ritorna i crediti residui.
 */
export async function checkBalance(): Promise<{ credits: number; plan: string }> {
  const result = await mcpToolCall<{ credits: number; subscription_plan_type: string }>(
    "balance",
    {}
  );
  return { credits: result.credits, plan: result.subscription_plan_type };
}
