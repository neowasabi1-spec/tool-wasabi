import { dirname, join, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm, access, copyFile } from "node:fs/promises";
import {
  generateTextToVideo,
  generateImageToVideo,
  downloadAsset,
  lipSync,
  generateOmnihuman,
  OMNIHUMAN_NO_LIMBS_PROMPT,
} from "./services/fal.js";
import { generateAvatarVideoFromAudio } from "./services/heygen.js";
import { generateVeoSceneGoogle } from "./services/google-veo.js";
import {
  uploadMediaFile as higgsfieldUploadMedia,
  generateVideoSeedance,
  generateVideoKlingHF,
  downloadVideo as higgsfieldDownload,
} from "./services/higgsfield.js";
import { isKeyframeApproved } from "./utils/approval-gate.js";
import { fal } from "@fal-ai/client";
import {
  generateVoiceover,
  generateVoiceoverMulti,
  type WordTimestamp,
} from "./services/elevenlabs.js";
import { enhanceVoiceover } from "./services/voiceover-enhancer.js";
import { secToFrames } from "./utils/duration.js";
import { ensureDir, writeJson, readJson, getOutputDir, hashContent } from "./utils/file-io.js";
import { ensureBinaries } from "./utils/preflight.js";
import { syncDurationsFromAudio } from "./utils/sync-durations.js";
import {
  computeSegmentDurations,
  computeSegmentDurationsFromSegFiles,
  probeSegFileDurations,
  type SceneTimings,
} from "./utils/scene-timings.js";
import {
  buildCompositionProps,
  buildSubtitleWords,
  type CompositionPropsFull,
} from "./utils/composition-props.js";
import type { ReelScript } from "./schemas/script.js";

const execFileAsync = promisify(execFile);

const FPS = 30;

interface PipelineOptions {
  scriptPath?: string;
  script?: ReelScript;
  skipVoiceover?: boolean;
  skipVisuals?: boolean;
  skipEnhance?: boolean;
  /**
   * Se true, NON blocca il run quando una scena ha audio reale > 10s (limite
   * clip Kling). Default: false = blocco prima di Stage 2, perché un clip più
   * corto del suo segmento audio freeza in render (reel non pubblicabile).
   */
  allowOversized?: boolean;
  outputDir?: string;
  /**
   * Path a una directory di un reel precedente da cui riusare:
   *  - assets/voiceover.mp3
   *  - word-timestamps.json
   *
   * Quando presente, la pipeline salta lo STAGE 1 (anche se skipVoiceover non è settato)
   * e usa l'audio + i timestamps esistenti per il sync VO↔scene. Utile per il workflow
   * audio-first: itera audio in run separati (--audio-only), poi genera il video su un
   * audio approvato senza rigenerarlo (--video-only --from <reel-dir>).
   *
   * Se outputDir non è specificato, la pipeline scrive nella stessa directory di
   * `audioFromDir` (riusa lo stesso reel folder).
   */
  audioFromDir?: string;
  /**
   * Se true, lo Stage 2 generazione video Kling salta le scene per cui esiste già
   * un file `assets/scene-N.mp4` valido (durata > 0). Utile quando si aggiunge una
   * scena nuova allo script senza voler ri-spendere Kling sulle altre 12 scene
   * esistenti. Default: false (rigenera tutto come prima).
   */
  skipExistingVideos?: boolean;
  /**
   * Se true, dopo la generazione video applica fal-ai/sync-lipsync a ogni scena
   * con voiceoverSegment. Estrae il chunk audio corrispondente dal voiceover.mp3
   * usando i word-timestamps, lo carica + il scene-N.mp4 a fal.ai, scarica il
   * risultato lipsynced e sostituisce il file originale. Costo: ~$0.30-0.50 per
   * scena. Da usare quando il video è "talking head" (umano o animale parlante).
   *
   * NOTA: sync.so v1/v2/v3 e tutti i lipsync video-to-video falliscono su musi
   * NON umani (gatti, cani). Per animali parlanti usare `omnihuman: true`.
   */
  lipsync?: boolean;
  /**
   * GATE 4 bypass. Se true, lo Stage 2 procede anche se ci sono keyframe non
   * approvati. Default: false (gate enforced). Sconsigliato usare in produzione
   * — il gate esiste per evitare di spendere crediti Higgsfield su keyframe
   * sbagliati.
   */
  bypassKeyframeGate?: boolean;
  /**
   * Se true, applica ByteDance OmniHuman v1.5 (image+audio → talking video).
   * Diverso dal classico lipsync: rigenera il video da zero usando l'audio
   * come driver primario del movimento facciale. Funziona sui musi felini
   * (testato 10/10 il 2026-04-07 sul reel cats Infobusiness Milionario).
   *
   * Pre-requisiti:
   *  - Per ogni scena: deve esistere `assets/scene-N-original.mp4` (o equivalente
   *    pulito senza lipsync precedenti). La pipeline estrae il first-frame.
   *  - Voiceover ElevenLabs deve esistere con word-timestamps + voiceoverSegments
   *    nello script per il sync VO↔scena (per estrarre l'audio chunk corretto).
   *
   * Trade-off: il movimento camera del clip Kling source viene perso (image→video).
   * Costo: ~$0.16/secondo audio, ~$5-8 totali per un reel da 12 scene.
   * Mutuamente esclusivo con `lipsync: true`.
   */
  omnihuman?: boolean;
}

interface PipelineResult {
  outputDir: string;
  script: ReelScript;
  compositionId: string;
  props: CompositionPropsFull;
  durationInFrames: number;
}

