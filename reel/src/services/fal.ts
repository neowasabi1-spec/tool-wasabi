import { fal } from "@fal-ai/client";

// fal.ai reads FAL_KEY from env automatically

interface GenerateImageResult {
  url: string;
  width: number;
  height: number;
}

interface GenerateVideoResult {
  url: string;
}

/**
 * Errori transitori che meritano un retry: rate limit, errori server fal,
 * cadute di rete del polling. NON sono transitori (e NON vanno ritentati):
 * 401/403 (chiave sbagliata o saldo esaurito) e 422 (input rifiutato/moderazione)
 * — quelli vanno corretti, riprovarli brucia solo tempo.
 */
function isTransientFalError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") {
    return [408, 429, 500, 502, 503, 504].includes(status);
  }
  const cause = (err as { cause?: unknown })?.cause;
  const msg = [
    err instanceof Error ? err.message : String(err),
    cause instanceof Error ? cause.message : "",
  ].join(" ");
  return /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|timed? ?out/i.test(
    msg
  );
}

/**
 * Retry con backoff sugli errori transitori (3 tentativi: subito, +10s, +30s).
 * Un 429 momentaneo non deve far morire un run da 14 scene.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const delaysSec = [10, 30];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delaysSec.length || !isTransientFalError(err)) throw err;
      const wait = delaysSec[attempt];
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `      ⚠️  ${label}: errore transitorio (${msg.slice(0, 120)}). Retry ${attempt + 1}/${delaysSec.length} tra ${wait}s...`
      );
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

export async function generateImage(
  prompt: string,
  options?: {
    width?: number;
    height?: number;
    model?: string;
  }
): Promise<GenerateImageResult> {
  const model = options?.model ?? "fal-ai/flux-pro/v1.1";

  const result = await withRetry(
    () =>
      fal.subscribe(model, {
        input: {
          prompt,
          image_size: {
            width: options?.width ?? 1080,
            height: options?.height ?? 1920,
          },
          num_images: 1,
        },
      }),
    "image-gen"
  );

  const image = (result.data as any).images[0];
  return {
    url: image.url,
    width: image.width,
    height: image.height,
  };
}

/** Carica un path locale su fal.storage e ritorna l'URL; se è già http, lo ritorna invariato. */
async function toFalUrl(imageUrlOrPath: string): Promise<string> {
  if (imageUrlOrPath.startsWith("http")) return imageUrlOrPath;
  const { readFile } = await import("node:fs/promises");
  const { basename } = await import("node:path");
  const buffer = await readFile(imageUrlOrPath);
  const file = new File([buffer], basename(imageUrlOrPath), { type: "image/png" });
  return fal.storage.upload(file);
}

export async function generateImageToVideo(
  imageUrlOrPath: string,
  prompt?: string,
  options?: {
    duration?: number; // seconds (5 or 10)
    model?: string;
    /**
     * Ultimo frame (tail / last-frame conditioning): Kling interpola DAL
     * first-frame (image_url) A questa immagine finale. Usato per i morph —
     * es. invecchiamento bocca: image_url=labbra giovani, tail=labbra vecchie.
     */
    tailImagePath?: string;
  }
): Promise<GenerateVideoResult> {
  const model =
    options?.model ?? "fal-ai/kling-video/v3/pro/image-to-video";

  const imageUrl = await toFalUrl(imageUrlOrPath);

  const klingDuration = (options?.duration ?? 5) <= 5 ? "5" : "10";
  const input: Record<string, unknown> = {
    image_url: imageUrl,
    prompt: prompt ?? "",
    duration: klingDuration,
  };
  if (options?.tailImagePath) {
    // Kling v3 pro i2v: l'ultimo frame è `end_image_url` (NON tail_image_url).
    // Verificato sullo schema fal: input = start_image_url, end_image_url, ...
    input.end_image_url = await toFalUrl(options.tailImagePath);
  }
  const result = await withRetry(() => fal.subscribe(model, { input }), "Kling i2v");

  const video = (result.data as any).video;
  return { url: video.url };
}

