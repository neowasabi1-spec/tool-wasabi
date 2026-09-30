/**
 * STAGE 1.7 Storyboard — CLI standalone per generare keyframe per ogni scena.
 *
 * Usage:
 *   pnpm storyboard <script.json> [--from <reel-dir>] [--force-regen=1,3,5]
 *
 * Flow:
 *   1. Legge script.json e valida con Zod
 *   2. Per ogni scena con visualPrompt non vuoto (e che non sia KINETIC/HeyGen):
 *      a. Calcola hash di (visualPrompt + keyframeReferenceUrl)
 *      b. Se cache fresca + non forzato → skip
 *      c. Se keyframeReferenceUrl è Pinterest pin URL → estrae l'immagine
 *      d. Genera keyframe con gemini-3-pro-image-preview
 *      e. Salva PNG + hash file + reset marker .approved
 *      f. Aggiorna script.json con keyframe path + hash
 *   3. Persiste script.json aggiornato (sia in reelDir sia nel path sorgente)
 *   4. Genera keyframes.html gallery (Fase 5)
 *
 * Costo: ~$0.06-0.10 per keyframe Gemini 3 Pro Image. Per 8 scene ~$0.50-0.80.
 */

import "dotenv/config";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { ReelScriptSchema } from "../src/schemas/script.js";
import {
  generateKeyframe,
  imageModelInUse,
} from "../src/services/gemini-image.js";
import {
  fetchPinterestReference,
  isPinterestUrl,
  guessPinterestMimeType,
} from "../src/services/pinterest-reference.js";
import {
  keyframeHash,
  isKeyframeFresh,
  writeKeyframeHash,
} from "../src/utils/keyframe-cache.js";
import { unapproveKeyframe, isKeyframeApproved } from "../src/utils/approval-gate.js";
import { ensureDir, readJson, writeJson } from "../src/utils/file-io.js";
import { buildKeyframesGallery } from "../src/utils/keyframe-gallery.js";

interface StoryboardOptions {
  scriptPath: string;
  reelDir?: string;
  forceRegen?: number[]; // 1-indexed scene numbers
}

function parseArgs(): StoryboardOptions {
  const args = process.argv.slice(2);
  let scriptPath: string | undefined;
  let reelDir: string | undefined;
  let forceRegen: number[] | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--from" && i + 1 < args.length) {
      reelDir = args[++i];
    } else if (arg.startsWith("--from=")) {
      reelDir = arg.slice("--from=".length);
    } else if (arg.startsWith("--force-regen=")) {
      forceRegen = arg
        .slice("--force-regen=".length)
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n) && n > 0);
    } else if (!arg.startsWith("--")) {
      scriptPath = arg;
    }
  }

  if (!scriptPath) {
    console.error(
      "Usage: pnpm storyboard <script.json> [--from <reel-dir>] [--force-regen=1,3,5]"
    );
    process.exit(1);
  }

  return { scriptPath, reelDir, forceRegen };
}

