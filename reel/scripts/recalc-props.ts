/**
 * Ricalcola composition-props.json da word-timestamps.json esistente.
 * Utile per testare la logica di sync senza richiamare ElevenLabs, o per
 * ri-sync dopo aver modificato lo script.json manualmente.
 *
 * Usage: pnpm recalc-props <reel-dir> [script.json]
 *
 * Dal 2026-06-10 espone recalcProps() come funzione: render-only.ts la invoca
 * in automatico quando rileva (via scriptHash) che lo script.json è cambiato
 * dopo l'ultimo calcolo dei props — il gotcha "props cached stale" sparisce.
 *
 * Dal 2026-05-26 questo script usa gli stessi moduli condivisi della
 * pipeline principale ([src/utils/scene-timings.ts](../src/utils/scene-timings.ts)
 * per il sync VO↔scene + [src/utils/composition-props.ts](../src/utils/composition-props.ts)
 * per la mappatura scene→props). Prima duplicava entrambi a mano e quando
 * lo schema scene è stato esteso con `kineticDashboard` nessuno ha
 * aggiornato anche recalc-props → blank screen su 3 scene del reel
 * un-reel-cliente. Vedi [[feedback_use_existing_helpers]].
 */
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WordTimestamp } from "../src/services/elevenlabs.js";
import type { ReelScript } from "../src/schemas/script.js";
import {
  computeSegmentDurations,
  computeSegmentDurationsFromSegFiles,
  probeSegFileDurations,
  type SceneTimings,
} from "../src/utils/scene-timings.js";
import { buildCompositionProps, buildSubtitleWords } from "../src/utils/composition-props.js";
import { hashContent } from "../src/utils/file-io.js";

const execFileAsync = promisify(execFile);

const FPS = 30;

export async function recalcProps(reelDir: string, scriptOverride?: string): Promise<void> {
  const scriptPath = scriptOverride || join(reelDir, "script.json");
  const scriptRaw = await readFile(scriptPath, "utf-8");
  const script: ReelScript = JSON.parse(scriptRaw);

  // Contenuto effettivo di script.json nel reelDir (la fonte dell'hash):
  // con override viene riscritto qui sotto in formato stringify(_, null, 2).
  const finalScriptRaw = scriptOverride ? JSON.stringify(script, null, 2) : scriptRaw;
  if (scriptOverride) {
    await writeFile(join(reelDir, "script.json"), finalScriptRaw);
  }

  // ── veo-native: niente voiceover/word-timestamps — la timeline è la somma
  // dei durationSec esatti (stessa logica della pipeline, vedi pipeline.ts
  // isAllVeoNative). Senza questo branch il recalc cercava word-timestamps.json
  // e crashava su ogni reel veo-native renderizzato dopo un edit allo script.
  if (script.audioMode === "veo-native") {
    const scaledFrames = script.scenes.map((s) => Math.round(s.durationSec * FPS));
    const sceneVideos: (string | undefined)[] = script.scenes.map((s, i) =>
      (s.visualPrompt.trim() || s.sourceClip) &&
      !s.kinetic &&
      !s.kineticDashboard &&
      !s.dashboardComponent &&
      !s.imageUrl
        ? `assets/scene-${i + 1}.mp4`
        : undefined
    );
    const props = buildCompositionProps(script, sceneVideos, scaledFrames, undefined, []);
    const totalFrames = scaledFrames.reduce((a, b) => a + b, 0) + FPS;
    await writeFile(
      join(reelDir, "composition-props.json"),
      JSON.stringify(
        { compositionId: "BasicReel", props, durationInFrames: totalFrames, scriptHash: hashContent(finalScriptRaw) },
        null,
        2
      )
    );
    console.log(`\n✅ composition-props.json aggiornato (veo-native, ${totalFrames} frame = ${(totalFrames / FPS).toFixed(1)}s)`);
    return;
  }

  const words: WordTimestamp[] = JSON.parse(
    await readFile(join(reelDir, "word-timestamps.json"), "utf-8")
  );

  const voiceoverPath = join(reelDir, "assets", "voiceover.mp3");
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet", "-print_format", "json", "-show_format", voiceoverPath,
  ]);
  const totalAudioSec = parseFloat(JSON.parse(stdout).format.duration);

  console.log(`\n📐 Ricalcolo props per ${script.scenes.length} scene, audio ${totalAudioSec.toFixed(1)}s\n`);

  // Sync VO↔scene: preferisce seg-NNN.mp3 reali (bulletproof); altrimenti
  // fallback ai word-timestamps. Stessa logica della pipeline principale.
  const segDurations = await probeSegFileDurations(
    join(reelDir, "assets"),
    script.scenes.length
  );
  let timings: SceneTimings;
  if (segDurations) {
    console.log("🔗 Sync da seg-NNN.mp3 reali (bulletproof)\n");
    timings = computeSegmentDurationsFromSegFiles(script, segDurations, {
      logger: console.log,
    });
  } else {
    timings = computeSegmentDurations(script, words, totalAudioSec, {
      logger: console.log,
    });
  }

  // Assegna videoUrl alle scene che PRODUCONO un clip: visualPrompt non vuoto
  // (AI-generated) OPPURE sourceClip (SPLICE — segmento dell'originale estratto in
  // assets/scene-N.mp4). Le scene KINETIC / KINETIC-DASHBOARD / dashboardComponent /
  // imageUrl NON hanno clip (renderizzate da Remotion o come immagine).
  // NB: senza il ramo `|| s.sourceClip` recalc-props azzerava i videoUrl delle
  // splice (stesso bug-gemello fixato nel discovery di pipeline.ts) → fondi neri.
  const sceneVideos: (string | undefined)[] = script.scenes.map((s, i) =>
    (s.visualPrompt.trim() || s.sourceClip) &&
    !s.kinetic &&
    !s.kineticDashboard &&
    !s.dashboardComponent &&
    !s.imageUrl
      ? `assets/scene-${i + 1}.mp4`
      : undefined
  );

  const subtitles = buildSubtitleWords(words, FPS);
  const props = buildCompositionProps(
    script,
    sceneVideos,
    timings.frames,
    "assets/voiceover.mp3",
    subtitles
  );
  const totalFrames = Math.round(totalAudioSec * FPS) + FPS;

  await writeFile(
    join(reelDir, "composition-props.json"),
    JSON.stringify(
      {
        compositionId: "BasicReel",
        props,
        durationInFrames: totalFrames,
        scriptHash: hashContent(finalScriptRaw),
      },
      null,
      2
    )
  );

  console.log(`\n✅ composition-props.json aggiornato (${totalFrames} frame = ${(totalFrames / FPS).toFixed(1)}s)`);
  console.log(`   Per renderizzare: pnpm render "${reelDir}"\n`);
}

async function main() {
  const reelDir = process.argv[2];
  const scriptOverride = process.argv[3];
  if (!reelDir) {
    console.error("Usage: pnpm recalc-props <reel-dir> [script.json]");
    process.exit(1);
  }
  await recalcProps(reelDir, scriptOverride);
}

// Esegui main() solo quando lanciato come CLI, non quando importato da render-only.
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