export async function generateTextToVideo(
  prompt: string,
  options?: {
    duration?: number;
    model?: string;
  }
): Promise<GenerateVideoResult> {
  const model = options?.model ?? "fal-ai/kling-video/v3/pro/text-to-video";

  const klingDuration = (options?.duration ?? 5) <= 5 ? "5" : "10";
  const result = await withRetry(
    () =>
      fal.subscribe(model, {
        input: {
          prompt,
          duration: klingDuration,
          aspect_ratio: "9:16",
        },
      }),
    "Kling t2v"
  );

  const video = (result.data as any).video;
  return { url: video.url };
}

/**
 * Un "element" Kling O3 = un personaggio (o oggetto) con identità da preservare
 * durante TUTTA la clip: vista frontale canonica + viste aggiuntive (tre quarti,
 * profilo) che danno al modello l'ancoraggio 3D del soggetto.
 */
export interface KlingElement {
  /** Vista frontale canonica del personaggio (path locale o URL http). */
  frontalImage: string;
  /** Viste aggiuntive dello stesso soggetto (tre quarti, profilo, full-body). */
  referenceImages?: string[];
}

/**
 * Kling O3 reference-to-video con Elements: character consistency a livello
 * VIDEO (binding del soggetto durante il movimento), non solo sul primo frame.
 *
 * Differenza chiave vs generateImageToVideo: l'i2v ancora SOLO il primo frame
 * (il volto è libero di driftare durante azioni/emozioni forti); qui ogni
 * element resta agganciato alle reference per l'intera clip. Nel prompt il
 * personaggio si cita come `@Element1` (`@Element2` per il secondo, ecc.) —
 * NON ridescriverlo a parole: azione + ambiente + camera, l'identità la
 * portano le immagini.
 *
 * Composizione col GATE 4: `startImagePath` (keyframe approvato) fissa
 * composizione/luce/contesto del primo frame, gli elements tengono l'identità.
 *
 * Pricing fal (verificato 2026-06-11): standard $0.084/s audio off,
 * $0.112/s audio on (≈ $0.42 per clip 5s, comparabile all'i2v pro attuale).
 * Schema: https://fal.ai/models/fal-ai/kling-video/o3/standard/reference-to-video/api
 */
export async function generateReferenceToVideo(
  prompt: string,
  elements: KlingElement[],
  options?: {
    duration?: number; // 3-15s (O3 accetta l'intero range)
    model?: string;
    /** First-frame conditioning (es. keyframe approvato GATE 4). */
    startImagePath?: string;
    /** Last-frame conditioning (morph). */
    endImagePath?: string;
    aspectRatio?: "16:9" | "9:16" | "1:1";
    /** Audio nativo Kling. Default false: il VO dei reel è ElevenLabs. */
    generateAudio?: boolean;
  }
): Promise<GenerateVideoResult> {
  const model =
    options?.model ?? "fal-ai/kling-video/o3/standard/reference-to-video";

  const falElements: Array<Record<string, unknown>> = [];
  for (const el of elements) {
    const entry: Record<string, unknown> = {
      frontal_image_url: await toFalUrl(el.frontalImage),
    };
    if (el.referenceImages?.length) {
      entry.reference_image_urls = [];
      for (const ref of el.referenceImages) {
        (entry.reference_image_urls as string[]).push(await toFalUrl(ref));
      }
    }
    falElements.push(entry);
  }

  const duration = Math.min(Math.max(Math.round(options?.duration ?? 5), 3), 15);
  const input: Record<string, unknown> = {
    prompt,
    elements: falElements,
    duration: String(duration),
    aspect_ratio: options?.aspectRatio ?? "9:16",
    generate_audio: options?.generateAudio ?? false,
  };
  if (options?.startImagePath) {
    input.start_image_url = await toFalUrl(options.startImagePath);
  }
  if (options?.endImagePath) {
    input.end_image_url = await toFalUrl(options.endImagePath);
  }

  const result = await withRetry(
    () => fal.subscribe(model, { input }),
    "Kling O3 r2v"
  );

  const video = (result.data as any).video;
  return { url: video.url };
}

