import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { ReelScriptSchema } from "../src/schemas/script.js";
import { generateKeyframe, imageModelInUse } from "../src/services/gemini-image.js";
import { keyframeHash, writeKeyframeHash } from "../src/utils/keyframe-cache.js";
import { unapproveKeyframe } from "../src/utils/approval-gate.js";
import { readJson, writeJson } from "../src/utils/file-io.js";

function mimeFromExt(p: string): "image/png" | "image/jpeg" | "image/webp" {
  const e = extname(p).toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".webp") return "image/webp";
  return "image/jpeg";
}

interface Args {
  scriptPath: string;
  sceneNumber: number;
  refPath: string;
  reelDir: string;
}

function parse(): Args {
  const a = process.argv.slice(2);
  let scriptPath: string | undefined;
  let sceneNumber: number | undefined;
  let refPath: string | undefined;
  let reelDir: string | undefined;

  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--scene" && i + 1 < a.length) sceneNumber = parseInt(a[++i], 10);
    else if (a[i].startsWith("--scene=")) sceneNumber = parseInt(a[i].slice(8), 10);
    else if (a[i] === "--ref" && i + 1 < a.length) refPath = a[++i];
    else if (a[i].startsWith("--ref=")) refPath = a[i].slice(6);
    else if (a[i] === "--from" && i + 1 < a.length) reelDir = a[++i];
    else if (a[i].startsWith("--from=")) reelDir = a[i].slice(7);
    else if (!a[i].startsWith("--")) scriptPath = a[i];
  }

  if (!scriptPath || !sceneNumber || !refPath) {
    console.error("Usage: tsx scripts/regen-keyframe-with-ref.mts <script.json> --scene=N --ref=<local-image-path> [--from=<reel-dir>]");
    process.exit(1);
  }
  return { scriptPath, sceneNumber, refPath, reelDir: reelDir ?? dirname(scriptPath) };
}

const args = parse();
const scriptRaw = await readJson<unknown>(args.scriptPath);
const script = ReelScriptSchema.parse(scriptRaw);

if (args.sceneNumber < 1 || args.sceneNumber > script.scenes.length) {
  console.error(`Scene ${args.sceneNumber} fuori range (1-${script.scenes.length})`);
  process.exit(1);
}

const scene = script.scenes[args.sceneNumber - 1];
const refBuffer = await readFile(args.refPath);
const refMime = mimeFromExt(args.refPath);

const keyframePath = join(args.reelDir, "assets", "keyframes", `scene-${args.sceneNumber}.png`);

console.log(`🎨 Regen scene ${args.sceneNumber} con reference: ${args.refPath} (${refMime})`);
console.log(`   Model: ${imageModelInUse()}`);
console.log(`   Output: ${keyframePath}\n`);

const start = Date.now();
await generateKeyframe(scene.visualPrompt, {
  outputPath: keyframePath,
  referenceBuffer: refBuffer,
  referenceMimeType: refMime,
});
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`✅ Scene ${args.sceneNumber}: saved in ${elapsed}s`);

const hash = keyframeHash(scene.visualPrompt, args.refPath);
await writeKeyframeHash(keyframePath, hash);
await unapproveKeyframe(keyframePath);

script.scenes[args.sceneNumber - 1] = {
  ...scene,
  keyframe: `assets/keyframes/scene-${args.sceneNumber}.png`,
  keyframePromptHash: hash,
  keyframeApproved: false,
};
await writeJson(args.scriptPath, script);

console.log(`\n📝 Script aggiornato (hash ${hash}). Approva: touch ${keyframePath}.approved`);
