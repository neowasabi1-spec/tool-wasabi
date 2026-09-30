import { config } from "dotenv";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, readFile } from "node:fs/promises";
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });
import { generateImageToVideo } from "../../src/services/fal.js";

/**
 * gen-broll.ts — genera i clip B-ROLL del montaggio (Kling i2v dai keyframe approvati).
 *
 * Movimenti MINIMI nel prompt → il clip preserva il keyframe (niente morph/drift).
 * Kling i2v dà 5s o 10s: per coprire scene di 5-9s genera a 10s (il composition tronca).
 *
 * USO:
 *   npx tsx scripts/footage-montage/gen-broll.ts broll-jobs.json
 *
 * broll-jobs.json (path relativi alla cartella del progetto / a dove lanci il comando):
 * [
 *   { "keyframe": "keyframes/kf2.png",
 *     "prompt": "Very slow dolly-in. The person keeps working naturally, soft daylight. Camera almost still, cinematic, shallow depth of field.",
 *     "out": "assets/broll-2.mp4",
 *     "duration": 10 }
 * ]
 *
 * Prima genera i keyframe col tool esistente:
 *   npx tsx scripts/gen-variant.ts "<descrizione immagine>" "keyframes/kfN.png"
 * e APPROVALI a occhio (GATE keyframe) prima di pagare i Kling.
 */

type Job = { keyframe: string; prompt: string; out: string; duration?: number };

async function one(j: Job, base: string) {
  const abs = (p: string) => (isAbsolute(p) ? p : join(base, p));
  const { url } = await generateImageToVideo(abs(j.keyframe), j.prompt, { duration: j.duration ?? 10 });
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  await writeFile(abs(j.out), buf);
  console.log("OK", j.out, "<-", url);
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("uso: npx tsx scripts/footage-montage/gen-broll.ts broll-jobs.json");
    process.exit(1);
  }
  const base = dirname(isAbsolute(file) ? file : join(process.cwd(), file));
  const jobs: Job[] = JSON.parse(await readFile(file, "utf-8"));
  await Promise.all(
    jobs.map((j) => one(j, base).catch((e) => console.log("FAIL", j.out, e instanceof Error ? e.message : String(e))))
  );
  console.log("DONE", jobs.length, "b-roll");
}

main();
