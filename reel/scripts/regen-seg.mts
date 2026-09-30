/**
 * Rigenera UN solo seg-NNN.mp3 senza ri-spendere su gli altri.
 * Poi ricompone il voiceover.mp3 master concatenando tutti i seg + silence.
 *
 * Uso:
 *   pnpm tsx scripts/regen-seg.mts <reel-dir> <script.json> <scene-num>
 *
 * Esempio (reel cats, scena 14 PRENOTEME ER POSTO sciupato):
 *   pnpm tsx scripts/regen-seg.mts \
 *     "/Users/msainville/Movies/Reel prodotti AI/2026-04-07/reel-9076" \
 *     "/Users/msainville/Desktop/AI-Clienti/clienti/Infobusiness Milionario/ads/cats-reel-script.json" \
 *     14
 */

import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const [reelDir, scriptPath, sceneNumStr] = process.argv.slice(2);
if (!reelDir || !scriptPath || !sceneNumStr) {
  console.error("Usage: pnpm tsx scripts/regen-seg.mts <reel-dir> <script.json> <scene-num>");
  process.exit(1);
}
const sceneNum = parseInt(sceneNumStr, 10);

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

const script = JSON.parse(await readFile(scriptPath, "utf-8"));
const segments = script.voiceoverSegments;
if (!Array.isArray(segments)) throw new Error("voiceoverSegments missing");

const seg = segments[sceneNum - 1];
if (!seg) throw new Error(`Segment ${sceneNum} not found`);

console.log(`🎙️  Rigenerazione seg-${String(sceneNum).padStart(3, "0")}.mp3`);
console.log(`   Voice: ${seg.voiceId}`);
console.log(`   Text:  "${seg.text}"`);

const modelId = seg.modelId ?? "eleven_v3";
const stability = seg.voiceSettings?.stability ?? 0.4;
const similarityBoost = seg.voiceSettings?.similarityBoost ?? 0.85;
const style = seg.voiceSettings?.style ?? 0.55;
const useSpeakerBoost = seg.voiceSettings?.useSpeakerBoost ?? true;
const speed = seg.voiceSettings?.speed ?? 1.0;

const response = await fetch(
  `https://api.elevenlabs.io/v1/text-to-speech/${seg.voiceId}/with-timestamps`,
  {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: seg.text,
      model_id: modelId,
      output_format: "mp3_44100_192",
      speed,
      voice_settings: {
        stability,
        similarity_boost: similarityBoost,
        style,
        use_speaker_boost: useSpeakerBoost,
      },
    }),
  }
);

if (!response.ok) {
  const err = await response.text();
  throw new Error(`ElevenLabs HTTP ${response.status}: ${err}`);
}

const data = (await response.json()) as { audio_base64: string };
const audioBuf = Buffer.from(data.audio_base64, "base64");
const segPath = join(reelDir, "assets", ".tts-segments", `seg-${String(sceneNum).padStart(3, "0")}.mp3`);
await writeFile(segPath, audioBuf);
console.log(`   ✅ Saved: ${segPath} (${(audioBuf.length / 1024).toFixed(0)} KB)`);

// Ora ricompone voiceover.mp3 master = concat di tutti i seg + silence
console.log(`\n🔗 Ricompongo voiceover.mp3 master...`);

const segDir = join(reelDir, "assets", ".tts-segments");
const concatList: string[] = [];
for (let i = 0; i < segments.length; i++) {
  const sPath = join(segDir, `seg-${String(i + 1).padStart(3, "0")}.mp3`);
  concatList.push(sPath);
  const silenceMs = segments[i].silenceAfterMs ?? 0;
  if (silenceMs > 0 && i < segments.length - 1) {
    const silPath = join(segDir, `silence-${silenceMs}ms.mp3`);
    concatList.push(silPath);
  }
}

// ffmpeg concat con filter (re-encode uniforme)
const inputArgs: string[] = [];
const filterParts: string[] = [];
for (let i = 0; i < concatList.length; i++) {
  inputArgs.push("-i", concatList[i]);
  filterParts.push(`[${i}:a]`);
}
const filterComplex = filterParts.join("") + `concat=n=${concatList.length}:v=0:a=1[out]`;

const masterPath = join(reelDir, "assets", "voiceover.mp3");
await execFileP("ffmpeg", [
  "-y",
  ...inputArgs,
  "-filter_complex", filterComplex,
  "-map", "[out]",
  "-c:a", "libmp3lame",
  "-b:a", "192k",
  "-ar", "44100",
  "-ac", "1",
  masterPath,
]);

console.log(`   ✅ Master ricomposto: ${masterPath}`);
console.log(`\n🎉 Done. Lancia il render: pnpm reel <script> --video-only --from "${reelDir}" --skip-existing-videos --omnihuman`);