export async function runPipeline(
  options: PipelineOptions
): Promise<PipelineResult> {
  // Preflight: ffmpeg/ffprobe sono usati in tutta la pipeline (durate, frame,
  // backup clip). Meglio un errore chiaro subito che un ENOENT a metà run.
  await ensureBinaries(["ffmpeg", "ffprobe"]);

  // Se audioFromDir è specificato senza outputDir, riusa la stessa directory
  // (workflow audio-first: video viene scritto sopra l'audio approvato)
  const outputDir =
    options.outputDir ?? options.audioFromDir ?? getOutputDir();
  const assetsDir = join(outputDir, "assets");
  await ensureDir(assetsDir);

  // Load script
  let script: ReelScript;
  if (options.script) {
    script = options.script;
    await writeJson(join(outputDir, "script.json"), script);
  } else if (options.scriptPath) {
    script = await readJson<ReelScript>(options.scriptPath);
    await writeJson(join(outputDir, "script.json"), script);
  } else {
    script = await readJson<ReelScript>(join(outputDir, "script.json"));
  }

  console.log(`\n🎬 Script: "${script.hook}" (${script.scenes.length} scene, ${script.totalDurationSec}s)`);

  // FORMAT AUDIO — guardia anti-ibrido (vedi resolveAudioMode). Throwa subito su
  // reel ibridi o audioMode incoerente, PRIMA di qualsiasi call API. È la fonte di
  // verità per decidere ElevenLabs vs audio nativo Veo: lo Stage 1 è gateato qui.
  const audioMode = resolveAudioMode(script);
  console.log(
    audioMode === "veo-native"
      ? "   🎚️  Format audio: VEO-NATIVE (audio embedded nei clip Veo, ElevenLabs disattivato)"
      : "   🎚️  Format audio: ELEVENLABS (voiceover esterno + video Kling/HeyGen)"
  );

  // Pre-flight SPLICE — i file sorgente delle scene sourceClip devono esistere
  // ADESSO, non a Stage 2 (quando l'audio è già stato generato e pagato).
  // Stessa risoluzione path di extractClipSegment: assoluto as-is, relativo da reelDir.
  if (!options.skipVisuals) {
    const missingClips: string[] = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const sc = script.scenes[i].sourceClip;
      if (!sc) continue;
      const p = isAbsolute(sc.file) ? sc.file : join(outputDir, sc.file);
      try {
        await access(p);
      } catch {
        missingClips.push(`scena ${i + 1}: ${p}`);
      }
    }
    if (missingClips.length > 0) {
      throw new Error(
        `Pre-flight SPLICE: ${missingClips.length} sourceClip non trovati:\n   ${missingClips.join("\n   ")}\n` +
          `   Correggi i path nello script.json (assoluti, o relativi alla cartella del reel) prima di rilanciare.`
      );
    }
  }

  // STAGE 1: Voiceover
  let voiceoverPath: string | undefined;
  let audioDurationSec = script.totalDurationSec;
  let wordTimestamps: WordTimestamp[] = [];

  // Se è stato fornito audioFromDir, riusa l'audio + word-timestamps esistenti
  // anziché rigenerarli (saves API costs durante l'iterazione audio-first).
  const reuseAudio = !!options.audioFromDir && audioMode === "elevenlabs";
  if (reuseAudio) {
    const fromDir = options.audioFromDir!;
    const reusedAudioPath = join(fromDir, "assets", "voiceover.mp3");
    const reusedTimestampsPath = join(fromDir, "word-timestamps.json");

    console.log(`\n♻️  STAGE 1/3 — Riuso audio esistente da: ${fromDir}`);
    try {
      // Verifica che esistano (ffprobe + readJson lanceranno errore se non ci sono)
      audioDurationSec = await (async () => {
        const { stdout } = await execFileAsync("ffprobe", [
          "-v", "quiet",
          "-print_format", "json",
          "-show_format",
          reusedAudioPath,
        ]);
        return parseFloat(JSON.parse(stdout).format.duration);
      })();
      wordTimestamps = await readJson<WordTimestamp[]>(reusedTimestampsPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Impossibile riusare audio da "${fromDir}". File mancanti o corrotti (voiceover.mp3 / word-timestamps.json): ${msg}`
      );
    }

    voiceoverPath = "assets/voiceover.mp3";
    console.log(
      `   ✅ Riusati ${audioDurationSec.toFixed(1)}s — ${wordTimestamps.length} parole con timestamps`
    );
    // Salva una copia dei timestamps nell'outputDir (se diverso) per coerenza
    if (outputDir !== fromDir) {
      await writeJson(join(outputDir, "word-timestamps.json"), wordTimestamps);
    }
  } else if (!options.skipVoiceover && audioMode === "elevenlabs") {
    const isMultiVoice =
      Array.isArray(script.voiceoverSegments) && script.voiceoverSegments.length > 0;

    if (isMultiVoice) {
      // ----- MULTI-VOICE MODE (dialoghi a 2+ voci) -----
      const segments = script.voiceoverSegments!;
      const defaultModelId = script.voiceModelId ?? "eleven_v3";
      console.log(
        `\n🎙️ STAGE 1/3 — Voiceover MULTI-VOCE (${segments.length} segmenti, ElevenLabs ${defaultModelId})...`
      );
      console.log(`   ⏭️  Enhancer saltato: in multi-voce ogni segmento è già autoriale`);

      const ttsResult = await generateVoiceoverMulti(
        segments,
        join(assetsDir, "voiceover.mp3"),
        { defaultModelId }
      );
      voiceoverPath = "assets/voiceover.mp3";
      audioDurationSec = ttsResult.durationSec;
      wordTimestamps = ttsResult.words;
      console.log(
        `   ✅ ${audioDurationSec.toFixed(1)}s totali — ${wordTimestamps.length} parole con timestamps`
      );
    } else {
      // ----- SINGLE-VOICE MODE (comportamento storico) -----
      const modelId = script.voiceModelId ?? "eleven_v3";
      const voiceId = script.voiceId;
      const supportsAudioTags = modelId === "eleven_v3";

      // Enhance voiceover text con Audio Tags v3 solo se il modello li supporta
      let voiceoverText = script.voiceoverText ?? "";
      if (!voiceoverText.trim()) {
        throw new Error(
          "Pipeline: nessun voiceoverText e nessun voiceoverSegments fornito. Almeno uno è obbligatorio."
        );
      }
      if (!options.skipEnhance && supportsAudioTags) {
        console.log("\n✨ Enhancing voiceover con Audio Tags v3...");
        voiceoverText = enhanceVoiceover(voiceoverText);
        console.log(`   ✅ Testo arricchito`);
      } else if (!supportsAudioTags) {
        console.log(
          `\n⏭️  Enhancer saltato: modello ${modelId} non supporta Audio Tags v3`
        );
      }

      console.log(
        `\n🎙️ STAGE 1/3 — Voiceover (ElevenLabs ${modelId} + timestamps)...`
      );
      const vs = script.voiceSettings;
      const ttsResult = await generateVoiceover(
        voiceoverText,
        join(assetsDir, "voiceover.mp3"),
        {
          voiceId,
          modelId,
          stability: vs?.stability,
          similarityBoost: vs?.similarityBoost,
          style: vs?.style,
          useSpeakerBoost: vs?.useSpeakerBoost,
          speed: vs?.speed,
        }
      );
      if (vs) {
        const parts: string[] = [];
        if (vs.speed !== undefined) parts.push(`speed=${vs.speed}`);
        if (vs.stability !== undefined) parts.push(`stability=${vs.stability}`);
        if (vs.style !== undefined) parts.push(`style=${vs.style}`);
        if (parts.length) console.log(`   🎛️  Voice settings override: ${parts.join(", ")}`);
      }
      voiceoverPath = "assets/voiceover.mp3";
      audioDurationSec = ttsResult.durationSec;
      wordTimestamps = ttsResult.words;
      console.log(
        `   ✅ ${audioDurationSec.toFixed(1)}s — ${wordTimestamps.length} parole con timestamps`
      );
    }

    // Salva timestamps per debug
    await writeJson(join(outputDir, "word-timestamps.json"), wordTimestamps);
  }

  // STAGE 1.5: Auto-sync durationSec dal voiceover reale
  // Allinea ogni durationSec alla durata REALE del voiceoverSegment letta dai
  // word-timestamps PRIMA di generare i clip Kling. Senza questo passaggio i
  // clip vengono richiesti sulle stime manuali nello script.json (spesso più
  // corte dell'audio reale) → Remotion congela l'ultimo frame quando l'audio
  // prosegue. Fix strutturale 2026-05-26: vedi [[feedback_memory_into_tools]]
  // — il workaround "ricordarsi di lanciare regen-scenes.ts" è stato sostituito.
  if (wordTimestamps.length > 0) {
    const sync = syncDurationsFromAudio(script, wordTimestamps);
    if (sync.updated > 0) {
      console.log(
        `\n🔧 STAGE 1.5/3 — Auto-sync durationSec: ${sync.updated} scene aggiornate dal voiceover reale`
      );
      // Persisti nello script.json copia in outputDir (così il render legge i
      // valori corretti) + nello script sorgente (così il prossimo run parte
      // già giusto)
      await writeJson(join(outputDir, "script.json"), script);
      if (options.scriptPath) {
        await writeJson(options.scriptPath, script);
      }
    }
    if (sync.unmatchedScenes.length > 0) {
      const detail = sync.unmatchedScenes.join(", ");
      if (!options.skipVisuals) {
        // BLOCCO (dal 2026-06-10): un segment non matchato = timing della scena
        // sbagliato in silenzio. Prima di spendere in video va corretto.
        throw new Error(
          `Sync VO↔scene: voiceoverSegment non trovato nei timestamps per le scene ${detail}.\n` +
            `   Cause tipiche: (1) il segment non ricalca parola-per-parola il voiceoverText ` +
            `(refusi, parole cambiate in un punto solo); (2) il segment inizia con un audio tag ` +
            `tipo [serious tone] — il tag va lasciato fuori dal segment.\n` +
            `   Correggi lo script.json e rilancia. (Per scene volutamente senza sync: rimuovi il voiceoverSegment.)`
        );
      }
      console.log(
        `   ⚠️  Scene con voiceoverSegment non trovato nei timestamps: ${detail} (durationSec invariato)` +
          ` — al run video questo BLOCCA: correggi i segment prima.`
      );
    }
    if (sync.oversizedScenes.length > 0) {
      const lines = sync.oversizedScenes
        .map((o) => `      Scena ${o.sceneNum}: audio reale ${o.realDurSec.toFixed(2)}s → SPEZZA in 2 scene <10s`)
        .join("\n");
      const guide = `      Vedi reel-engine/CLAUDE.md sezione "REGOLA D'ORO: Sync video↔audio" per il pattern di split.`;
      if (!options.skipVisuals && !options.allowOversized) {
        // BLOCCO (dal 2026-06-10): Kling genera max 10s/clip → un clip più corto
        // del suo audio freeza in render. Fermarsi QUI costa zero; dopo Stage 2
        // costa ~$0.50/scena buttati.
        throw new Error(
          `${sync.oversizedScenes.length} scene con audio > 10s — Kling 3.0 Pro genera max 10s per clip:\n${lines}\n${guide}\n` +
            `   Spezza le scene nello script.json e rilancia. Per forzare comunque (sconsigliato): --allow-oversized.`
        );
      }
      console.log(
        `\n⚠️  ${sync.oversizedScenes.length} scene con audio > 10s — Kling 3.0 Pro genera max 10s per clip:`
      );
      console.log(lines);
      console.log(guide);
      if (options.allowOversized && !options.skipVisuals) {
        console.log(`      ⚠️  --allow-oversized attivo: procedo comunque (le scene freezeranno in render).`);
      }
    }
  }

  // GATE 4 — Keyframe approval enforcement (dal 2026-05-27)
  // Se ci sono scene con keyframe non approvato (marker .approved mancante) —
  // vale per kling-legacy (default) e per i legacy seedance/kling-hf —
  // blocca PRIMA di spendere crediti video.
  if (!options.skipVisuals) {
    await enforceKeyframeGate(script, outputDir, options.bypassKeyframeGate ?? false);
  }

  // STAGE 2: Video clip generation
  // Two modes:
  // - Parallel (default): all scenes via text-to-video in parallel
  // - Continuity: scenes with continuity=true are generated sequentially,
  //   using the last frame of the previous scene as first-frame (image-to-video)
  const sceneVideos: string[] = [];

  if (!options.skipVisuals) {
    const hasContinuity = script.scenes.some((s) => s.continuity);
    const hasHeygen = script.scenes.some((s) => s.provider === "heygen");
    const skipMode = options.skipExistingVideos
      ? " (skip esistenti)"
      : "";

    // Pre-computa sync VO↔scene se ci sono scene HeyGen (servono i chunk audio).
    let heygenCtx: HeygenContext | undefined;
    if (hasHeygen) {
      if (!voiceoverPath || wordTimestamps.length === 0) {
        throw new Error(
          "Scene HeyGen presenti ma manca voiceover o word-timestamps. HeyGen richiede audio pre-generato (voiceoverText obbligatorio)."
        );
      }
      console.log("\n🔗 Pre-sync VO↔scene per scene HeyGen (early)...");
      const earlyTimings = computeSegmentDurations(
        script,
        wordTimestamps,
        audioDurationSec,
        { logger: console.log }
      );
      heygenCtx = {
        voiceoverPath: join(outputDir, voiceoverPath),
        sceneStartSecs: earlyTimings.startSecs,
        sceneEndSecs: earlyTimings.endSecs,
      };
      console.log(`   ✅ Timings pronti per ${earlyTimings.startSecs.length} scene`);
    }

    try {
      if (hasContinuity) {
        console.log(
          `\n🎥 STAGE 2/3 — Generazione video clip con CONTINUITÀ (sequenziale)${skipMode}...`
        );
        await generateScenesWithContinuity(
          script,
          assetsDir,
          sceneVideos,
          options.skipExistingVideos,
          heygenCtx
        );
      } else {
        const providerLabel = scenesWithVideoProvider(script);
        console.log(
          `\n🎥 STAGE 2/3 — Generazione video clip (${providerLabel}, parallelo)${skipMode}...`
        );
        await generateScenesParallel(
          script,
          assetsDir,
          sceneVideos,
          options.skipExistingVideos,
          heygenCtx
        );
      }
    } catch (e) {
      // Arricchisci l'errore col comando di resume ESATTO: i clip già scaricati
      // restano su disco e --skip-existing-videos riprende solo dai buchi.
      const msg = e instanceof Error ? e.message : String(e);
      const scriptArg = options.scriptPath ?? join(outputDir, "script.json");
      throw new Error(
        `${msg}\n   ▶️  Per riprendere senza ripagare i clip già scaricati:\n` +
          `      pnpm reel "${scriptArg}" --video-only --from "${outputDir}" --skip-existing-videos`
      );
    }
  } else {
    // Skip Stage 2 — ma fai DISCOVERY dei video esistenti in outputDir/assets/.
    // Senza questo, in modalità --sync-only o --audio-only-on-existing-folder,
    // composition-props.json sovrascriverebbe i videoUrl con undefined,
    // facendo renderizzare un video con SOLO overlay testo (background nero).
    // Bug riscontrato il 2026-04-06 sul reel cats Infobusiness Milionario.
    console.log(
      "\n📂 STAGE 2/3 — Skip generazione video. Discovery clip esistenti in assets/..."
    );
    let foundCount = 0;
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      // Le scene TEXT-only (visualPrompt vuoto), KINETIC, KINETIC-DASHBOARD e dashboard animate (component) non hanno video — skip.
      // ECCEZIONE: le scene SPLICE (sourceClip) HANNO un clip estratto in assets/scene-N.mp4 → vanno scoperte come video normali.
      if ((!scene.visualPrompt.trim() && !scene.sourceClip) || scene.kinetic || scene.kineticDashboard || scene.dashboardComponent) {
        sceneVideos.push("");
        continue;
      }
      const relPath = `assets/scene-${i + 1}.mp4`;
      const fullPath = join(outputDir, relPath);
      try {
        const { stdout } = await execFileAsync("ffprobe", [
          "-v", "quiet",
          "-print_format", "json",
          "-show_format",
          fullPath,
        ]);
        const dur = parseFloat(JSON.parse(stdout).format.duration);
        if (dur > 0) {
          sceneVideos.push(relPath);
          foundCount++;
        } else {
          sceneVideos.push("");
        }
      } catch {
        sceneVideos.push("");
      }
    }
    console.log(
      `   ✅ Trovati ${foundCount} video clip esistenti su ${script.scenes.length} scene`
    );
  }

  // Modalità audio nativo Veo: l'audio viene dai clip stessi, NON da un voiceover
  // esterno. Bypass totale di Stage 1, sync VO↔scene, e voiceoverUrl finale.
  // Fonte di verità = resolveAudioMode (già risolto + validato a inizio pipeline),
  // non più un'inferenza locale .every(veo3) che poteva divergere dal gate Stage 1.
  const isAllVeoNative = audioMode === "veo-native";

  if (isAllVeoNative) {
    console.log(
      "\n🔊 Modalità AUDIO NATIVO VEO: ignoro voiceoverUrl, ogni scena suona il suo audio embedded"
    );
    voiceoverPath = undefined;
    // wordTimestamps lasciato non-vuoto può ancora essere settato ma non viene usato
  }

  // Build composition props
  const totalDurationInFrames = isAllVeoNative
    ? script.scenes.reduce((sum, s) => sum + secToFrames(s.durationSec), 0) + FPS
    : secToFrames(audioDurationSec) + FPS; // +1 sec buffer

  const hasHook = script.hook.trim() !== "";
  const hasCta = script.cta.trim() !== "";
  const hookFrames = hasHook ? secToFrames(2) : 0;
  const ctaFrames = hasCta ? secToFrames(2) : 0;

  // Calcola durata scene: se abbiamo word timestamps + voiceoverSegment, usa sync reale.
  // In modalità all-veo3 native, il sync VO↔scene è disabilitato (ogni scena = durationSec esatto).
  const hasSegments =
    !isAllVeoNative &&
    wordTimestamps.length > 0 &&
    script.scenes.some((s) => s.voiceoverSegment?.trim());

  let scaledFrames: number[];
  let sceneStartSecs: number[] = [];
  let sceneEndSecs: number[] = [];

  if (hasSegments) {
    // Strategia preferita: leggi le DURATE REALI dei seg-NNN.mp3 (uno per
    // scena) e costruisci la timeline cumulativamente. Bulletproof rispetto
    // ai bug di word-timestamp ElevenLabs (tag spezzati, boundary impreciso).
    const segDurations = await probeSegFileDurations(
      join(outputDir, "assets"),
      script.scenes.length
    );

    let timings: SceneTimings;
    if (segDurations) {
      console.log("\n🔗 Sync VO↔scene: calcolo durate da seg-NNN.mp3 reali (bulletproof)...");
      timings = computeSegmentDurationsFromSegFiles(script, segDurations, {
        logger: console.log,
      });
      console.log(`   ✅ ${timings.frames.length} scene sincronizzate (cumulative seg+silence)`);
    } else {
      console.log("\n🔗 Sync VO↔scene: calcolo durate da word timestamps (fallback)...");
      timings = computeSegmentDurations(script, wordTimestamps, audioDurationSec, {
        logger: console.log,
      });
      console.log(`   ✅ ${timings.frames.length} scene sincronizzate`);
    }
    scaledFrames = timings.frames;
    sceneStartSecs = timings.startSecs;
    sceneEndSecs = timings.endSecs;
  } else {
    // Fallback: scala proporzionale (comportamento precedente)
    const rawSceneFrames = script.scenes.map((s) => secToFrames(s.durationSec));
    const rawTotal = rawSceneFrames.reduce((a, b) => a + b, 0);
    if (rawTotal <= 0) {
      throw new Error(
        "Sync fallback: la somma dei durationSec delle scene è 0 — impossibile distribuire i frame. " +
          "Compila durationSec (> 0) nelle scene dello script.json, oppure fornisci un voiceover con word-timestamps."
      );
    }
    const availableFrames = totalDurationInFrames - hookFrames - ctaFrames;
    const scale = availableFrames / rawTotal;
    scaledFrames = rawSceneFrames.map((f) => Math.round(f * scale));
  }

  // STAGE 2.5: Lipsync (opzionale, attivato da options.lipsync)
  if (options.lipsync && sceneStartSecs.length > 0) {
    console.log("\n👄 STAGE 2.5/3 — Lipsync (fal-ai/sync-lipsync)...");
    await applyLipsyncToScenes(
      script,
      assetsDir,
      sceneVideos,
      join(outputDir, voiceoverPath ?? "assets/voiceover.mp3"),
      sceneStartSecs,
      sceneEndSecs
    );
  } else if (options.lipsync) {
    console.log(
      "\n⚠️  Lipsync richiesto ma sceneStartSecs vuoti (manca sync VO↔scene). Skip."
    );
  }

  // STAGE 2.5b: OmniHuman (opzionale, attivato da options.omnihuman)
  // Audio-driven regeneration: rigenera ogni scena da first-frame Kling +
  // chunk audio ElevenLabs, usando ByteDance OmniHuman v1.5. Funziona sui
  // musi felini a differenza di sync.so/lipsync. Mutuamente esclusivo con
  // options.lipsync (se entrambi true, omnihuman vince perché viene dopo).
  if (options.omnihuman && sceneStartSecs.length > 0) {
    console.log(
      "\n🐱 STAGE 2.5b/3 — OmniHuman v1.5 (audio-driven regeneration, parallel)..."
    );
    await applyOmnihumanToScenes(
      script,
      assetsDir,
      sceneVideos,
      join(outputDir, voiceoverPath ?? "assets/voiceover.mp3"),
      sceneStartSecs,
      sceneEndSecs
    );
  } else if (options.omnihuman) {
    console.log(
      "\n⚠️  OmniHuman richiesto ma sceneStartSecs vuoti (manca sync VO↔scene). Skip."
    );
  }

  const subtitles = buildSubtitleWords(wordTimestamps, FPS);
  const props = buildCompositionProps(
    script,
    sceneVideos,
    scaledFrames,
    voiceoverPath,
    subtitles
  );

  await writeJson(join(outputDir, "composition-props.json"), {
    compositionId: "BasicReel",
    props,
    durationInFrames: totalDurationInFrames,
    // Hash dello script.json scritto in outputDir (writeJson = stringify(_, null, 2)):
    // pnpm render lo confronta col file su disco e auto-ricalcola i props se diverge.
    scriptHash: hashContent(JSON.stringify(script, null, 2)),
  });

  console.log(`\n✅ Pipeline completata!`);
  console.log(`   Durata: ${(totalDurationInFrames / FPS).toFixed(1)}s`);
  console.log(`   Output: ${outputDir}`);
  console.log(`\n   Per renderizzare: pnpm render "${outputDir}"\n`);

  return { outputDir, script, compositionId: "BasicReel", props, durationInFrames: totalDurationInFrames };
}

// ---------------------------------------------------------------------------
// Voiceover↔Scene sync — vedi src/utils/word-matching.ts + scene-timings.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scene generation helpers
// ---------------------------------------------------------------------------

function getClipDuration(scene: ReelScript["scenes"][number]): number {
  return Math.min(Math.max(Math.ceil(scene.durationSec) + 1, 5), 10);
}

/**
 * Determina il FORMAT AUDIO del reel — guardia anti-ibrido a RUNTIME.
 *
 * runPipeline NON valida lo script con Zod (readJson fa un plain JSON.parse), quindi
 * il `.superRefine` dello schema protegge solo i tool che fanno .parse (es. storyboard).
 * Questa funzione è la guardia che protegge `pnpm reel`: è la fonte di verità per
 * decidere se attivare ElevenLabs (Stage 1) o l'audio nativo Veo.
 *
 * Due format mutuamente esclusivi (niente ibrido, deciso 2026-06-01):
 *  - "elevenlabs": voiceover ElevenLabs esterno + video Kling/HeyGen (path un cliente B2B)
 *  - "veo-native": attori Veo 3.1, audio italiano nativo nei clip, niente voiceover
 *
 * Throwa se le scene video mischiano veo3 con kling/heygen (→ doppio audio), o se
 * `script.audioMode` dichiarato contraddice i provider effettivi. Se audioMode è
 * omesso lo deriva. Così ElevenLabs NON parte mai per un reel veo-native (nessuna
 * call sprecata, nessun crash, nessun --skip-voiceover da ricordare); e Kling non
 * viene mai attivato di nascosto su un reel che doveva essere tutto Veo.
 */
function resolveAudioMode(script: ReelScript): "elevenlabs" | "veo-native" {
  const videoScenes = script.scenes.filter(
    (s) =>
      (s.visualPrompt.trim() !== "" || s.provider === "heygen") &&
      !s.kinetic &&
      !s.kineticDashboard &&
      !s.dashboardComponent &&
      !s.imageUrl
  );
  const providers = new Set(videoScenes.map((s) => s.provider ?? "kling"));
  const hasVeo = providers.has("veo3");
  const hasNonVeo = providers.has("kling") || providers.has("heygen");

  if (hasVeo && hasNonVeo) {
    throw new Error(
      "Reel ibrido non supportato: le scene video mischiano provider 'veo3' con 'kling'/'heygen' → doppio audio (clip Veo con voce nativa + voiceover ElevenLabs sopra). Usa un solo format: o TUTTE le scene video veo3 (audio nativo), o NESSUNA."
    );
  }

  const derived: "elevenlabs" | "veo-native" =
    hasVeo && !hasNonVeo ? "veo-native" : "elevenlabs";

  if (script.audioMode && script.audioMode !== derived) {
    throw new Error(
      `audioMode='${script.audioMode}' incoerente con i provider delle scene (derivato: '${derived}'). ` +
        (script.audioMode === "veo-native"
          ? "Per 'veo-native' TUTTE le scene video devono avere provider:'veo3'."
          : "Per 'elevenlabs' NESSUNA scena video può avere provider:'veo3'.")
    );
  }
  return derived;
}

/**
 * Costruisce il prompt Veo 3 combinando visualPrompt + dialogue con la sintassi
 * verificata. Il dialogue viene messo in un PARAGRAFO SEPARATO per evitare che
 * Veo confonda direttive visive e linguistiche (causa di gibberish nel test v1).
 *
 * Sintassi confermata 2026-04-07 sul reel cats Infobusiness Milionario:
 *   The cat says (in Italian): "Esatte parole italiane qui."
 */
/** Etichetta riassuntiva dei provider usati nelle scene di uno script (per logging) */
function scenesWithVideoProvider(script: ReelScript): string {
  const scenesWithVideo = script.scenes.filter((s) => s.visualPrompt.trim() && !s.kinetic && !s.kineticDashboard && !s.dashboardComponent);
  const providers = new Set(scenesWithVideo.map((s) => s.provider ?? "kling"));
  return Array.from(providers)
    .map((p) => (p === "veo3" ? "Veo 3 Fast" : "Kling v3/pro"))
    .join(" + ");
}

function buildVeoPrompt(scene: ReelScript["scenes"][number]): string {
  // Veo rispetta i paragrafi (doppio newline): visual, dialogo e descrittori
  // audio restano in blocchi SEPARATI — mescolarli produce gibberish
  // (verificato 2026-04-07). Speaker NOMINATO + virgolette ASCII (generalizzato
  // 2026-06-01: prima era hardcoded "The cat", sbagliava la voce su personaggi
  // diversi). Vedi [[project_native_audio_talkshow_veo]].
  const blocks: string[] = [scene.visualPrompt.trim()];

  const dialogue = scene.dialogue?.trim();
  if (dialogue) {
    const speaker = scene.speaker?.trim() || "The character on screen";
    const lang = scene.dialogueLang?.trim() || "Italian";
    blocks.push(`${speaker} says (in ${lang}): "${dialogue}"`);
  }

  const audioCues: string[] = [];
  const sfx = scene.sfx?.trim();
  const ambient = scene.ambient?.trim();
  if (sfx) audioCues.push(`SFX: ${sfx}`);
  if (ambient) audioCues.push(`Ambient: ${ambient}`);
  if (audioCues.length) blocks.push(audioCues.join("\n"));

  return blocks.join("\n\n");
}

/**
 * Veo 3 Fast accetta solo durations 4/6/8. Snappa la durationSec della scena
 * al valore Veo più vicino (preferendo arrotondare per eccesso, così non
 * tagliamo dialogo).
 */
function snapVeoDuration(seconds: number): 4 | 6 | 8 {
  if (seconds <= 4) return 4;
  if (seconds <= 6) return 6;
  return 8;
}

// ---------------------------------------------------------------------------
// Lipsync stage (Stage 2.5)
// ---------------------------------------------------------------------------

/**
 * Applica fal-ai/sync-lipsync a ogni scena con video. Per ogni scena:
 *  1. Estrae il chunk audio dal voiceover totale usando ffmpeg (sceneStart→sceneEnd)
 *  2. Carica il chunk audio + lo scene-N.mp4 a fal.ai storage
 *  3. Chiama lipSync(video_url, audio_url)
 *  4. Scarica il video synced
 *  5. STRIPPA l'audio dal video (perché Remotion poi suona il voiceover totale,
 *     altrimenti raddoppieremmo l'audio)
 *  6. Sostituisce scene-N.mp4 con la versione lipsynced silent
 *  7. Backup originale come scene-N-original.mp4 (per re-run safe)
 *
 * Sync.so supporta talking animal use case (cats/dogs/etc), non solo umani.
 * Costo per chiamata: ~$0.30-0.50.
 */
async function applyLipsyncToScenes(
  script: ReelScript,
  assetsDir: string,
  sceneVideos: string[],
  voiceoverPathFull: string,
  sceneStartSecs: number[],
  sceneEndSecs: number[]
): Promise<void> {
  const failedScenes: number[] = [];
  const skippedScenes: number[] = [];

  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const relVideoPath = sceneVideos[i];

    if (!relVideoPath || !scene.visualPrompt.trim()) {
      console.log(`   ⏭️  Scena ${i + 1}: nessun video, skip lipsync`);
      continue;
    }
    if (!scene.voiceoverSegment?.trim()) {
      console.log(`   ⏭️  Scena ${i + 1}: nessun voiceoverSegment, skip lipsync`);
      continue;
    }

    const startSec = sceneStartSecs[i];
    const endSec = sceneEndSecs[i];
    if (startSec === undefined || endSec === undefined || endSec <= startSec) {
      console.log(`   ⚠️  Scena ${i + 1}: timing invalido (${startSec}→${endSec}), skip`);
      continue;
    }

    const fullVideoPath = join(assetsDir, "..", relVideoPath);
    const backupPath = join(assetsDir, `scene-${i + 1}-original.mp4`);
    const audioChunkPath = join(assetsDir, `scene-${i + 1}-audio-chunk.mp3`);
    const lipsyncedRawPath = join(assetsDir, `scene-${i + 1}-lipsynced-raw.mp4`);
    const lipsyncedSilentPath = join(assetsDir, `scene-${i + 1}-lipsynced.mp4`);

    // RESUME: se esiste già il backup (= run precedente ha lipsyncato questa scena),
    // skip e non riprocessare. Permette di ripartire da dove un crash ha interrotto.
    if (await videoFileExists(backupPath)) {
      console.log(
        `   ⏭️  Scena ${i + 1}: backup originale esiste, scena già lipsyncata, skip`
      );
      skippedScenes.push(i + 1);
      continue;
    }

    try {
      // Backup del clip Kling originale (prima di sostituirlo)
      await copyFile(fullVideoPath, backupPath);

      // Estrai chunk audio per la scena dal voiceover totale
      const duration = endSec - startSec;
      console.log(
        `   🎙️  Scena ${i + 1}: estratto chunk audio ${startSec.toFixed(2)}→${endSec.toFixed(2)}s (${duration.toFixed(2)}s)`
      );
      await execFileAsync("ffmpeg", [
        "-y",
        "-i", voiceoverPathFull,
        "-ss", startSec.toFixed(3),
        "-t", duration.toFixed(3),
        "-c:a", "libmp3lame",
        "-b:a", "192k",
        "-ar", "44100",
        "-ac", "1",
        audioChunkPath,
      ]);

      // Upload entrambi a fal.ai storage
      const { readFile } = await import("node:fs/promises");
      const { basename } = await import("node:path");
      const videoBuffer = await readFile(fullVideoPath);
      const audioBuffer = await readFile(audioChunkPath);
      const videoFile = new File([videoBuffer], basename(fullVideoPath), {
        type: "video/mp4",
      });
      const audioFile = new File([audioBuffer], basename(audioChunkPath), {
        type: "audio/mpeg",
      });
      const videoUrl = await fal.storage.upload(videoFile);
      const audioUrl = await fal.storage.upload(audioFile);

      console.log(`   👄 Scena ${i + 1}: lipsync in corso...`);
      const result = await lipSync(videoUrl, audioUrl);
      await downloadAsset(result.url, lipsyncedRawPath);

      // Strippa l'audio dal video lipsynced (Remotion suona il VO totale separatamente)
      await execFileAsync("ffmpeg", [
        "-y",
        "-i", lipsyncedRawPath,
        "-c:v", "copy",
        "-an",
        lipsyncedSilentPath,
      ]);

      // Sostituisci scene-N.mp4 con la versione lipsynced silent
      await copyFile(lipsyncedSilentPath, fullVideoPath);

      // Cleanup intermediate files
      await rm(audioChunkPath, { force: true }).catch(() => {});
      await rm(lipsyncedRawPath, { force: true }).catch(() => {});

      console.log(`   ✅ Scena ${i + 1}: lipsync applicato`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`   ❌ Scena ${i + 1}: lipsync FALLITO — ${msg}`);
      failedScenes.push(i + 1);

      // Rollback: ripristina l'originale dal backup ed elimina il backup
      // così il prossimo run potrà ritentare questa scena
      try {
        await copyFile(backupPath, fullVideoPath);
        await rm(backupPath, { force: true });
        console.log(`      ↩️  Scena ${i + 1}: rollback al video originale OK`);
      } catch (rollbackErr) {
        const rollbackMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        console.log(`      ⚠️  Scena ${i + 1}: rollback fallito — ${rollbackMsg}`);
      }

      // Cleanup file intermedi del tentativo fallito
      await rm(audioChunkPath, { force: true }).catch(() => {});
      await rm(lipsyncedRawPath, { force: true }).catch(() => {});
      await rm(lipsyncedSilentPath, { force: true }).catch(() => {});

      // Continua col prossimo segmento — NON throwiare
    }
  }

  // Riepilogo finale
  console.log("");
  if (skippedScenes.length > 0) {
    console.log(
      `   ⏭️  ${skippedScenes.length} scene già lipsyncate da run precedenti: ${skippedScenes.join(", ")}`
    );
  }
  if (failedScenes.length > 0) {
    console.log(
      `   ⚠️  ${failedScenes.length} scene fallite (rollback applicato): ${failedScenes.join(", ")}`
    );
    console.log(
      `   💡 Rilancia lo stesso comando per ritentare SOLO le scene fallite (le altre saranno skippate via backup)`
    );
  } else {
    console.log(`   ✅ Lipsync completato su tutte le scene`);
  }
}

// ---------------------------------------------------------------------------
// OmniHuman stage (audio-driven regeneration, image+audio → talking video)
// ---------------------------------------------------------------------------

/**
 * Per ogni scena con voiceoverSegment + un clip "original" disponibile:
 *  1. Estrae il first-frame del clip Kling pulito (`scene-N-original.mp4`)
 *  2. Estrae il chunk audio corrispondente dal voiceover ElevenLabs usando
 *     i sceneStartSecs/sceneEndSecs già calcolati dal sync VO↔scena
 *  3. Carica entrambi a fal.ai, chiama omnihuman v1.5
 *  4. Scarica il video risultante e lo salva come `scene-N.mp4` (sostituendo
 *     qualsiasi versione precedente — Veo, lipsync sync.so, ecc.)
 *
 * Esecuzione PARALLELA (Promise.all): N chiamate omnihuman concorrenti su fal.
 * Una scena di 4-5s richiede ~3 minuti, parallel si scala come la più lenta.
 *
 * Resume: se esiste già `scene-N-omnihuman.mp4` valido (marker), skip.
 *
 * Failure: try/catch per scena, le scene fallite vengono elencate alla fine.
 * NON throware per non interrompere il batch.
 */
async function applyOmnihumanToScenes(
  script: ReelScript,
  assetsDir: string,
  sceneVideos: string[],
  voiceoverPathFull: string,
  sceneStartSecs: number[],
  sceneEndSecs: number[]
): Promise<void> {
  const tasks = script.scenes.map(async (scene, i) => {
    const sceneNum = i + 1;
    const relVideoPath = sceneVideos[i];

    if (!relVideoPath || !scene.visualPrompt.trim()) {
      return { sceneNum, skipped: true, reason: "no video" };
    }
    if (!scene.voiceoverSegment?.trim()) {
      return { sceneNum, skipped: true, reason: "no voiceoverSegment" };
    }

    const startSec = sceneStartSecs[i];
    const endSec = sceneEndSecs[i];
    if (startSec === undefined || endSec === undefined || endSec <= startSec) {
      return { sceneNum, skipped: true, reason: `invalid timing ${startSec}→${endSec}` };
    }

    // Source: il clip Kling pulito.
    // Priorità: scene-N-original.mp4 (backup esplicito) > scene-N.mp4 (corrente).
    // Se manca il backup ma esiste il corrente, lo CREIAMO copiando — significa
    // che lo Stage 2 ha appena generato un clip Kling fresco e non è ancora
    // stato fatto il backup.
    const originalPath = join(assetsDir, `scene-${sceneNum}-original.mp4`);
    const fullVideoPath = join(assetsDir, "..", relVideoPath);
    let sourceForFirstFrame = originalPath;
    if (!(await videoFileExists(originalPath))) {
      if (await videoFileExists(fullVideoPath)) {
        // Auto-backup: copia scene-N.mp4 → scene-N-original.mp4
        await copyFile(fullVideoPath, originalPath);
        console.log(
          `   📸 Scena ${sceneNum}: auto-backup creato (scene-${sceneNum}-original.mp4)`
        );
      } else {
        return {
          sceneNum,
          skipped: true,
          reason: `manca sia scene-${sceneNum}-original.mp4 che scene-${sceneNum}.mp4`,
        };
      }
      sourceForFirstFrame = originalPath;
    }

    const firstFramePath = join(assetsDir, `scene-${sceneNum}-omni-firstframe.png`);
    // Audio: NON chunkare il voiceover master — usa direttamente seg-NNN.mp3
    // generato da ElevenLabs (un file per linea di dialogo, voce corretta,
    // zero overlap col segmento successivo). Risolve il bug del 2026-04-07
    // dove il chunking start→start sbavava sulla prima sillaba della scena
    // successiva (ElevenLabs dichiara word boundary in ritardo + audio tag
    // spezzati come "[matter-of-fact" senza ] passano il filtro).
    const segPath = join(
      assetsDir,
      ".tts-segments",
      `seg-${String(sceneNum).padStart(3, "0")}.mp3`
    );
    const omnihumanMarkerPath = join(assetsDir, `scene-${sceneNum}-omnihuman.mp4`);

    // Resume: se esiste già il marker, skip
    if (await videoFileExists(omnihumanMarkerPath)) {
      console.log(`   ⏭️  Scena ${sceneNum}: omnihuman già processata, skip`);
      // Sostituisci scene-N.mp4 col marker (resume safe)
      await copyFile(omnihumanMarkerPath, fullVideoPath);
      return { sceneNum, skipped: true, reason: "already processed" };
    }

    try {
      // Step 1: first-frame.
      // Override: se esiste scene-N-firstframe-override.png in assetsDir,
      // usa quello invece di estrarlo dal clip Kling. Permette di forzare
      // un'immagine specifica (es. estetica preferita da un altro clip).
      const overridePath = join(
        assetsDir,
        `scene-${sceneNum}-firstframe-override.png`
      );
      const { access } = await import("node:fs/promises");
      const overrideExists = await access(overridePath).then(() => true).catch(() => false);
      if (overrideExists) {
        console.log(
          `   🖼️  Scena ${sceneNum}: uso first-frame OVERRIDE (${overridePath.split("/").pop()})`
        );
        await copyFile(overridePath, firstFramePath);
      } else {
        console.log(
          `   🖼️  Scena ${sceneNum}: estraggo first-frame da ${sourceForFirstFrame.split("/").pop()}`
        );
        await execFileAsync("ffmpeg", [
          "-y",
          "-i", sourceForFirstFrame,
          "-frames:v", "1",
          "-q:v", "2",
          firstFramePath,
        ]);
      }

      // Step 2: usa direttamente seg-NNN.mp3 puro (no chunking)
      if (!(await videoFileExists(segPath))) {
        return {
          sceneNum,
          skipped: true,
          reason: `manca seg-${String(sceneNum).padStart(3, "0")}.mp3 in .tts-segments/ — rilancia con --audio-only`,
        };
      }
      console.log(
        `   🎙️  Scena ${sceneNum}: uso seg-${String(sceneNum).padStart(3, "0")}.mp3 (audio puro)`
      );

      // Step 3: upload entrambi a fal storage
      const { readFile } = await import("node:fs/promises");
      const { basename } = await import("node:path");
      const imgBuf = await readFile(firstFramePath);
      const audBuf = await readFile(segPath);
      const imgFile = new File([imgBuf], basename(firstFramePath), {
        type: "image/png",
      });
      const audFile = new File([audBuf], basename(segPath), {
        type: "audio/mpeg",
      });
      const imageUrl = await fal.storage.upload(imgFile);
      const audioUrl = await fal.storage.upload(audFile);

      // Step 4: chiamata omnihuman v1.5.
      // Prompt anti-arti: la scena può fornire `omnihumanPrompt` (override; ""
      // disabilita, utile per soggetti umani); altrimenti default OMNIHUMAN_NO_LIMBS_PROMPT
      // che sopprime le braccia/mani allucinate sui personaggi non-umani parlanti
      // (validato 2026-06-15 reel N2 pergamena clay).
      const omniPrompt =
        scene.omnihumanPrompt !== undefined
          ? scene.omnihumanPrompt
          : OMNIHUMAN_NO_LIMBS_PROMPT;
      console.log(
        `   👄 Scena ${sceneNum}: omnihuman v1.5 in corso...${omniPrompt ? " (prompt anti-arti)" : ""}`
      );
      const result = await generateOmnihuman(imageUrl, audioUrl, {
        prompt: omniPrompt || undefined,
      });

      // Step 5: scarica e salva sia come marker che come scene-N.mp4 attivo
      await downloadAsset(result.url, omnihumanMarkerPath);
      await copyFile(omnihumanMarkerPath, fullVideoPath);

      // Cleanup file intermedi (mantieni il marker per resume)
      // NOTA: NON cancellare segPath — i seg-NNN.mp3 sono asset condivisi in
      // .tts-segments/ e servono per resume futuri.
      await rm(firstFramePath, { force: true }).catch(() => {});

      console.log(`   ✅ Scena ${sceneNum}: omnihuman applicato`);
      return { sceneNum, ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`   ❌ Scena ${sceneNum}: omnihuman FALLITO — ${msg}`);
      // Cleanup intermedi (NON i seg-NNN.mp3 — sono asset condivisi)
      await rm(firstFramePath, { force: true }).catch(() => {});
      return { sceneNum, ok: false, error: msg };
    }
  });

  console.log(
    `   🚀 Lancio ${script.scenes.length} chiamate omnihuman in PARALLELO...`
  );
  const results = await Promise.all(tasks);

  // Riepilogo
  const ok = results.filter((r: any) => r.ok).length;
  const failed = results.filter((r: any) => r.ok === false);
  const skipped = results.filter((r: any) => r.skipped);

  console.log("");
  console.log(`   ✅ Successo: ${ok}/${script.scenes.length}`);
  if (skipped.length > 0) {
    console.log(`   ⏭️  Skip: ${skipped.length}`);
  }
  if (failed.length > 0) {
    console.log(
      `   ⚠️  Fallite: ${failed.map((r: any) => r.sceneNum).join(", ")}`
    );
    console.log(
      `   💡 Rilancia lo stesso comando per ritentare le fallite (le altre saranno skippate via marker scene-N-omnihuman.mp4)`
    );
  }
}

/** Verifica se un scene-N.mp4 esiste già con durata > 0 (per skip incrementale) */
async function videoFileExists(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      filePath,
    ]);
    const dur = parseFloat(JSON.parse(stdout).format.duration);
    return dur > 0;
  } catch {
    return false;
  }
}

/**
 * SPLICE — estrae un segmento [startSec,endSec] da un video sorgente (es. l'ad
 * originale di un "refresh creativo") in destPath, re-encodando al formato reel
 * (1080x1920 / {@link FPS}fps) con audio rimosso, perché in audioMode=elevenlabs
 * il voiceover esterno viene sovrapposto all'intera timeline e l'audio embedded
 * dell'originale lo sporcherebbe. Il re-encode rende il taglio frame-accurate e
 * garantisce un concat pulito accanto ai clip Kling (che possono avere fps/SAR
 * diversi). Se startSec/endSec mancano, estrae l'intero file.
 *
 * Nota FREEZE: se la durata del segmento (endSec-startSec) è inferiore al
 * voiceoverSegment della scena, Remotion congela l'ultimo frame esattamente come
 * con un clip Kling troppo corto. Scegliere il range >= audio, o spezzare la scena.
 */
async function extractClipSegment(
  sourceClip: NonNullable<ReelScript["scenes"][number]["sourceClip"]>,
  reelDir: string,
  destPath: string
): Promise<void> {
  const srcPath = isAbsolute(sourceClip.file)
    ? sourceClip.file
    : join(reelDir, sourceClip.file);
  try {
    await access(srcPath);
  } catch {
    throw new Error(
      `sourceClip non trovato per la scena splice: ${srcPath} (sourceClip.file="${sourceClip.file}"). ` +
        `Path assoluto usato as-is, path relativo risolto da reelDir=${reelDir}.`
    );
  }

  const { startSec, endSec } = sourceClip;
  if (startSec !== undefined && endSec !== undefined && endSec - startSec <= 0) {
    throw new Error(
      `sourceClip con range non valido sulla scena splice: startSec=${startSec} >= endSec=${endSec}.`
    );
  }
  const range =
    startSec !== undefined
      ? ` [${startSec}s→${endSec !== undefined ? `${endSec}s` : "fine"}]`
      : endSec !== undefined
        ? ` [0→${endSec}s]`
        : " (intero file)";
  console.log(
    `   ✂️  SPLICE da ${sourceClip.file}${range} → ${destPath.split("/").pop()} (re-encode 1080x1920/${FPS}fps, -an)...`
  );

  // input-seek (-ss prima di -i) + re-encode = veloce E frame-accurate.
  const args: string[] = ["-y"];
  if (startSec !== undefined) args.push("-ss", String(startSec));
  args.push("-i", srcPath);
  if (endSec !== undefined) {
    args.push("-t", String(startSec !== undefined ? endSec - startSec : endSec));
  }
  // Crop opzionale (rimuove sottotitoli/label impressi nell'originale) PRIMA
  // del rescale 9:16: taglia una frazione dall'alto/basso, poi riempi il frame.
  const top = sourceClip.cropTopFrac ?? 0;
  const bottom = sourceClip.cropBottomFrac ?? 0;
  const preCrop =
    top > 0 || bottom > 0
      ? `crop=iw:ih*${(1 - top - bottom).toFixed(4)}:0:ih*${top.toFixed(4)},`
      : "";
  args.push(
    "-vf",
    `${preCrop}scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=${FPS}`,
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "medium",
    "-crf",
    "18",
    destPath
  );
  await execFileAsync("ffmpeg", args);
}

/**
 * Estrae un chunk audio da un file mp3 sorgente (re-encode mp3 mono 192kbps,
 * stesso encoding del voiceover ElevenLabs originale).
 */
async function extractAudioChunk(
  srcPath: string,
  startSec: number,
  endSec: number,
  outPath: string
): Promise<void> {
  await ensureDir(dirname(outPath));
  const duration = Math.max(0.1, endSec - startSec);
  await execFileAsync("ffmpeg", [
    "-y",
    "-ss", String(startSec),
    "-t", String(duration),
    "-i", srcPath,
    "-acodec", "libmp3lame",
    "-b:a", "192k",
    "-ac", "1",
    outPath,
  ]);
}

/**
 * Contesto necessario per generare scene HeyGen: voiceover globale + sync
 * VO↔scene già calcolato. Le funzioni di scene generation lo usano solo se
 * c'è almeno una scena con `provider: "heygen"`.
 */
interface HeygenContext {
  voiceoverPath: string; // path assoluto al voiceover.mp3 globale
  sceneStartSecs: number[];
  sceneEndSecs: number[];
}

/**
 * Esegue `fn` su ogni item con un cap di concorrenza. Sostituisce un Promise.all
 * non limitato dove il provider ha quote di concorrenza basse (es. Veo via Gemini
 * API diretta su job long-running ~330s): un Promise.all 16-wide farebbe partire
 * 16 generazioni insieme → 429/quota e, peggio, l'abort dell'intera run al primo
 * reject. Qui le generazioni partono a ondate di `limit` (pool di worker che
 * pescano dal prossimo indice). Preserva l'ordine via index. I clip già scaricati
 * restano su disco → --skip-existing-videos riprende dai buchi.
 * Default limit = numero scene (= comportamento Promise.all invariato per i reel
 * Kling, che gestiscono la coda lato fal); override per-run via REEL_SCENE_CONCURRENCY.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const errors: { index: number; error: unknown }[] = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        // Per-item non-fatale: un fallimento (es. filtro RAI audio Veo su UNA
        // scena) NON deve abortire le altre 15 generazioni in volo. Raccolgo
        // l'errore, lascio drenare il pool (tutti i clip buoni vengono scaricati
        // e persistono → --skip-existing-videos riprende solo dai buchi), poi
        // throw un riepilogo con i NUMERI di scena falliti.
        try {
          results[i] = await fn(items[i], i);
        } catch (e) {
          errors.push({ index: i, error: e });
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`   ⚠️  Scena ${i + 1} FALLITA: ${msg.slice(0, 200)}`);
        }
      }
    }
  );
  await Promise.all(workers);
  if (errors.length > 0) {
    const list = errors.map((e) => `#${e.index + 1}`).join(", ");
    throw new Error(
      `${errors.length} scena/e fallite (${list}) — i clip riusciti sono salvati. ` +
        `Correggi/riprova solo quelle scene e rilancia con --skip-existing-videos.`
    );
  }
  return results;
}

/** Generate all scenes in parallel (no continuity) */
async function generateScenesParallel(
  script: ReelScript,
  assetsDir: string,
  out: string[],
  skipExisting: boolean = false,
  heygenCtx?: HeygenContext
): Promise<void> {
  const sceneConcurrency = Math.max(
    1,
    Number(process.env.REEL_SCENE_CONCURRENCY) || script.scenes.length
  );
  const videoResults = await mapWithConcurrency(
    script.scenes,
    sceneConcurrency,
    async (scene, i) => {
      // SPLICE — usa un segmento VERBATIM dell'ad originale come clip (nessuna generazione).
      // Va PRIMA del check visualPrompt-vuoto, altrimenti una scena splice (visualPrompt "")
      // verrebbe classificata come TEXT e renderizzata come schermo nero.
      if (scene.sourceClip) {
        const videoPath = join(assetsDir, `scene-${i + 1}.mp4`);
        const relPath = `assets/scene-${i + 1}.mp4`;
        if (skipExisting && (await videoFileExists(videoPath))) {
          console.log(`   ⏭️  Scena ${i + 1}: splice esistente, skip estrazione`);
          return { index: i, videoPath: relPath };
        }
        await extractClipSegment(scene.sourceClip, dirname(assetsDir), videoPath);
        return { index: i, videoPath: relPath };
      }
      if (!scene.visualPrompt.trim() && scene.provider !== "heygen") {
        if (scene.dashboardComponent) {
          console.log(`   📊 Scena ${i + 1}: DASHBOARD-COMPONENT "${scene.dashboardComponent}" (nessun video)`);
        } else if (scene.kineticDashboard) {
          console.log(`   📊 Scena ${i + 1}: KINETIC-DASHBOARD (nessun video)`);
        } else if (scene.kinetic) {
          console.log(`   🔢 Scena ${i + 1}: KINETIC (nessun video)`);
        } else {
          console.log(`   📝 Scena ${i + 1}: TEXT (nessun video)`);
        }
        return { index: i, videoPath: "" };
      }
      if (scene.dashboardComponent) {
        console.log(`   📊 Scena ${i + 1}: DASHBOARD-COMPONENT "${scene.dashboardComponent}" (nessun video)`);
        return { index: i, videoPath: "" };
      }
      if (scene.kineticDashboard) {
        console.log(`   📊 Scena ${i + 1}: KINETIC-DASHBOARD (nessun video)`);
        return { index: i, videoPath: "" };
      }
      if (scene.kinetic) {
        console.log(`   🔢 Scena ${i + 1}: KINETIC (nessun video)`);
        return { index: i, videoPath: "" };
      }

      const videoPath = join(assetsDir, `scene-${i + 1}.mp4`);
      const relPath = `assets/scene-${i + 1}.mp4`;

      if (skipExisting && (await videoFileExists(videoPath))) {
        console.log(`   ⏭️  Scena ${i + 1}: video esistente, skip generazione`);
        return { index: i, videoPath: relPath };
      }

      const provider = scene.provider ?? "kling";
      let videoResult;

      if (provider === "heygen") {
        if (!heygenCtx) {
          throw new Error(
            `Scena ${i + 1} ha provider=heygen ma manca heygenCtx (voiceover+sync). Verifica che ci sia voiceoverText nel script.`
          );
        }
        const avatarId = scene.avatarId ?? process.env.HEYGEN_DEFAULT_AVATAR_ID;
        if (!avatarId) {
          throw new Error(
            `Scena ${i + 1} provider=heygen ma manca avatarId nello script e HEYGEN_DEFAULT_AVATAR_ID non è settato in .env`
          );
        }
        const startSec = heygenCtx.sceneStartSecs[i];
        const endSec = heygenCtx.sceneEndSecs[i];
        const chunkPath = join(assetsDir, ".heygen-chunks", `chunk-${i + 1}.mp3`);
        await extractAudioChunk(heygenCtx.voiceoverPath, startSec, endSec, chunkPath);
        console.log(
          `   👤 Scena ${i + 1}: HeyGen avatar (chunk audio ${(endSec - startSec).toFixed(1)}s, avatar=${avatarId.slice(0, 8)}…)...`
        );
        await generateAvatarVideoFromAudio({
          audioPath: chunkPath,
          avatarId,
          outputPath: videoPath,
          aspectRatio: "9:16",
          resolution: "1080p",
          title: `reel-scene-${i + 1}`,
          onProgress: (m) => console.log(`      ${m}`),
        });
        console.log(`   ✅ Scena ${i + 1} HeyGen video pronto`);
        return { index: i, videoPath: relPath };
      }

      // NUOVO 2026-05-27: branch su videoEngine (seedance/kling-hf via Higgsfield)
      const engine = resolveVideoEngine(scene);
      if (engine === "seedance" || engine === "kling-hf") {
        const clipDuration = getClipDuration(scene);
        const relPathHf = await generateHiggsfieldVideoForScene(
          scene,
          i + 1,
          assetsDir,
          engine,
          clipDuration
        );
        return { index: i, videoPath: relPathHf };
      }

      if (provider === "veo3") {
        // RIPUNTATO 2026-06-01: Veo via Gemini API DIRETTA (non più fal, che non
        // espone personGeneration → 422 sui volti umani). Keyframe approvato →
        // image-to-video (identità ancorata + look del keyframe); altrimenti
        // text-to-video. Audio italiano nativo + lipsync in una call. Scarica
        // direttamente su videoPath (la Gemini API non ritorna URL pubblici).
        const veoDuration = scene.veoDuration ?? snapVeoDuration(scene.durationSec);
        const reelDir = dirname(assetsDir);
        const keyframeAbs = scene.firstFrameImagePath
          ? scene.firstFrameImagePath
          : scene.keyframe
            ? join(reelDir, scene.keyframe)
            : undefined;
        console.log(
          `   🎬 Scena ${i + 1}: Veo 3.1 Google ${keyframeAbs ? "i2v (keyframe)" : "t2v"} (${veoDuration}s, audio IT nativo)...`
        );
        await generateVeoSceneGoogle({
          prompt: buildVeoPrompt(scene),
          destPath: videoPath,
          keyframePath: keyframeAbs,
          duration: veoDuration,
          aspectRatio: "9:16",
        });
        console.log(`   ✅ Scena ${i + 1} video pronto (Veo Google)`);
        return { index: i, videoPath: relPath };
      }

      // NUOVO 2026-06-06: image-to-video ANCORATO al keyframe approvato.
      // Mirror di generateScenesWithContinuity (firstFrameImage block): una scena con
      // keyframe/firstFrameImagePath ma SENZA continuity finiva qui in text-to-video
      // silenzioso, scartando il keyframe approvato al GATE 4 (root cause un brand cliente v2).
      // Solo il path kling-legacy fal.ai raggiunge questo punto (heygen/higgsfield/veo3
      // sono già gestiti con return sopra).
      {
        const reelDir = dirname(assetsDir);
        const firstFrameImage = scene.firstFrameImagePath
          ? scene.firstFrameImagePath
          : scene.keyframe
            ? join(reelDir, scene.keyframe)
            : undefined;
        if (firstFrameImage) {
          const clipDuration = getClipDuration(scene);
          const motionPrompt = scene.videoMotionPrompt?.trim() || scene.visualPrompt;
          console.log(
            `   🖼️ Scena ${i + 1}: image-to-video da ${scene.firstFrameImagePath ? "immagine fornita" : "keyframe Gemini"} (${clipDuration}s)...`
          );
          const tail = scene.lastFrameImagePath
            ? isAbsolute(scene.lastFrameImagePath)
              ? scene.lastFrameImagePath
              : join(reelDir, scene.lastFrameImagePath)
            : undefined;
          if (tail) console.log(`      ↳ morph verso last-frame: ${scene.lastFrameImagePath}`);
          videoResult = await generateImageToVideo(firstFrameImage, motionPrompt, {
            duration: clipDuration,
            tailImagePath: tail,
          });
          await downloadAsset(videoResult.url, videoPath);
          console.log(`   ✅ Scena ${i + 1} video pronto (first-frame image)`);
          return { index: i, videoPath: relPath };
        }
      }

      const clipDuration = getClipDuration(scene);
      console.log(`   🎬 Scena ${i + 1}: Kling text-to-video (${clipDuration}s)...`);
      videoResult = await generateTextToVideo(scene.visualPrompt, {
        duration: clipDuration,
      });

      await downloadAsset(videoResult.url, videoPath);
      console.log(`   ✅ Scena ${i + 1} video pronto`);
      return { index: i, videoPath: relPath };
    }
  );

  videoResults.sort((a, b) => a.index - b.index);
  videoResults.forEach((v) => out.push(v.videoPath));
}

/**
 * Generate scenes respecting continuity flags.
 *
 * Scenes without continuity (and the first scene) use text-to-video and can
 * run in parallel as a batch. Scenes with continuity=true are generated
 * sequentially: the last frame of the previous scene is extracted with ffmpeg
 * and used as the first-frame for image-to-video.
 *
 * Strategy: walk scenes in order. Collect consecutive non-continuity scenes
 * into a parallel batch, then process continuity scenes one-by-one.
 */
async function generateScenesWithContinuity(
  script: ReelScript,
  assetsDir: string,
  out: string[],
  skipExisting: boolean = false,
  heygenCtx?: HeygenContext
): Promise<void> {
  // Pre-fill output array
  const results: string[] = new Array(script.scenes.length).fill("");

  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];

    // SPLICE — segmento dell'ad originale come clip (no generazione). Va PRIMA del
    // check TEXT/empty, altrimenti la scena splice (visualPrompt "") diventa schermo nero.
    if (scene.sourceClip) {
      const videoPath = join(assetsDir, `scene-${i + 1}.mp4`);
      const relPath = `assets/scene-${i + 1}.mp4`;
      if (skipExisting && (await videoFileExists(videoPath))) {
        console.log(`   ⏭️  Scena ${i + 1}: splice esistente, skip estrazione`);
        results[i] = relPath;
        continue;
      }
      await extractClipSegment(scene.sourceClip, dirname(assetsDir), videoPath);
      results[i] = relPath;
      continue;
    }

    // TEXT-only / KINETIC / KINETIC-DASHBOARD / DASHBOARD-COMPONENT / static IMAGE scene — skip
    if ((!scene.visualPrompt.trim() && scene.provider !== "heygen") || scene.kinetic || scene.kineticDashboard || scene.dashboardComponent || scene.imageUrl) {
      const kind = scene.imageUrl
        ? "IMAGE-STATIC"
        : scene.dashboardComponent
          ? "DASHBOARD-COMPONENT"
          : scene.kineticDashboard
            ? "KINETIC-DASHBOARD"
            : scene.kinetic
              ? "KINETIC"
              : "TEXT";
      const emoji = scene.imageUrl
        ? "🖼️"
        : scene.dashboardComponent
          ? "📊"
          : scene.kineticDashboard
            ? "📊"
            : scene.kinetic
              ? "🔢"
              : "📝";
      console.log(`   ${emoji} Scena ${i + 1}: ${kind} (nessun video)`);
      continue;
    }

    const clipDuration = getClipDuration(scene);
    const videoPath = join(assetsDir, `scene-${i + 1}.mp4`);
    const relPath = `assets/scene-${i + 1}.mp4`;

    if (skipExisting && (await videoFileExists(videoPath))) {
      console.log(`   ⏭️  Scena ${i + 1}: video esistente, skip generazione`);
      results[i] = relPath;
      continue;
    }

    // HeyGen branch: chunk audio dal voiceover globale + create avatar video
    if (scene.provider === "heygen") {
      if (!heygenCtx) {
        throw new Error(
          `Scena ${i + 1} ha provider=heygen ma manca heygenCtx (voiceover+sync).`
        );
      }
      const avatarId = scene.avatarId ?? process.env.HEYGEN_DEFAULT_AVATAR_ID;
      if (!avatarId) {
        throw new Error(
          `Scena ${i + 1} provider=heygen ma manca avatarId nello script e HEYGEN_DEFAULT_AVATAR_ID non è settato in .env`
        );
      }
      const startSec = heygenCtx.sceneStartSecs[i];
      const endSec = heygenCtx.sceneEndSecs[i];
      const chunkPath = join(assetsDir, ".heygen-chunks", `chunk-${i + 1}.mp3`);
      await extractAudioChunk(heygenCtx.voiceoverPath, startSec, endSec, chunkPath);
      console.log(
        `   👤 Scena ${i + 1}: HeyGen avatar (chunk audio ${(endSec - startSec).toFixed(1)}s, avatar=${avatarId.slice(0, 8)}…)...`
      );
      await generateAvatarVideoFromAudio({
        audioPath: chunkPath,
        avatarId,
        outputPath: videoPath,
        aspectRatio: "9:16",
        resolution: "1080p",
        title: `reel-scene-${i + 1}`,
        onProgress: (m) => console.log(`      ${m}`),
      });
      console.log(`   ✅ Scena ${i + 1} HeyGen video pronto`);
      results[i] = relPath;
      continue;
    }

    const firstFrameImage = scene.firstFrameImagePath
      ? scene.firstFrameImagePath
      : scene.keyframe
        ? join(dirname(assetsDir), scene.keyframe)
        : undefined;
    if (firstFrameImage) {
      // --- FIRST-FRAME IMAGE MODE: image-to-video from provided image
      // (firstFrameImagePath esplicito o keyframe da Stage 1.7 Storyboard) ---
      console.log(
        `   🖼️ Scena ${i + 1}: image-to-video da ${scene.firstFrameImagePath ? "immagine fornita" : "keyframe Gemini"} (${clipDuration}s)...`
      );
      const motionPrompt = scene.videoMotionPrompt?.trim() || scene.visualPrompt;
      const tailImage = scene.lastFrameImagePath
        ? isAbsolute(scene.lastFrameImagePath)
          ? scene.lastFrameImagePath
          : join(dirname(assetsDir), scene.lastFrameImagePath)
        : undefined;
      if (tailImage) console.log(`      ↳ morph verso last-frame: ${scene.lastFrameImagePath}`);
      const videoResult = await generateImageToVideo(
        firstFrameImage,
        motionPrompt,
        { duration: clipDuration, tailImagePath: tailImage }
      );
      await downloadAsset(videoResult.url, videoPath);
      results[i] = relPath;
      console.log(`   ✅ Scena ${i + 1} video pronto (first-frame image)`);
    } else if (scene.continuity && i > 0) {
      // --- CONTINUITY MODE: image-to-video from previous scene's last frame ---

      // Find the previous scene that actually has a video
      let prevVideoPath = "";
      for (let j = i - 1; j >= 0; j--) {
        if (results[j]) {
          prevVideoPath = join(assetsDir, "..", results[j]);
          break;
        }
      }

      if (!prevVideoPath) {
        console.log(
          `   ⚠️  Scena ${i + 1}: continuity=true ma nessuna scena precedente ha video. Fallback a text-to-video.`
        );
        const videoResult = await generateTextToVideo(scene.visualPrompt, {
          duration: clipDuration,
        });
        await downloadAsset(videoResult.url, videoPath);
        results[i] = relPath;
        console.log(`   ✅ Scena ${i + 1} video pronto (fallback text-to-video)`);
        continue;
      }

      // Extract last frame from previous video
      console.log(`   🔗 Scena ${i + 1}: estrazione ultimo frame dalla scena precedente...`);
      const lastFramePath = join(assetsDir, `scene-${i + 1}-firstframe.png`);
      await extractLastFrame(prevVideoPath, lastFramePath);

      // Upload last frame and generate image-to-video
      console.log(
        `   🎬 Scena ${i + 1}: image-to-video con continuità (${clipDuration}s)...`
      );
      const videoResult = await generateImageToVideo(lastFramePath, scene.visualPrompt, {
        duration: clipDuration,
      });
      await downloadAsset(videoResult.url, videoPath);
      results[i] = relPath;
      console.log(`   ✅ Scena ${i + 1} video pronto (continuità)`);
    } else {
      // --- STANDARD MODE: text-to-video, branch su provider ---
      // NUOVO 2026-05-27: branch prioritario su videoEngine (seedance/kling-hf via Higgsfield)
      const engine = resolveVideoEngine(scene);
      if (engine === "seedance" || engine === "kling-hf") {
        const relPathHf = await generateHiggsfieldVideoForScene(
          scene,
          i + 1,
          assetsDir,
          engine,
          clipDuration
        );
        results[i] = relPathHf;
        continue;
      }
      const provider = scene.provider ?? "kling";
      if (provider === "veo3") {
        // RIPUNTATO 2026-06-01: Veo via Gemini API DIRETTA (vedi generateScenes).
        const veoDuration = scene.veoDuration ?? snapVeoDuration(scene.durationSec);
        const reelDir = dirname(assetsDir);
        const keyframeAbs = scene.firstFrameImagePath
          ? scene.firstFrameImagePath
          : scene.keyframe
            ? join(reelDir, scene.keyframe)
            : undefined;
        console.log(
          `   🎬 Scena ${i + 1}: Veo 3.1 Google ${keyframeAbs ? "i2v (keyframe)" : "t2v"} (${veoDuration}s, audio IT nativo)...`
        );
        await generateVeoSceneGoogle({
          prompt: buildVeoPrompt(scene),
          destPath: videoPath,
          keyframePath: keyframeAbs,
          duration: veoDuration,
          aspectRatio: "9:16",
        });
        results[i] = relPath;
        console.log(`   ✅ Scena ${i + 1} video pronto (Veo Google)`);
      } else {
        console.log(`   🎬 Scena ${i + 1}: Kling text-to-video (${clipDuration}s)...`);
        const videoResult = await generateTextToVideo(scene.visualPrompt, {
          duration: clipDuration,
        });
        await downloadAsset(videoResult.url, videoPath);
        results[i] = relPath;
        console.log(`   ✅ Scena ${i + 1} video pronto`);
      }
    }
  }

  results.forEach((v) => out.push(v));
}