async function main(): Promise<void> {
  const opts = parseArgs();

  const scriptRaw = await readJson<unknown>(opts.scriptPath);
  const script = ReelScriptSchema.parse(scriptRaw);

  const outputDir = opts.reelDir ?? dirname(opts.scriptPath);
  const keyframesDir = join(outputDir, "assets", "keyframes");
  await ensureDir(keyframesDir);

  console.log(`\n🎨 STAGE 1.7 — Storyboard (${imageModelInUse()})`);
  console.log(`   Reel dir: ${outputDir}`);
  console.log(`   Keyframes: ${keyframesDir}\n`);

  let generated = 0;
  let cached = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const sceneNum = i + 1;

    // Skip scene senza visualPrompt o con shot type speciale
    if (!scene.visualPrompt.trim() || scene.kinetic || scene.kineticDashboard) {
      const reason = scene.kineticDashboard
        ? "KINETIC-DASHBOARD"
        : scene.kinetic
          ? "KINETIC"
          : "TEXT-only";
      console.log(`   ⏭️  Scena ${sceneNum}: skip (${reason})`);
      skipped++;
      continue;
    }

    // Skip scene HeyGen (avatar non usa keyframe da Gemini)
    if (scene.provider === "heygen" || scene.videoEngine === "heygen") {
      console.log(`   ⏭️  Scena ${sceneNum}: skip (HeyGen avatar, no keyframe)`);
      skipped++;
      continue;
    }

    // Skip scene Veo3 (text-to-video con audio nativo, no keyframe needed)
    if (scene.provider === "veo3" || scene.videoEngine === "veo3") {
      console.log(`   ⏭️  Scena ${sceneNum}: skip (Veo3 text-to-video native audio, no keyframe)`);
      skipped++;
      continue;
    }

    const keyframePath = join(keyframesDir, `scene-${sceneNum}.png`);
    const relPath = `assets/keyframes/scene-${sceneNum}.png`;
    const hash = keyframeHash(scene.visualPrompt, scene.keyframeReferenceUrl);

    const forced = opts.forceRegen?.includes(sceneNum) ?? false;
    if (!forced && (await isKeyframeFresh(keyframePath, hash))) {
      const approved = await isKeyframeApproved(keyframePath);
      const approvedFlag = approved ? "✅ approved" : "🟡 pending";
      console.log(`   📦 Scena ${sceneNum}: cache hit (hash invariato, ${approvedFlag})`);
      script.scenes[i].keyframe = relPath;
      script.scenes[i].keyframePromptHash = hash;
      script.scenes[i].keyframeApproved = approved;
      cached++;
      continue;
    }

    // Fetch reference image se URL presente
    let refBuffer: Buffer | undefined;
    let refMime: "image/png" | "image/jpeg" | "image/webp" = "image/jpeg";
    if (scene.keyframeReferenceUrl) {
      if (isPinterestUrl(scene.keyframeReferenceUrl)) {
        process.stdout.write(`   📌 Scena ${sceneNum}: fetch reference Pinterest… `);
        const buf = await fetchPinterestReference(scene.keyframeReferenceUrl);
        if (buf) {
          refBuffer = buf;
          refMime = guessPinterestMimeType(buf);
          console.log(`OK (${(buf.length / 1024).toFixed(0)} KB)`);
        } else {
          console.log("FAIL (fallback text-only)");
        }
      } else if (scene.keyframeReferenceUrl.startsWith("https://")) {
        try {
          const resp = await fetch(scene.keyframeReferenceUrl);
          if (resp.ok) {
            const arr = await resp.arrayBuffer();
            refBuffer = Buffer.from(arr);
            const ct = resp.headers.get("content-type") ?? "";
            refMime = ct.includes("png") ? "image/png" : ct.includes("webp") ? "image/webp" : "image/jpeg";
          }
        } catch {
          console.log(`   ⚠️  Scena ${sceneNum}: reference URL non scaricabile (fallback text-only)`);
        }
      } else if (
        scene.keyframeReferenceUrl.startsWith("file://") ||
        scene.keyframeReferenceUrl.startsWith("/") ||
        scene.keyframeReferenceUrl.startsWith("./") ||
        scene.keyframeReferenceUrl.startsWith("assets/")
      ) {
        // Path locale: assoluto (/), relativo (./, assets/) o file://
        // Risolto contro outputDir per i path relativi/assets/, contro la root per /.
        const rawPath = scene.keyframeReferenceUrl.replace(/^file:\/\//, "");
        const localPath = rawPath.startsWith("/")
          ? rawPath
          : `${outputDir}/${rawPath.replace(/^\.\//, "")}`;
        try {
          process.stdout.write(`   📁 Scena ${sceneNum}: load reference locale ${localPath}… `);
          const buf = await readFile(localPath);
          refBuffer = buf;
          refMime = localPath.endsWith(".png")
            ? "image/png"
            : localPath.endsWith(".webp")
              ? "image/webp"
              : "image/jpeg";
          console.log(`OK (${(buf.length / 1024).toFixed(0)} KB)`);
        } catch (err) {
          console.log(`FAIL (${err instanceof Error ? err.message : err}) — fallback text-only`);
        }
      }
    }

    console.log(
      `   🎨 Scena ${sceneNum}: generazione Gemini${refBuffer ? " + ref" : ""}…`
    );
    const t0 = Date.now();
    try {
      await generateKeyframe(scene.visualPrompt, {
        outputPath: keyframePath,
        referenceBuffer: refBuffer,
        referenceMimeType: refMime,
      });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`   ✅ Scena ${sceneNum}: saved in ${dt}s`);

      script.scenes[i].keyframe = relPath;
      script.scenes[i].keyframePromptHash = hash;
      script.scenes[i].keyframeApproved = false;
      await writeKeyframeHash(keyframePath, hash);
      await unapproveKeyframe(keyframePath);
      generated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`   ❌ Scena ${sceneNum}: FAIL — ${msg}`);
      failed++;
    }

    // Rate limit prudente: 3s tra chiamate
    if (i < script.scenes.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Persisti script aggiornato (sia in outputDir che nel path sorgente)
  await writeJson(join(outputDir, "script.json"), script);
  if (opts.scriptPath !== join(outputDir, "script.json")) {
    await writeJson(opts.scriptPath, script);
  }

  // Genera gallery HTML per review umana
  const galleryPath = join(outputDir, "keyframes.html");
  await buildKeyframesGallery(outputDir, script);

  console.log(`\n📊 Summary:`);
  console.log(`   Generati: ${generated}`);
  console.log(`   Cache hit: ${cached}`);
  console.log(`   Skip: ${skipped}`);
  if (failed > 0) console.log(`   ❌ Fallite: ${failed}`);

  console.log(`\n🟡 GATE 4 — Approvazione keyframe`);
  console.log(`   Apri gallery: open ${galleryPath}`);
  console.log(`   Approva: touch ${keyframesDir}/scene-N.png.approved`);
  console.log(`   Rifiuta+rigenera: edit script.json + pnpm storyboard ${opts.scriptPath} --from ${outputDir} --force-regen=N\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n❌ Storyboard error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