/**
 * Veo 3 Fast text-to-video with native audio generation.
 *
 * Use case: talking animals/characters with native lipsync. Veo genera video
 * E audio E lipsync in una singola chiamata, evitando il workflow fragile
 * "genera video → upload → sync.so post-process" che produce artefatti
 * sui musi non-umani (testato e fallito sul reel cats Infobusiness Milionario).
 *
 * Pricing: $0.10/s con audio OFF, $0.15/s con audio ON.
 * Max duration: 8s. Aspect ratio: 16:9 o 9:16. Resolution: 720p o 1080p.
 *
 * Prompt syntax for dialogue (CRITICA — verificata 2026-04-07, generalizzata 2026-06-01):
 *   <Speaker nominato> says (in <Lingua>): "Esatte parole qui."
 *   SFX: <effetti>   /   Ambient: <room tone>      (in paragrafi separati)
 * Il prompt è costruito da buildVeoPrompt() in pipeline.ts a partire dai campi
 * della scena (dialogue / speaker / dialogueLang / sfx / ambient).
 *
 * NON usare:
 *   - "shouting in Italian: 'frase'" mescolato con descrittori (Veo produce gibberish)
 *   - virgolette tipografiche " " (usare sempre " " ASCII)
 *   - subject generico hardcoded ("The cat") su personaggi diversi → voce sbagliata
 *
 * Mettere il dialogo in un PARAGRAFO SEPARATO dalla descrizione visiva e dai
 * descrittori audio.
 */
export async function generateTextToVideoVeo3(
  prompt: string,
  options?: {
    duration?: 4 | 6 | 8;
    resolution?: "720p" | "1080p";
    aspectRatio?: "9:16" | "16:9";
    generateAudio?: boolean;
  }
): Promise<GenerateVideoResult> {
  // Endpoint configurabile via env per A/B qualità senza toccare il codice.
  // Default: veo3/fast ($0.15/s con audio, validato). Ceiling qualità:
  // VEO_MODEL=fal-ai/veo3.1 (o fal-ai/veo3.1/fast). NB: prima di passare a 3.1
  // verificare i nomi dei param di input su fal docs (cfr. feedback_no_trial_and_error).
  const veoModel = process.env.VEO_MODEL?.trim() || "fal-ai/veo3/fast";
  const result = await withRetry(
    () =>
      fal.subscribe(veoModel, {
        input: {
          prompt,
          aspect_ratio: options?.aspectRatio ?? "9:16",
          duration: `${options?.duration ?? 8}s`,
          resolution: options?.resolution ?? "1080p",
          generate_audio: options?.generateAudio ?? true,
        },
        logs: true,
        onQueueUpdate(update) {
          // Logging silente — solo i cambi di stato — per non spammare console
          // (lo stage manager logga già "Scena N" all'inizio).
        },
      }),
    "Veo t2v"
  );

  const video = (result.data as any).video;
  if (!video?.url) {
    throw new Error(
      `Veo 3 Fast: nessun video URL nel result. Data: ${JSON.stringify(result.data).slice(0, 300)}`
    );
  }
  return { url: video.url };
}

/**
 * Veo 3.1 image-to-video CON audio nativo sincronizzato (dialogo + lipsync).
 *
 * Scena dialogata in una sola call: anima e fa il lipsync del soggetto NELL'
 * immagine di input (keyframe approvato) sulle battute scritte inline nel
 * prompt, generando insieme SFX pubblico + room tone. Nessun pass di lipsync
 * separato (a differenza di generateImageToVideo + lipSync / OmniHuman).
 *
 * Parallela generateImageToVideo() (stesso preambolo di upload del path locale)
 * ma usa l'endpoint Veo 3.1 i2v + la semantica generate_audio di
 * generateTextToVideoVeo3(). Il dialogo va inline nel prompt — usare
 * buildVeoPrompt() in pipeline.ts (speaker nominato + "says (in <Lingua>)" +
 * blocchi SFX:/Ambient: in paragrafi separati, virgolette ASCII).
 *
 * Lipsync ITALIANO: fal pubblicizza "multiple languages" ma NON nomina l'italiano
 * → validare con 1 clip prima di qualsiasi batch cliente (cfr. memoria
 * [[feedback_no_trial_and_error]] + [[project_native_audio_talkshow_veo]]).
 * Fallback se l'italiano non regge: i2v muto (generate_audio:false) + VO
 * ElevenLabs + lipSync() (audio-driven, language-agnostic).
 *
 * Schema verificato 2026-06-01 dall'OpenAPI fal (fal-ai/veo3.1/image-to-video):
 *   image_url (req, 9:16 o 16:9, >=720p, <=8MB) · prompt (req) · generate_audio
 *   (bool, default true) · duration "4s"|"6s"|"8s" · aspect_ratio "auto"|"16:9"|
 *   "9:16" · resolution "720p"|"1080p"|"4k" · negative_prompt (opz).
 * Prezzo std con audio: $0.40/s @720p e @1080p (stesso rate), $0.60/s @4k.
 * Endpoint override via env VEO_I2V_MODEL (es. fal-ai/veo3.1/fast/image-to-video
 * a $0.15/s con audio per i batch, dopo aver validato la qualità).
 */
