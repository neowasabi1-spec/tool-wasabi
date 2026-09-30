import { config } from "dotenv";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import { generateImageToVideo, downloadAsset } from "../src/services/fal.js";

// Test: il testo in-scene di un keyframe sopravvive all'image-to-video Kling?
// Uso: npx tsx scripts/test-text-i2v.ts <keyframe.png> "<motionPrompt>" <outDir> [--end-anchor] [--duration=5]
//   --end-anchor   passa il keyframe anche come end_image_url (ancora doppia:
//                  Kling deve iniziare E finire sul frame col testo perfetto)
// Output: <outDir>/<name>.mp4 + <outDir>/<name>-f{1..5}.png (frame a 0/25/50/75/100%)
async function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith("--"));
  const endAnchor = argv.includes("--end-anchor");
  const durArg = argv.find((a) => a.startsWith("--duration="));
  const duration = durArg ? Number(durArg.split("=")[1]) : 5;

  const [keyframe, motionPrompt, outDir] = positional;
  if (!keyframe || !motionPrompt || !outDir) {
    console.error('usage: tsx scripts/test-text-i2v.ts <keyframe.png> "<motionPrompt>" <outDir> [--end-anchor] [--duration=5]');
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const name = basename(keyframe).replace(/\.(png|jpg|jpeg|webp)$/i, "") + (endAnchor ? "-anchored" : "");
  const outMp4 = join(outDir, `${name}.mp4`);

  console.log(`🎬 Kling i2v ${duration}s ${endAnchor ? "(start+end anchor)" : "(start only)"} ← ${basename(keyframe)}`);
  const result = await generateImageToVideo(keyframe, motionPrompt, {
    duration,
    ...(endAnchor ? { tailImagePath: keyframe } : {}),
  });
  await downloadAsset(result.url, outMp4);
  console.log(`✅ ${outMp4}`);

  // Estrai 5 frame a 0/25/50/75/100% della durata reale
  const probed = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", outMp4]).toString().trim();
  const dur = parseFloat(probed);
  for (let i = 0; i < 5; i++) {
    const t = Math.min(dur * (i / 4), dur - 0.05);
    const framePath = join(outDir, `${name}-f${i + 1}.png`);
    execFileSync("ffmpeg", ["-y", "-ss", t.toFixed(2), "-i", outMp4, "-frames:v", "1", framePath], { stdio: "pipe" });
  }
  console.log(`🖼️  5 frame estratti in ${outDir}/${name}-f{1..5}.png (durata clip: ${dur.toFixed(1)}s)`);
}

main().catch((e) => {
  console.error("TEST FAIL:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
