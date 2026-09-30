import type { WordTimestamp } from "../services/elevenlabs.js";

/**
 * Funzioni di matching tra segmenti di voiceover e word-timestamps ElevenLabs.
 * Modulo low-level usato da:
 *  - `scene-timings.ts` (calcolo durate scene)
 *  - `sync-durations.ts` (Stage 1.5: auto-sync durationSec)
 *
 * Centralizzato qui per evitare le divergenze tra le copie precedenti che
 * usavano un normalizer ASCII-only (`\w`) buggato sui caratteri italiani
 * accentati (è/à/ò/ù). Bug riscontrato 2026-04-06 sul reel cats.
 */

/**
 * Normalizza una stringa per il matching fuzzy: lowercase, rimuove
 * punteggiatura, collassa spazi multipli.
 *
 * Usa `\p{L}\p{N}` (unicode-aware) per supportare parole italiane accentate
 * (è/à/ò/ù/é). Con `\w` (ASCII) il regex le strippa come fossero
 * punteggiatura e i match falliscono.
 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Audio tag ElevenLabs v3 (es. "[whispers]", "[excited][proud]"). Non
 * pronunciato nell'audio finale ma incluso come parola fantasma nei
 * timestamps. Va escluso dal matching, altrimenti rompe i needle di 3
 * parole consecutive.
 */
export function isAudioTagWord(word: string): boolean {
  return /^\[[^\]]*\](\[[^\]]*\])*$/.test(word.trim());
}

/**
 * Word filtrata + indice originale nel raw array. Permette di matchare
 * sull'array "pulito" ma restituire indici riferiti al raw originale.
 */
export interface IndexedWord {
  word: string;
  origIdx: number;
  raw: WordTimestamp;
}

/**
 * Filtra dal word-array tutto ciò che NON è una parola pronunciata reale:
 * audio tags + token di pura punteggiatura. Mantiene gli indici originali.
 */
export function filterRealWords(rawWords: WordTimestamp[]): IndexedWord[] {
  const out: IndexedWord[] = [];
  for (let i = 0; i < rawWords.length; i++) {
    const w = rawWords[i].word;
    if (isAudioTagWord(w)) continue;
    if (normalizeForMatch(w) === "") continue;
    out.push({ word: w, origIdx: i, raw: rawWords[i] });
  }
  return out;
}

export interface SegmentRange {
  startIdx: number;
  endIdx: number;
}

/**
 * Trova il range [startIdx, endIdx] nel word-array (indici originali) che
 * corrisponde al segmento. Cerca le prime 3 parole consecutive del segmento
 * (filtrate da tag/punteggiatura) e ritorna start = prima parola, end =
 * ultima parola del segmento.
 */
export function findSegmentRange(
  rawWords: WordTimestamp[],
  segment: string,
  searchFrom: number
): SegmentRange {
  const filtered = filterRealWords(rawWords);

  const segWords = normalizeForMatch(segment).split(" ").filter(Boolean);
  if (segWords.length === 0) return { startIdx: -1, endIdx: -1 };
  const needleLen = Math.min(3, segWords.length);
  const needle = segWords.slice(0, needleLen);

  const startFiltered = filtered.findIndex((w) => w.origIdx >= searchFrom);
  if (startFiltered === -1) return { startIdx: -1, endIdx: -1 };

  for (let i = startFiltered; i <= filtered.length - needleLen; i++) {
    let match = true;
    for (let j = 0; j < needleLen; j++) {
      if (normalizeForMatch(filtered[i + j].word) !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      const lastFiltered = Math.min(
        i + segWords.length - 1,
        filtered.length - 1
      );
      return {
        startIdx: filtered[i].origIdx,
        endIdx: filtered[lastFiltered].origIdx,
      };
    }
  }
  return { startIdx: -1, endIdx: -1 };
}

/**
 * Comodità: trova solo l'indice di start del segmento (wrapper su
 * findSegmentRange per i caller che non hanno bisogno dell'end).
 */
export function findSegmentStart(
  rawWords: WordTimestamp[],
  segment: string,
  searchFrom: number
): number {
  return findSegmentRange(rawWords, segment, searchFrom).startIdx;
}