// ---------------------------------------------------------------------------
// GATE 4 + Higgsfield image-to-video helpers (dal 2026-05-27)
// ---------------------------------------------------------------------------

type ResolvedEngine = "seedance" | "kling-hf" | "kling-legacy" | "veo3" | "heygen";

/**
 * Risolve quale motore video usare per una scena. Mapping (post 2026-05-28):
 *   - videoEngine esplicito → quello
 *   - provider="veo3"/"heygen" → mappato (backward compat)
 *   - provider="kling" → "kling-legacy" (fal.ai)
 *   - DEFAULT (con o senza keyframe) → "kling-legacy" (fal.ai Kling 3.0 Pro)
 *
 * Higgsfield MCP (seedance/kling-hf) disabilitato 2026-05-28: costo irragionevole
 * (~$25-30/reel da 2 min vs ~$5-7 con fal.ai Kling) e qualità inferiore validata
 * sul reel un-reel-cliente. Vedi [[feedback-higgsfield-disabled]].
 */
function resolveVideoEngine(scene: ReelScript["scenes"][number]): ResolvedEngine {
  if (scene.videoEngine) return scene.videoEngine;
  if (scene.provider === "veo3") return "veo3";
  if (scene.provider === "heygen") return "heygen";
  return "kling-legacy";
}