export async function generateImageToVideoWithAudio(
  imageUrlOrPath: string,
  prompt: string,
  options?: {
    duration?: 4 | 6 | 8;
    resolution?: "720p" | "1080p" | "4k";
    aspectRatio?: "9:16" | "16:9" | "auto";
    generateAudio?: boolean;
    negativePrompt?: string;
    autoFix?: boolean; // Veo riscrive il prompt se viola la content policy (default true qui)
    safetyTolerance?: "1" | "2" | "3" | "4" | "5" | "6"; // 1 = più severo, 6 = meno
    model?: string;
  }
): Promise<GenerateVideoResult> {
  const model =
    options?.model || process.env.VEO_I2V_MODEL?.trim() || "fal-ai/veo3.1/image-to-video";

  // Stesso preambolo di upload di generateImageToVideo(): se è un path locale,
  // carica su fal.storage e usa l'URL restituito.
  let imageUrl = imageUrlOrPath;
  if (!imageUrlOrPath.startsWith("http")) {
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    const buffer = await readFile(imageUrlOrPath);
    const file = new File([buffer], basename(imageUrlOrPath), {
      type: "image/png",
    });
    const uploaded = await fal.storage.upload(file);
    imageUrl = uploaded;
  }

  const input: Record<string, unknown> = {
    image_url: imageUrl,
    prompt,
    generate_audio: options?.generateAudio ?? true,
    duration: `${options?.duration ?? 8}s`,
    aspect_ratio: options?.aspectRatio ?? "9:16",
    resolution: options?.resolution ?? "1080p",
    // auto_fix: lascia che Veo riscriva il prompt se il content filter lo rifiuta
    // (il talk-show è confrontazionale → trigger frequente del safety su persone realistiche).
    auto_fix: options?.autoFix ?? true,
  };
  if (options?.negativePrompt) input.negative_prompt = options.negativePrompt;
  if (options?.safetyTolerance) input.safety_tolerance = options.safetyTolerance;

  // input as any: il client @fal-ai/client 1.9.5 può non esporre i tipi
  // generate_audio/resolution per l'endpoint Veo 3.1 (l'API li accetta).
  const result = await withRetry(
    () => fal.subscribe(model, { input: input as any, logs: true }),
    "Veo i2v+audio"
  );

  const video = (result.data as any).video;
  if (!video?.url) {
    throw new Error(
      `Veo 3.1 i2v+audio: nessun video URL nel result. Data: ${JSON.stringify(result.data).slice(0, 300)}`
    );
  }
  return { url: video.url };
}

export async function lipSync(
  videoUrl: string,
  audioUrl: string,
  options?: { maxAttempts?: number }
): Promise<GenerateVideoResult> {
  // sync-lipsync può richiedere 2-5 minuti per scena. Il polling di fal.subscribe
  // a volte cade per errori di rete transient ("fetch failed"). Retriamo fino a
  // maxAttempts volte con backoff prima di arrendersi.
  // Verificato il 2026-04-06: una scena di 3.55s ha richiesto 211s per completare.
  const maxAttempts = options?.maxAttempts ?? 3;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let lastStatus = "";
      const result = await fal.subscribe("fal-ai/sync-lipsync", {
        input: {
          video_url: videoUrl,
          audio_url: audioUrl,
        },
        logs: true,
        onQueueUpdate(update) {
          if (update.status !== lastStatus) {
            lastStatus = update.status;
            console.log(`      [lipsync queue: ${update.status}]`);
          }
        },
      });

      const video = (result.data as any).video;
      return { url: video.url };
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) {
        const backoffMs = attempt * 5000; // 5s, 10s, 15s
        console.log(
          `      ⚠️  lipsync attempt ${attempt}/${maxAttempts} failed: ${msg}. Retry in ${backoffMs / 1000}s...`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      } else {
        console.log(
          `      ❌ lipsync attempt ${attempt}/${maxAttempts} failed: ${msg}. Abbandono.`
        );
      }
    }
  }

  throw lastError ?? new Error("lipSync: unknown error");
}

