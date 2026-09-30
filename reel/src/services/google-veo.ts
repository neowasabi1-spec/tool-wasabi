import { GoogleGenAI, PersonGeneration } from "@google/genai";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Veo 3.1 via Google DIRETTO (NON fal) — audio nativo multilingua. Due backend:
 *
 *  - **Gemini Developer API** (default, `VEO_BACKEND=gemini` o assente): 1 API key
 *    (`GOOGLE_API_KEY`). Solo modelli PREVIEW → quote BASSE (Tier 1 osservato:
 *    ~2 RPM, ~10 RPD per progetto). `personGeneration` va OMESSO (il valore
 *    esplicito dà 400; il default genera adulti). Output scaricato via SDK.
 *  - **Vertex AI** (`VEO_BACKEND=vertex` o se è presente `GOOGLE_CLOUD_PROJECT`):
 *    modello GA `veo-3.1-fast-generate-001` → 50 RPM + RPD alta, stesso $/secondo.
 *    Auth via ADC (`gcloud auth application-default login`). `personGeneration`
 *    esplicito È ammesso. L'output va su GCS (`VEO_OUTPUT_GCS_URI`) → scaricato
 *    con `gcloud storage cp`. È il path di PRODUZIONE per i reel interi.
 *
 * Recipe validata 2026-06-01 (voto Michel 9/10 su i2v): keyframe approvato -> Veo
 * i2v -> identità esatta + look del keyframe + voce ITALIANA nativa + lipsync, in
 * una call. Perché non fal: fal non espone personGeneration -> 422 sui volti umani.
 *
 * Rate-limit hardening: polling poco frequente (`VEO_POLL_INTERVAL_MS`, default
 * 30s) + jitter + backoff esponenziale sui 429 (`withRetry`). Vedi
 * reel-engine/docs/HANDOFF-veo-unlock.md §13.
 *
 * Prezzo (con audio, identico su Gemini API e Vertex): fast 720p $0.10/s,
 * 1080p $0.12/s; std 720p/1080p $0.40/s.
 */

/** True se l'errore è un 429 / RESOURCE_EXHAUSTED (quota/rate-limit Gemini). */
function isRateLimit(err: unknown): boolean {
  const s = err instanceof Error ? err.message : JSON.stringify(err ?? "");
  return /\b429\b|RESOURCE_EXHAUSTED|exceeded your current quota|rate.?limit/i.test(s);
}

/**
 * Retry con backoff esponenziale + jitter sui 429 della Gemini API. Veo preview
 * = 10 RPM + max 10 concurrent per progetto (verificato 2026-06-01). In batch
 * concorrente i burst di submit + il polling sforano i 10 RPM → 429. Il backoff
 * assorbe il burst invece di abortire l'intera run; gli altri errori rilanciano
 * subito. Vedi reel-engine/docs/HANDOFF-veo-unlock.md §rate-limits.
 */