/**
 * GATE 4 — Verifica che tutti i keyframe (scene kling-legacy/seedance/kling-hf
 * con campo `keyframe` popolato) siano approvati prima di spendere crediti
 * video. Throw con messaggio esplicito se mancano marker .approved.
 * Bypass: bypass=true (sconsigliato).
 */
async function enforceKeyframeGate(
  script: ReelScript,
  outputDir: string,
  bypass: boolean
): Promise<void> {
  if (bypass) {
    console.log(
      `\n⚠️  GATE 4 BYPASS — lancio Stage 2 senza richiedere keyframe approvati`
    );
    return;
  }
  const needsApproval: number[] = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const engine = resolveVideoEngine(scene);
    if (
      (engine === "seedance" || engine === "kling-hf" || engine === "kling-legacy") &&
      scene.keyframe
    ) {
      const fullPath = join(outputDir, scene.keyframe);
      const approved = await isKeyframeApproved(fullPath);
      if (!approved) needsApproval.push(i + 1);
    }
  }
  if (needsApproval.length > 0) {
    const galleryPath = join(outputDir, "keyframes.html");
    throw new Error(
      `GATE 4: ${needsApproval.length} keyframe non approvati (scene ${needsApproval.join(", ")}).\n` +
        `   Review: open ${galleryPath}\n` +
        `   Approva: touch ${outputDir}/assets/keyframes/scene-N.png.approved\n` +
        `   Bypass: --bypass-keyframe-gate (sconsigliato, spende crediti su keyframe non validati)`
    );
  }
  const totalNeedingApproval = script.scenes.filter((s) => {
    const e = resolveVideoEngine(s);
    return (e === "seedance" || e === "kling-hf" || e === "kling-legacy") && s.keyframe;
  }).length;
  if (totalNeedingApproval > 0) {
    console.log(`\n✅ GATE 4 — ${totalNeedingApproval} keyframe approvati, procedo con Stage 2`);
  }
}

