import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { access } from "node:fs/promises";
import {
  findSegmentStart,
  normalizeForMatch,
  filterRealWords,
} from "./word-matching.js";
import type { ReelScript } from "../schemas/script.js";
import type { WordTimestamp } from "../services/elevenlabs.js";

const execFileAsync = promisify(execFile);

const FPS = 30;

/**
 * Crossfade overlap in frame tra scene consecutive. DEVE corrispondere a
 * `CROSSFADE_FRAMES` in BasicReel.tsx. Attualmente 0 (hard cuts) per
 * evitare percezione di "ritardo audio" (feedback utente 2026-04-07 sul
 * reel cats). Cambiare entrambi insieme o le scene driftano di
 * CROSSFADE_FRAMES × N_scene frames.
 */
export const CROSSFADE_FRAMES = 0;

export interface SceneTimings {
  /** Frame durata per scena (per Remotion composition) */
  frames: number[];
  /** Tempo di start nel voiceover totale per ogni scena (secondi) */
  startSecs: number[];
  /** Tempo di end nel voiceover totale per ogni scena (secondi) */
  endSecs: number[];
}

interface TimingOptions {
  /**
   * Logger opzionale per i messaggi diagnostici della pipeline. Default:
   * no-op. Passa `console.log` da pipeline.ts; lascia vuoto da
   * recalc-props se preferisci silenzio.
   */
  logger?: (msg: string) => void;
}

/**
 * Calcola le durate delle scene a partire dai word-timestamps ElevenLabs.
 *
 * Algoritmo:
 *  1. Per ogni scena, trova lo startSec del suo `voiceoverSegment`
 *  2. Durata scena[i] = startSec[i+1] - startSec[i] + CROSSFADE_FRAMES
 *  3. Scene senza voiceoverSegment → interpolazione dalla scena precedente
 *  4. L'ultima scena copre fino a fine audio
 *
 * Garantisce che ogni scena APPAIA esattamente quando il narratore inizia
 * la frase corrispondente. Le pause tra frasi restano nella scena
 * precedente. Usato come fallback quando i seg-NNN.mp3 non esistono
 * (vedi `computeSegmentDurationsFromSegFiles`).
 */
export function computeSegmentDurations(
  script: ReelScript,
  rawWords: WordTimestamp[],
  totalAudioSec: number,
  options: TimingOptions = {}
): SceneTimings {
  const log = options.logger ?? (() => {});

  const filteredCount = rawWords.length - filterRealWords(rawWords).length;
  if (filteredCount > 0) {
    log(
      `   🏷️  Filtrati ${filteredCount} token non-pronunciabili (tag + punteggiatura) dal word-array`
    );
  }

  // PASS 1: trova lo startSec di ogni scena
  const sceneStartSecs: number[] = [];
  let searchFrom = 0;

  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const segment = scene.voiceoverSegment?.trim();
    if (!segment) {
      sceneStartSecs.push(-1);
      continue;
    }

    const startIdx = findSegmentStart(rawWords, segment, searchFrom);
    if (startIdx === -1) {
      log(`   ⚠️  Scena ${i + 1}: segmento VO non trovato`);
      sceneStartSecs.push(-1);
      continue;
    }

    const segStartSec = rawWords[startIdx].startSec;
    sceneStartSecs.push(segStartSec);

    const segWords = normalizeForMatch(segment).split(" ");
    const lastWordIdx = Math.min(
      startIdx + segWords.length - 1,
      rawWords.length - 1
    );
    searchFrom = lastWordIdx + 1;

    log(
      `   📍 Scena ${i + 1}: "${segment.slice(0, 50)}..." → inizia a ${segStartSec.toFixed(2)}s`
    );
  }

  // Prima scena inizia sempre a 0
  if (sceneStartSecs[0] !== -1) sceneStartSecs[0] = 0;

  // Interpola scene senza segmento VO (basate sulla scena precedente)
  for (let i = 0; i < sceneStartSecs.length; i++) {
    if (sceneStartSecs[i] === -1) {
      if (i > 0 && sceneStartSecs[i - 1] !== -1) {
        sceneStartSecs[i] =
          sceneStartSecs[i - 1] + script.scenes[i - 1].durationSec;
      } else {
        let acc = 0;
        for (let j = 0; j < i; j++) acc += script.scenes[j].durationSec;
        sceneStartSecs[i] = acc;
      }
    }
  }

  // PASS 2: durate in frame da start-to-start
  const frames: number[] = [];
  const endSecs: number[] = [];
  const totalFrames = Math.round(totalAudioSec * FPS) + FPS;

  for (let i = 0; i < script.scenes.length; i++) {
    const currentStart = Math.round(sceneStartSecs[i] * FPS);
    let nextStart: number;
    let nextStartSec: number;

    if (i < script.scenes.length - 1) {
      nextStart = Math.round(sceneStartSecs[i + 1] * FPS);
      nextStartSec = sceneStartSecs[i + 1];
    } else {
      nextStart = totalFrames;
      nextStartSec = totalAudioSec;
    }

    const duration = nextStart - currentStart + CROSSFADE_FRAMES;
    frames.push(Math.max(duration, FPS));
    endSecs.push(nextStartSec);

    const durSec = duration / FPS;
    log(
      `   🎬 Scena ${i + 1}: frame ${currentStart}–${nextStart} (${durSec.toFixed(2)}s)`
    );
  }

  return { frames, startSecs: sceneStartSecs, endSecs };
}

