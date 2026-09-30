import { writeFile } from "node:fs/promises";
import { findSegmentRange } from "./word-matching.js";
import type { ReelScript } from "../schemas/script.js";
import type { WordTimestamp } from "../services/elevenlabs.js";

/**
 * Allinea il `durationSec` di ogni scena alla durata REALE del suo
 * `voiceoverSegment` letta dai word-timestamps di ElevenLabs.
 *
 * Senza questo passaggio i clip Kling vengono richiesti sulla base delle stime
 * manuali nel JSON, che sono quasi sempre sbagliate per qualche scena: se il
 * clip è più corto del segmento audio Remotion congela l'ultimo frame
 * (FREEZE), rendendo il reel non pubblicabile.
 *
 * Scene con audio reale > 10s vengono solo SEGNALATE — non auto-fixabili
 * perché Kling 3.0 Pro genera max 10s per clip. Vanno spezzate manualmente.
 *
 * Vedi memoria [[feedback_memory_into_tools]]: il workaround "ricordarsi di
 * lanciare regen-scenes.ts dopo la pipeline" è stato sostituito dalla patch
 * strutturale che fa questo lavoro come Stage 1.5 del flusso principale.
 */

const KLING_MAX_CLIP_SEC = 10;

export interface SyncResult {
  /** Numero di scene il cui durationSec è stato modificato */
  updated: number;
  /**
   * Scene con audio reale > 10s — Kling 3.0 Pro non può generare clip così
   * lunghi. Vanno spezzate manualmente nello script (vedi `reel-engine/CLAUDE.md`
   * sezione "REGOLA D'ORO: Sync video↔audio").
   */
  oversizedScenes: Array<{ sceneNum: number; realDurSec: number }>;
  /** Scene il cui voiceoverSegment non è stato trovato nei word-timestamps */
  unmatchedScenes: number[];
}

/**
 * Modifica `script.scenes[i].durationSec` in-place allineandolo alla durata
 * reale del segmento audio. Non scrive su disco — quello è compito del caller.
 */
export function syncDurationsFromAudio(
  script: ReelScript,
  wordTimestamps: WordTimestamp[]
): SyncResult {
  const result: SyncResult = {
    updated: 0,
    oversizedScenes: [],
    unmatchedScenes: [],
  };
  if (wordTimestamps.length === 0) return result;

  let searchFrom = 0;
  for (let i = 0; i < script.scenes.length; i++) {
    const seg = script.scenes[i].voiceoverSegment?.trim();
    if (!seg) continue;

    const { startIdx, endIdx } = findSegmentRange(
      wordTimestamps,
      seg,
      searchFrom
    );
    if (startIdx === -1) {
      result.unmatchedScenes.push(i + 1);
      continue;
    }

    const startT = wordTimestamps[startIdx].startSec;
    // end = inizio della prossima scena con segmento (gap-inclusive); fallback
    // alla fine di questo segmento se è l'ultima scena.
    let endT =
      (wordTimestamps[endIdx] as { endSec?: number }).endSec ??
      wordTimestamps[endIdx].startSec + 0.3;
    if (i + 1 < script.scenes.length) {
      const nextSeg = script.scenes[i + 1].voiceoverSegment?.trim();
      if (nextSeg) {
        const { startIdx: nsIdx } = findSegmentRange(
          wordTimestamps,
          nextSeg,
          endIdx + 1
        );
        if (nsIdx !== -1) endT = wordTimestamps[nsIdx].startSec;
      }
    }

    const realDur = endT - startT;
    const newDurSec = Math.max(Math.ceil(realDur + 0.001), 3);
    const oldDurSec = script.scenes[i].durationSec ?? 0;

    if (newDurSec !== oldDurSec) {
      script.scenes[i].durationSec = newDurSec;
      result.updated++;
    }

    if (realDur > KLING_MAX_CLIP_SEC) {
      result.oversizedScenes.push({ sceneNum: i + 1, realDurSec: realDur });
    }

    searchFrom = endIdx + 1;
  }

  return result;
}

/**
 * Versione "persistente" per CLI: chiama syncDurationsFromAudio e salva lo
 * script aggiornato in `scriptPath` (con indent 2 spazi, JSON pretty).
 * Usata da `regen-scenes.ts`. La pipeline principale non passa per qui:
 * persiste autonomamente nell'outputDir del reel.
 */
export async function syncDurationsAndPersist(
  scriptPath: string,
  script: ReelScript,
  wordTimestamps: WordTimestamp[]
): Promise<SyncResult> {
  const result = syncDurationsFromAudio(script, wordTimestamps);
  if (result.updated > 0) {
    await writeFile(scriptPath, JSON.stringify(script, null, 2));
  }
  return result;
}