/**
 * Genera UN video usando Higgsfield (Seedance o Kling-HF) image-to-video.
 * Upload keyframe → generate → polling → download al path locale.
 * Lancia errore se manca il keyframe.
 */
async function generateHiggsfieldVideoForScene(
  scene: ReelScript["scenes"][number],
  sceneNum: number,
  assetsDir: string,
  engine: "seedance" | "kling-hf",
  duration: number
): Promise<string> {
  if (!scene.keyframe) {
    throw new Error(
      `Scena ${sceneNum}: videoEngine=${engine} richiede keyframe — rilancia 'pnpm storyboard' prima dello Stage 2`
    );
  }
  const outputDir = dirname(assetsDir);
  const keyframeFullPath = join(outputDir, scene.keyframe);
  const videoPath = join(assetsDir, `scene-${sceneNum}.mp4`);
  const relPath = `assets/scene-${sceneNum}.mp4`;
  const prompt = scene.videoMotionPrompt?.trim() || scene.visualPrompt;

  console.log(
    `   🎬 Scena ${sceneNum}: ${engine} via Higgsfield (${duration}s, keyframe=${scene.keyframe})...`
  );
  const mediaId = await higgsfieldUploadMedia(keyframeFullPath);

  const safeDuration = clampHiggsfieldDuration(duration, engine);
  let videoUrl: string;
  if (engine === "seedance") {
    videoUrl = await generateVideoSeedance(mediaId, prompt, {
      duration: safeDuration as 4 | 5 | 6 | 8 | 10 | 12 | 15,
      resolution: "720p",
      mode: (scene.videoEngineMode as "fast" | "std" | undefined) ?? "fast",
      aspectRatio: "9:16",
    });
  } else {
    videoUrl = await generateVideoKlingHF(mediaId, prompt, {
      duration: safeDuration as 3 | 5 | 8 | 10 | 15,
      mode: (scene.videoEngineMode as "std" | "pro" | "4k" | undefined) ?? "std",
      sound: "off",
      aspectRatio: "9:16",
    });
  }

  await higgsfieldDownload(videoUrl, videoPath);
  console.log(`   ✅ Scena ${sceneNum} video pronto (${engine})`);
  return relPath;
}

function clampHiggsfieldDuration(d: number, engine: "seedance" | "kling-hf"): number {
  if (engine === "seedance") {
    const allowed = [4, 5, 6, 8, 10, 12, 15];
    return allowed.find((a) => a >= d) ?? 15;
  }
  // kling-hf
  const allowed = [3, 5, 8, 10, 15];
  return allowed.find((a) => a >= d) ?? 15;
}

/**
 * Extract the last frame of a video file using ffmpeg.
 * Uses -sseof to seek from the end — fast and reliable.
 */
async function extractLastFrame(
  videoPath: string,
  outputPath: string
): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-sseof",
    "-0.1",
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    outputPath,
  ]);
}