/**
 * Path alternativo: calcola la timeline cumulativamente dalle DURATE REALI
 * dei seg-NNN.mp3 (uno per scena) + silenceAfterMs dello script. È la
 * fonte di verità quando i seg files esistono — i word timestamps
 * ElevenLabs sono inaffidabili (tag spezzati, boundary impreciso). Bug
 * riscontrato 2026-04-07 sul reel cats.
 *
 * Garantisce zero drift tra audio e video: ogni slot dura esattamente
 * quanto il suo seg + silenza, niente freeze frame finale.
 */
export function computeSegmentDurationsFromSegFiles(
  script: ReelScript,
  segDurationsSec: number[],
  options: TimingOptions = {}
): SceneTimings {
  const log = options.logger ?? (() => {});
  const frames: number[] = [];
  const startSecs: number[] = [];
  const endSecs: number[] = [];
  let cursor = 0;

  for (let i = 0; i < script.scenes.length; i++) {
    const segDur = segDurationsSec[i] ?? 0;
    const segMeta = script.voiceoverSegments?.[i];
    const silenceAfterSec = (segMeta?.silenceAfterMs ?? 0) / 1000;
    const slotDur = segDur + silenceAfterSec;

    startSecs.push(cursor);
    cursor += slotDur;
    endSecs.push(cursor);

    const slotFrames = Math.max(Math.round(slotDur * FPS), FPS);
    frames.push(slotFrames);

    log(
      `   🎬 Scena ${i + 1}: ${segDur.toFixed(2)}s seg + ${silenceAfterSec.toFixed(2)}s silence = ${slotDur.toFixed(2)}s slot (${slotFrames}f)`
    );
  }

  return { frames, startSecs, endSecs };
}

/**
 * Probes seg-NNN.mp3 files in <assetsDir>/.tts-segments e ritorna le
 * durate (ffprobe) se tutti esistono, altrimenti `null`. Usato dalla
 * pipeline per scegliere il path "bulletproof" (seg files) vs il fallback
 * (word-timestamps).
 */
export async function probeSegFileDurations(
  assetsDir: string,
  numScenes: number
): Promise<number[] | null> {
  const segDir = join(assetsDir, ".tts-segments");
  const paths = Array.from({ length: numScenes }, (_, i) =>
    join(segDir, `seg-${String(i + 1).padStart(3, "0")}.mp3`)
  );

  for (const p of paths) {
    try {
      await access(p);
    } catch {
      return null;
    }
  }

  const durations = await Promise.all(
    paths.map(async (p) => {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        p,
      ]);
      return parseFloat(JSON.parse(stdout).format.duration);
    })
  );
  return durations;
}
