/**
 * REFRESH CREATIVO — GATE V: verifica post-generazione.
 *
 * Per ogni scena AI con keyframe approvato, estrae il primo frame del clip
 * generato e chiede a Gemini se il SOGGETTO combacia col keyframe. È il controllo
 * che avrebbe bloccato il fallimento un brand cliente v2 (keyframe labbra di donna →
 * clip volto d'uomo + codice a barre). Esce NON-ZERO se anche una sola scena
 * diverge → blocca il "fatto" finché non rigeneri quelle scene.
 *
 * Usage:
 *   pnpm refresh:verify <reel-dir> [--threshold 5]
 *
 * Output: <reel-dir>/refresh-verify.json + tabella a schermo. Costo: ~$0.03-0.05
 * per scena AI (Gemini vision, 2 immagini).
 */

import "dotenv/config";
import { join, isAbsolute } from "node:path";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ReelScriptSchema } from "../src/schemas/script.js";
import { VerifyResultSchema, type VerifyResult } from "../src/schemas/refresh.js";
import { extractFrameAt } from "../src/utils/video-frame-extract.js";
import { subjectMatch } from "../src/services/gemini-vision.js";
import { writeJson } from "../src/utils/file-io.js";

async function fileExists(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false);
}

interface Opts {
  reelDir: string;
  threshold: number;
}

function parseArgs(): Opts {
  const args = process.argv.slice(2);
  let reelDir: string | undefined;
  let threshold = 5;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--threshold=")) threshold = parseFloat(a.slice("--threshold=".length));
    else if (a === "--threshold" && i + 1 < args.length) threshold = parseFloat(args[++i]);
    else if (!a.startsWith("--")) reelDir = a;
  }
  if (!reelDir) {
    console.error("Usage: pnpm refresh:verify <reel-dir> [--threshold 5]");
    process.exit(1);
  }
  return { reelDir: isAbsolute(reelDir) ? reelDir : join(process.cwd(), reelDir), threshold };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function main(): Promise<void> {
  const { reelDir, threshold } = parseArgs();
  const scriptRaw = JSON.parse(await readFile(join(reelDir, "script.json"), "utf-8"));
  const script = ReelScriptSchema.parse(scriptRaw);

  // Scene candidate: hanno un keyframe (sono AI ancorate) e un clip generato.
  const candidates: { sceneNum: number; keyframe: string; clip: string }[] = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const s = script.scenes[i];
    if (!s.keyframe) continue;
    const clip = join(reelDir, `assets/scene-${i + 1}.mp4`);
    if (!(await fileExists(clip))) continue;
    candidates.push({ sceneNum: i + 1, keyframe: join(reelDir, s.keyframe), clip });
  }

  if (candidates.length === 0) {
    console.log("⚠️  GATE V: nessuna scena AI con keyframe + clip da verificare.");
    await writeJson(join(reelDir, "refresh-verify.json"), { results: [], blocked: [] });
    return;
  }

  console.log(`\n🛡️  GATE V — verifica soggetto su ${candidates.length} scene AI (soglia ${threshold})…`);
  const tmp = tmpdir();
  const results: VerifyResult[] = await mapWithConcurrency(candidates, 6, async (c) => {
    const firstFrame = join(tmp, `verify-scene-${c.sceneNum}.png`);
    await extractFrameAt(c.clip, 0.1, firstFrame);
    let match = false, score = 0, reason = "";
    try {
      const r = await subjectMatch(c.keyframe, firstFrame);
      match = r.match; score = r.score; reason = r.reason;
    } catch (e) {
      reason = `vision fallita: ${e instanceof Error ? e.message : e}`;
    }
    const pass = match && score >= threshold;
    return VerifyResultSchema.parse({
      sceneNum: c.sceneNum,
      keyframe: c.keyframe.replace(reelDir + "/", ""),
      clip: `assets/scene-${c.sceneNum}.mp4`,
      match,
      score,
      reason,
      status: pass ? "pass" : "block",
    });
  });

  results.sort((a, b) => a.sceneNum - b.sceneNum);
  const blocked = results.filter((r) => r.status === "block");

  console.log(`\n| Scena | Match | Score | Stato | Motivo |`);
  console.log(`|-------|-------|-------|-------|--------|`);
  for (const r of results) {
    const icon = r.status === "pass" ? "✅" : "🔴";
    console.log(`| ${r.sceneNum} | ${r.match ? "sì" : "no"} | ${r.score}/10 | ${icon} ${r.status} | ${r.reason.slice(0, 50)} |`);
  }

  await writeJson(join(reelDir, "refresh-verify.json"), { results, blocked: blocked.map((b) => b.sceneNum) });

  if (blocked.length > 0) {
    console.log(`\n🔴 GATE V FALLITO — ${blocked.length} scene divergono dal keyframe: ${blocked.map((b) => `#${b.sceneNum}`).join(", ")}`);
    console.log(`   Rigenera quelle scene (cancella assets/scene-N.mp4 + pnpm reel <script> --video-only --from ${reelDir} --skip-existing-videos),`);
    console.log(`   oppure se il keyframe stesso è sbagliato torna allo storyboard (pnpm storyboard … --force-regen=N).\n`);
    process.exit(1);
  }
  console.log(`\n✅ GATE V passato — tutte le ${results.length} scene AI combaciano coi keyframe.\n`);
}

main().catch((err) => {
  console.error("\n❌ Verify error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