async function withRetry<T>(fn: () => Promise<T>, onProgress?: (m: string) => void): Promise<T> {
  const maxAttempts = 7;
  let delay = 2000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimit(err) || attempt >= maxAttempts) throw err;
      const wait = delay + Math.floor(Math.random() * 1000);
      onProgress?.(`429 quota — retry ${attempt}/${maxAttempts - 1} tra ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
      delay = Math.min(delay * 2, 64000);
    }
  }
}

export async function generateVeoSceneGoogle(opts: {
  /** Prompt completo (visual + dialogo + SFX/Ambient), da buildVeoPrompt(). */
  prompt: string;
  /** Dove scrivere l'mp4 risultante. */
  destPath: string;
  /** Se presente -> image-to-video (identità ancorata al keyframe). Altrimenti text-to-video. */
  keyframePath?: string;
  duration?: 4 | 6 | 8;
  resolution?: "720p" | "1080p" | "4k";
  aspectRatio?: "9:16" | "16:9";
  model?: string;
  onProgress?: (msg: string) => void;
}): Promise<void> {
  // Backend: Vertex se richiesto esplicitamente o se è configurato un progetto GCP
  // (e non si è forzato 'gemini'). Default = Gemini API (backward compat).
  const useVertex =
    process.env.VEO_BACKEND === "vertex" ||
    (process.env.VEO_BACKEND !== "gemini" && !!process.env.GOOGLE_CLOUD_PROJECT);

  const resolution =
    opts.resolution || (process.env.VEO_GEMINI_RESOLUTION?.trim() as any) || "720p";

  const config: Record<string, unknown> = {
    aspectRatio: opts.aspectRatio ?? "9:16",
    durationSeconds: opts.duration ?? 8,
    resolution,
    numberOfVideos: 1,
  };

  let ai: GoogleGenAI;
  let model: string;

  if (useVertex) {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GOOGLE_CLOUD_LOCATION?.trim() || "us-central1";
    const outputGcsUri = process.env.VEO_OUTPUT_GCS_URI?.trim();
    if (!project) throw new Error("google-veo (Vertex): GOOGLE_CLOUD_PROJECT non presente in .env");
    if (!outputGcsUri)
      throw new Error(
        "google-veo (Vertex): VEO_OUTPUT_GCS_URI non presente (es. gs://mio-bucket/veo-out/) — Veo su Vertex scrive l'output su GCS"
      );
    ai = new GoogleGenAI({ vertexai: true, project, location });
    model = opts.model || process.env.VEO_VERTEX_MODEL?.trim() || "veo-3.1-fast-generate-001";
    // Su Vertex personGeneration esplicito È ammesso (a differenza della Gemini API).
    config.personGeneration = PersonGeneration.ALLOW_ADULT;
    config.outputGcsUri = outputGcsUri;
  } else {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("google-veo: GOOGLE_API_KEY (o GEMINI_API_KEY) non presente in .env");
    }
    ai = new GoogleGenAI({ apiKey });
    model = opts.model || process.env.VEO_GEMINI_MODEL?.trim() || "veo-3.1-fast-generate-preview";
    // NB: personGeneration OMESSO di proposito sulla Gemini API (vedi docblock).
  }

  const req: Record<string, unknown> = { model, prompt: opts.prompt, config };
  if (opts.keyframePath) {
    const imageBytes = (await readFile(opts.keyframePath)).toString("base64");
    req.image = { imageBytes, mimeType: "image/png" };
  }

  const pollMs = Number(process.env.VEO_POLL_INTERVAL_MS) || 30000;
  let op = await withRetry(() => ai.models.generateVideos(req as any), opts.onProgress);
  while (!op.done) {
    await new Promise((r) => setTimeout(r, pollMs + Math.floor(Math.random() * 4000)));
    op = await withRetry(
      () => ai.operations.getVideosOperation({ operation: op }),
      opts.onProgress
    );
    opts.onProgress?.(`done=${op.done ?? false}`);
  }

  // Struttura response (verificata 2026-06-02 su Vertex E Gemini API):
  //   op.response.generatedVideos[0].video.{uri (gs:// su Vertex) | videoBytes}
  const resp = (op as any).response;
  const video = resp?.generatedVideos?.[0]?.video;
  if (!video) {
    const rai = resp?.raiMediaFilteredReasons;
    const detail = rai
      ? `filtro RAI audio/safety: ${JSON.stringify(rai)}`
      : `response inattesa/vuota: ${JSON.stringify(resp ?? (op as any).error ?? null)}`;
    throw new Error(`google-veo: nessun video generato — ${detail.slice(0, 400)}`);
  }

  // Consegna del file: 3 casi.
  if (video.videoBytes) {
    // Inline base64.
    await writeFile(opts.destPath, Buffer.from(video.videoBytes, "base64"));
  } else if (useVertex || (typeof video.uri === "string" && video.uri.startsWith("gs://"))) {
    // Vertex: output su GCS → scarica con gcloud storage cp.
    const uri = video.uri as string | undefined;
    if (!uri) throw new Error("google-veo (Vertex): response senza videoBytes né uri GCS");
    await execFileAsync("gcloud", ["storage", "cp", uri, opts.destPath]);
  } else {
    // Gemini API: file handle scaricabile via SDK.
    await ai.files.download({ file: video, downloadPath: opts.destPath });
  }
}
