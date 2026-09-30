/**
 * Rigenera solo specifiche scene di un reel esistente, senza toccare
 * voiceover e altre scene.
 *
 * IMPORTANTE: prima di rigenerare, lo script auto-calibra `durationSec` di OGNI
 * scena leggendo `word-timestamps.json` dentro reelDir. La durata reale del
 * voiceoverSegment è autoritativa: se la tua stima manuale in script.json era
 * sbagliata (es. 5s quando l'audio reale è 9s), il clip Kling veniva generato
 * troppo corto e Remotion freezava l'ultimo frame.
 *
 * Da 2026-05-26 questo passaggio è anche cablato dentro la pipeline principale
 * (Stage 1.5 in `src/pipeline.ts`) — la maggior parte dei FREEZE viene risolta
 * alla PRIMA passata, non in regen. Questo script resta utile per:
 *   - rigenerare scene con clip Kling esteticamente sbagliati ma sync OK
 *   - riprendere da un reel parzialmente fallito (file scene-N.mp4 mancanti)
 *   - cambiare visualPrompt di una scena e ri-tirare solo quella
 *
 * Vedi [[feedback-reel-video-audio-sync]] per il pattern completo.
 *
 * Usage: pnpm tsx scripts/regen-scenes.ts <script.json> <reel-dir> <scene-num> [scene-num...]
 */
import "dotenv/config";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { generateTextToVideo, downloadAsset } from "../src/services/fal.js";
import type { ReelScript } from "../src/schemas/script.js";
import type { WordTimestamp } from "../src/services/elevenlabs.js";
import { syncDurationsAndPersist } from "../src/utils/sync-durations.js";

function getClipDuration(scene: ReelScript["scenes"][number]): number {
  return Math.min(Math.max(Math.ceil(scene.durationSec) + 1, 5), 10);
}

async function main() {
  const [, , scriptPath, reelDir, ...sceneArgs] = process.argv;
  if (!scriptPath || !reelDir || sceneArgs.length === 0) {
    console.error("Usage: pnpm tsx scripts/regen-scenes.ts <script.json> <reel-dir> <scene-num> [scene-num...]");
    process.exit(1);
  }

  const sceneNums = sceneArgs.map(Number);
  const script: ReelScript = JSON.parse(await readFile(scriptPath, "utf-8"));
  const assetsDir = join(reelDir, "assets");

  // Pre-flight: auto-sync durationSec dallo audio reale (Stage 1.5 standalone).
  // Stessa logica usata in src/pipeline.ts, modulo condiviso utils/sync-durations.
  const wordsPath = join(reelDir, "word-timestamps.json");
  try {
    const words: WordTimestamp[] = JSON.parse(await readFile(wordsPath, "utf-8"));
    const sync = await syncDurationsAndPersist(scriptPath, script, words);
    if (sync.updated > 0) {
      console.log(`🔧 Auto-sync: ${sync.updated} scene aggiornate (durationSec dal voiceoverSegment reale)`);
    }
    if (sync.unmatchedScenes.length > 0) {
      console.log(`⚠️  Scene con voiceoverSegment non trovato: ${sync.unmatchedScenes.join(", ")}`);
    }
    if (sync.oversizedScenes.length > 0) {
      console.log(`⚠️  Scene con audio > 10s (Kling cap, vanno spezzate manualmente):`);
      for (const o of sync.oversizedScenes) {
        console.log(`      Scena ${o.sceneNum}: ${o.realDurSec.toFixed(2)}s`);
      }
    }
  } catch {
    console.log(`⚠️  word-timestamps.json non trovato in ${reelDir}, skip auto-sync durationSec`);
  }

  console.log(`\n🎬 Rigenerazione ${sceneNums.length} scene: ${sceneNums.join(", ")}\n`);

  for (const num of sceneNums) {
    const i = num - 1;
    const scene = script.scenes[i];
    if (!scene) {
      console.log(`⚠️  Scena ${num}: indice non valido, skip`);
      continue;
    }
    if (!scene.visualPrompt.trim()) {
      console.log(`⚠️  Scena ${num}: TEXT (nessun video), skip`);
      continue;
    }

    const clipDur = getClipDuration(scene);
    console.log(`🎬 Scena ${num}: text-to-video (${clipDur}s, durSec=${scene.durationSec})...`);
    console.log(`   Prompt: "${scene.visualPrompt.slice(0, 100)}..."`);

    const videoResult = await generateTextToVideo(scene.visualPrompt, { duration: clipDur });
    const videoPath = join(assetsDir, `scene-${num}.mp4`);
    await downloadAsset(videoResult.url, videoPath);
    console.log(`   ✅ Scena ${num} rigenerata: ${videoPath}\n`);
  }

  console.log(`✅ Fatto. Per renderizzare:\n   pnpm render "${reelDir}"`);
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