/**
 * Prompt anti-arti di DEFAULT per OmniHuman v1.5 su personaggi NON-UMANI parlanti
 * (pergamena, animali, oggetti). OmniHuman, animando un "corpo" anomalo, tende a far
 * crescere braccia/mani spurie o duplicate (failure classico del video generativo sugli
 * arti applicato a un corpo non-standard). OmniHuman v1.5 segue il prompt testuale (la
 * v1.0 no): questo prompt sopprime gli arti. Validato 2026-06-15 sul reel N2 (pergamena
 * clay): elimina le braccia allucinate (4/10 → 10/10). Per soggetti UMANI passare "".
 */
export const OMNIHUMAN_NO_LIMBS_PROMPT =
  "The character talks with only its face moving: eyes, eyebrows and the 3D mouth " +
  "articulate to the speech. It has NO arms and NO hands and never grows any. It does " +
  "not gesture. The body stays still without sprouting any limbs, arms, hands or fingers. " +
  "No extra arms, no extra hands, no extra limbs anywhere in the frame.";

/**
 * ByteDance OmniHuman v1.5 — image + audio → talking video.
 *
 * Audio-driven generative model: NON modifica un video esistente, RIGENERA
 * tutto da zero usando l'audio come driver primario del movimento facciale.
 * Funziona su musi felini (testato e confermato 10/10 sul reel cats il 2026-04-07)
 * a differenza di sync.so/lipsync2/veed/latentsync che sono human-only e
 * producono artefatti sui non-human faces.
 *
 * Trade-off: perdiamo il movimento camera del clip source (push-in, dolly,
 * pan) perché parte da una singola immagine statica. In cambio: lipsync
 * effettivo sui musi felini.
 *
 * Pricing: $0.16/secondo (basato sulla durata audio).
 * Max audio: 60s a 720p.
 * Endpoint: fal-ai/bytedance/omnihuman/v1.5
 */
export async function generateOmnihuman(
  imageUrl: string,
  audioUrl: string,
  options?: {
    /**
     * Generation più veloce con leggero trade-off qualità.
     * Default: false (qualità massima).
     */
    turboMode?: boolean;
    /**
     * Prompt opzionale per guidare la generazione.
     * Tipicamente non necessario — il modello è audio-driven.
     */
    prompt?: string;
    /**
     * Risoluzione output. Default: "720p".
     * IMPORTANTE: il test isolato 10/10 sui musi felini usava 720p esplicito.
     * Senza questo parametro l'API default a 1080p e la qualità del lipsync
     * sui musi animali degrada visibilmente. Cast as any perché lo schema TS
     * @fal-ai/client@1.9.5 non espone il campo, ma l'API lo accetta.
     */
    resolution?: "720p" | "1080p";
  }
): Promise<GenerateVideoResult> {
  let lastStatus = "";
  const input: Record<string, unknown> = {
    image_url: imageUrl,
    audio_url: audioUrl,
    turbo_mode: options?.turboMode ?? false,
    resolution: options?.resolution ?? "720p",
  };
  if (options?.prompt) input.prompt = options.prompt;
  const result = await withRetry(
    () =>
      fal.subscribe("fal-ai/bytedance/omnihuman/v1.5", {
        input: input as any,
        logs: true,
        onQueueUpdate(update) {
          if (update.status !== lastStatus) {
            lastStatus = update.status;
          }
        },
      }),
    "OmniHuman"
  );

  const video = (result.data as any).video;
  if (!video?.url) {
    throw new Error(
      `OmniHuman v1.5: nessun video URL nel result. Data: ${JSON.stringify(result.data).slice(0, 300)}`
    );
  }
  return { url: video.url };
}

/** Download a URL to a local file */
export async function downloadAsset(
  url: string,
  outputPath: string
): Promise<void> {
  // Retry anche qui: a questo punto il clip è GIÀ stato pagato — perdere il
  // download per un hiccup di rete significherebbe rigenerarlo.
  await withRetry(async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`download fallito: HTTP ${response.status} per ${url.slice(0, 80)}`);
    }
    const buffer = await response.arrayBuffer();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outputPath, Buffer.from(buffer));
  }, "download asset");
}
