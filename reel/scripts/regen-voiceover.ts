/**
 * Rigenera solo il voiceover (ElevenLabs) in un reel esistente,
 * senza toccare i video clip. Aggiorna voiceover.mp3 e word-timestamps.json.
 *
 * Usage: pnpm tsx scripts/regen-voiceover.ts <script.json> <reel-dir> [--voice-id=ID] [--model-id=MODEL]
 */
import "dotenv/config";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { generateVoiceover } from "../src/services/elevenlabs.js";
import { enhanceVoiceover } from "../src/services/voiceover-enhancer.js";
import type { ReelScript } from "../src/schemas/script.js";

async function main() {
  const args = process.argv.slice(2);
  const scriptPath = args[0];
  const reelDir = args[1];
  if (!scriptPath || !reelDir) {
    console.error("Usage: pnpm tsx scripts/regen-voiceover.ts <script.json> <reel-dir> [--voice-id=ID] [--model-id=MODEL] [--skip-enhance]");
    process.exit(1);
  }

  let voiceId: string | undefined;
  let modelId: string | undefined;
  let forceSkipEnhance = false;
  for (const arg of args.slice(2)) {
    if (arg.startsWith("--voice-id=")) voiceId = arg.slice("--voice-id=".length);
    else if (arg.startsWith("--model-id=")) modelId = arg.slice("--model-id=".length);
    else if (arg === "--skip-enhance") forceSkipEnhance = true;
  }

  const script: ReelScript = JSON.parse(await readFile(scriptPath, "utf-8"));
  const assetsDir = join(reelDir, "assets");

  // Leggi voice/model anche dallo script se non specificati da CLI
  voiceId = voiceId ?? (script as any).voiceId;
  modelId = modelId ?? (script as any).voiceModelId;

  const effectiveModelId = modelId ?? "eleven_v3";
  const supportsAudioTags = effectiveModelId === "eleven_v3";

  if ((script as any).voiceoverSegments?.length) {
    throw new Error(
      "regen-voiceover.ts non supporta script multi-voce (voiceoverSegments). Usa pnpm reel per rigenerare l'intero voiceover, oppure estendi questo script."
    );
  }
  let text = script.voiceoverText;
  if (!text || !text.trim()) {
    throw new Error("Lo script non contiene voiceoverText.");
  }
  if (!forceSkipEnhance && supportsAudioTags) {
    console.log("✨ Enhancing voiceover con Audio Tags v3...");
    text = enhanceVoiceover(text);
  } else if (!supportsAudioTags) {
    console.log(`⏭️  Enhancer saltato: modello ${effectiveModelId} non supporta Audio Tags v3`);
  }

  console.log(`🎙️ Generazione voiceover...`);
  console.log(`   Voice ID: ${voiceId ?? "default"}`);
  console.log(`   Model:    ${effectiveModelId}`);

  const result = await generateVoiceover(text, join(assetsDir, "voiceover.mp3"), {
    voiceId,
    modelId,
  });

  console.log(`   ✅ ${result.durationSec.toFixed(1)}s — ${result.words.length} parole con timestamps`);

  // Save word timestamps
  await writeFile(
    join(reelDir, "word-timestamps.json"),
    JSON.stringify(result.words, null, 2)
  );

  console.log(`\n✅ Fatto. Ricalcola props:\n   pnpm tsx scripts/recalc-props.ts "${reelDir}" ${scriptPath}`);
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
