/**
 * Genera scene-map.md per un reel: tabella numero/tempi/voiceover/asset
 * pronta per la review umana. Zero AI di default, solo lettura file + ffprobe.
 *
 * Con flag --vision (L2): estrae 2 frame per clip (first + mid) e chiama
 * Gemini 3.1 Pro per giudicare aderenza al visualPrompt. Costo ~$0.40-0.80
 * per reel da 30 scene. Cache risultati in assets/scene-N-vision.json.
 *
 * Fonti dati:
 *  - script.json             — voiceoverSegment, visualPrompt, provider, kinetic, continuity
 *  - composition-props.json  — durationInFrames per scena (source of truth timing)
 *  - assets/scene-N.mp4      — ffprobe per durata clip reale + frame extraction
 *  - assets/voiceover.mp3    — ffprobe per durata audio totale
 *  - assets/scene-N-original.mp4 / -omnihuman.mp4 — flag per varianti applicate
 *
 * Output:
 *  - <reel-dir>/scene-map.md             — tabella + sintesi
 *  - <reel-dir>/assets/scene-N-vision.json (con --vision, cache verdict)
 *
 * Usage:
 *   pnpm tsx scripts/scene-map.ts <reel-dir>           # L1 solo dati
 *   pnpm tsx scripts/scene-map.ts <reel-dir> --vision  # L1 + L2 Gemini
 */
import "dotenv/config";
import { join } from "node:path";
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReelScript } from "../src/schemas/script.js";
import { analyzeScene, visionModelInUse, type SceneVisionVerdict } from "../src/services/gemini-vision.js";

const execFileAsync = promisify(execFile);
const FPS = 30;
const VISION_CONCURRENCY = 6; // parallel Gemini calls — alza solo se hai tier alto

interface CompositionProps {
  compositionId: string;
  props: {
    hook: string;
    scenes: Array<{
      text: string;
      videoUrl?: string;
      durationInFrames: number;
    }>;
    cta: string;
    voiceoverUrl?: string;
  };
  durationInFrames: number;
}

async function fileExists(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false);
}

async function ffprobeDuration(p: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      p,
    ]);
    return parseFloat(JSON.parse(stdout).format.duration);
  } catch {
    return null;
  }
}

/**
 * Estrae 2 frame da un clip video: first (0s) e mid (durata/2). Usa ffmpeg.
 * Restituisce i path PNG estratti. Le directory vengono create se mancano.
 */
async function extractTwoFrames(
  videoPath: string,
  durationSec: number,
  outDir: string,
  baseName: string
): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const firstPath = join(outDir, `${baseName}-frame1.png`);
  const midPath = join(outDir, `${baseName}-frame2.png`);
  const midTime = Math.max(0.1, durationSec / 2);

  await execFileAsync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-ss", "0",
    "-i", videoPath,
    "-frames:v", "1",
    "-q:v", "3",
    firstPath,
  ]);
  await execFileAsync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-ss", midTime.toFixed(2),
    "-i", videoPath,
    "-frames:v", "1",
    "-q:v", "3",
    midPath,
  ]);
  return [firstPath, midPath];
}

interface VisionCacheEntry {
  visualPrompt: string;
  verdict: SceneVisionVerdict;
  generatedAt: string;
  model: string;
}

async function loadVisionCache(cachePath: string, currentPrompt: string): Promise<SceneVisionVerdict | null> {
  if (!(await fileExists(cachePath))) return null;
  try {
    const raw = await readFile(cachePath, "utf-8");
    const entry: VisionCacheEntry = JSON.parse(raw);
    // Cache valido solo se il visualPrompt non è cambiato dall'ultima analisi
    if (entry.visualPrompt !== currentPrompt) return null;
    return entry.verdict;
  } catch {
    return null;
  }
}

async function saveVisionCache(
  cachePath: string,
  visualPrompt: string,
  verdict: SceneVisionVerdict
): Promise<void> {
  const entry: VisionCacheEntry = {
    visualPrompt,
    verdict,
    generatedAt: new Date().toISOString(),
    model: visionModelInUse(),
  };
  await writeFile(cachePath, JSON.stringify(entry, null, 2), "utf-8");
}

/**
 * Limita la concorrenza di N promise async (workaround senza p-limit dep).
 * Esegue tasks in batch da `concurrency`, attende ogni batch prima del successivo.
 */
async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((item, j) => fn(item, i + j))
    );
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j];
    }
  }
  return results;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export interface SceneMapResult {
  outPath: string;
  totalScenes: number;
  totalDurSec: number;
  audioDurSec: number;
  freezeCount: number;
  missingCount: number;
  visionRan: boolean;
  visionRigenerateCount: number;
  visionBorderlineCount: number;
  visionFailedCount: number;
}

export interface SceneMapOptions {
  /** Se true, esegue L2 vision: estrae frame + chiama Gemini per ogni clip. Costo ~$0.40-0.80/reel. */
  vision?: boolean;
  /** Se true, ignora cache scene-N-vision.json e re-interroga Gemini. Default false. */
  visionForceRefresh?: boolean;
}

/**
 * Genera scene-map.md per un reel renderizzato. Esportata per integrazione
 * nella pipeline (chiamata in coda a runPipeline). Lancia errore se mancano
 * i file richiesti — il chiamante decide se è bloccante o no.
 */
export async function generateSceneMap(
  reelDir: string,
  options: SceneMapOptions = {}
): Promise<SceneMapResult> {
  const scriptPath = join(reelDir, "script.json");
  const propsPath = join(reelDir, "composition-props.json");
  const voiceoverPath = join(reelDir, "assets", "voiceover.mp3");

  if (!(await fileExists(scriptPath))) {
    throw new Error(`script.json non trovato in ${reelDir}`);
  }
  if (!(await fileExists(propsPath))) {
    throw new Error(
      `composition-props.json non trovato in ${reelDir} — lancia 'pnpm tsx scripts/recalc-props.ts' prima`
    );
  }

  const script: ReelScript = JSON.parse(await readFile(scriptPath, "utf-8"));
  const props: CompositionProps = JSON.parse(await readFile(propsPath, "utf-8"));

  if (props.props.scenes.length !== script.scenes.length) {
    console.error(
      `⚠️  Mismatch scene: script ha ${script.scenes.length}, composition-props ha ${props.props.scenes.length}. Rilancia recalc-props.`
    );
  }

  const audioDur = (await ffprobeDuration(voiceoverPath)) ?? 0;
  const isMultiVoice = !!script.voiceoverSegments && script.voiceoverSegments.length > 0;
  const voiceMode = isMultiVoice
    ? `multi-voce (${script.voiceoverSegments!.length} seg)`
    : `single (${script.voiceId ?? "default"})`;

  // Compute scene start times from cumulative durationInFrames
  const sceneStartSecs: number[] = [];
  let cursor = 0;
  for (const s of props.props.scenes) {
    sceneStartSecs.push(cursor);
    cursor += s.durationInFrames / FPS;
  }

  // Build rows in parallel (ffprobe per scene clip)
  const rows = await Promise.all(
    script.scenes.map(async (scene, i) => {
      const propScene = props.props.scenes[i];
      const sceneDurSec = propScene ? propScene.durationInFrames / FPS : scene.durationSec;
      const startSec = sceneStartSecs[i] ?? 0;

      const sceneNum = i + 1;
      const videoRelPath = propScene?.videoUrl;
      let clipDurSec: number | null = null;
      let clipNote = "";
      let variantFlags: string[] = [];

      if (videoRelPath) {
        const clipFullPath = join(reelDir, videoRelPath);
        clipDurSec = await ffprobeDuration(clipFullPath);
        if (clipDurSec === null) {
          clipNote = "❌ missing";
        }

        // Detect variants
        const omnihumanPath = join(reelDir, "assets", `scene-${sceneNum}-omnihuman.mp4`);
        const originalPath = join(reelDir, "assets", `scene-${sceneNum}-original.mp4`);
        if (await fileExists(omnihumanPath)) variantFlags.push("OMNI");
        else if (await fileExists(originalPath)) variantFlags.push("LIPSYNC");
      }

      // Type classification
      let tipo: string;
      if (scene.kinetic) tipo = "KIN";
      else if (!scene.visualPrompt.trim()) tipo = "TEXT";
      else if (scene.provider === "veo3") tipo = "VEO3";
      else if (scene.provider === "heygen") tipo = "HEY";
      else tipo = "KLING";

      // Sync status: clip ≥ scena? (regola d'oro)
      let syncStatus: string;
      if (!videoRelPath) {
        syncStatus = "—";
      } else if (clipDurSec === null) {
        syncStatus = "❌ no file";
      } else if (clipDurSec + 0.05 < sceneDurSec) {
        // tolleranza 50ms su float ffprobe
        const freeze = sceneDurSec - clipDurSec;
        syncStatus = `🔴 FREEZE ${freeze.toFixed(1)}s`;
      } else {
        syncStatus = `✅ ${clipDurSec.toFixed(1)}s`;
      }

      // Visual prompt: first 80 chars
      const visualShort = truncate(scene.visualPrompt.trim() || "(no visualPrompt)", 80);
      // Voiceover segment: first 60 chars
      const voSegment = scene.voiceoverSegment?.trim()
        ? truncate(scene.voiceoverSegment.trim(), 60)
        : "(no segment)";

      const contFlag = scene.continuity ? "🔗" : "";
      const flagsStr = [contFlag, ...variantFlags].filter(Boolean).join(" ");

      return {
        sceneNum,
        startSec,
        sceneDurSec,
        tipo,
        syncStatus,
        voSegment,
        visualShort,
        flagsStr,
        videoRelPath: videoRelPath ?? "",
        // raw values for summary
        clipDurSec,
        freezeRisk: !!videoRelPath && clipDurSec !== null && clipDurSec + 0.05 < sceneDurSec,
      };
    })
  );

  // Summary stats
  const totalScenes = rows.length;
  const freezeCount = rows.filter((r) => r.freezeRisk).length;
  const missingCount = rows.filter((r) => r.videoRelPath && r.clipDurSec === null).length;
  const klingCount = rows.filter((r) => r.tipo === "KLING").length;
  const textCount = rows.filter((r) => r.tipo === "TEXT").length;
  const kineticCount = rows.filter((r) => r.tipo === "KIN").length;
  const veoCount = rows.filter((r) => r.tipo === "VEO3").length;
  const heyCount = rows.filter((r) => r.tipo === "HEY").length;
  const lipsyncCount = rows.filter((r) => r.flagsStr.includes("LIPSYNC")).length;
  const omniCount = rows.filter((r) => r.flagsStr.includes("OMNI")).length;
  const continuityCount = rows.filter((r) => r.flagsStr.includes("🔗")).length;

  // ────────────────────────────────────────────────────────────────────
  // L2 — Vision pass (opzionale, gated da options.vision)
  // ────────────────────────────────────────────────────────────────────
  const visionResults = new Map<number, { verdict?: SceneVisionVerdict; error?: string; fromCache: boolean }>();
  let visionRan = false;
  let visionApiCallsMade = 0;
  let visionCacheHits = 0;

  if (options.vision) {
    visionRan = true;
    // Candidati: scene con video file presente (esclude TEXT, KIN, mancanti)
    const candidates = rows.filter(
      (r) => r.videoRelPath && r.clipDurSec !== null && (rows[r.sceneNum - 1] && script.scenes[r.sceneNum - 1].visualPrompt.trim())
    );
    const visionFramesDir = join(reelDir, "assets", ".vision-frames");

    console.log(
      `\n🔍 STAGE L2 — Vision pass (${candidates.length} scene candidate, modello: ${visionModelInUse()}, concorrenza: ${VISION_CONCURRENCY})...`
    );

    await withConcurrency(candidates, VISION_CONCURRENCY, async (row) => {
      const sceneNum = row.sceneNum;
      const scene = script.scenes[sceneNum - 1];
      const cachePath = join(reelDir, "assets", `scene-${sceneNum}-vision.json`);

      // Check cache (skip API se prompt invariato)
      if (!options.visionForceRefresh) {
        const cached = await loadVisionCache(cachePath, scene.visualPrompt);
        if (cached) {
          visionResults.set(sceneNum, { verdict: cached, fromCache: true });
          visionCacheHits++;
          console.log(`   📋 Scena ${sceneNum}: cache hit (verdict: ${cached.verdict}, ${cached.adherence}/10)`);
          return;
        }
      }

      // Cache miss: extract frames + call Gemini
      try {
        const clipPath = join(reelDir, row.videoRelPath);
        const frames = await extractTwoFrames(
          clipPath,
          row.clipDurSec!,
          visionFramesDir,
          `scene-${sceneNum}`
        );
        const verdict = await analyzeScene(scene.visualPrompt, frames);
        await saveVisionCache(cachePath, scene.visualPrompt, verdict);
        visionResults.set(sceneNum, { verdict, fromCache: false });
        visionApiCallsMade++;
        const emoji = verdict.verdict === "ok" ? "✅" : verdict.verdict === "borderline" ? "🟡" : "🔴";
        console.log(`   ${emoji} Scena ${sceneNum}: ${verdict.verdict} (${verdict.adherence}/10)${verdict.issues.length > 0 ? ` — ${verdict.issues.length} issue` : ""}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        visionResults.set(sceneNum, { error: msg, fromCache: false });
        console.log(`   ❌ Scena ${sceneNum}: vision FALLITA — ${msg.slice(0, 80)}`);
      }
    });

    const visionErrorCount = Array.from(visionResults.values()).filter((v) => v.error).length;
    console.log(`\n   ✅ Vision pass completata (${visionApiCallsMade} API live, ${visionCacheHits} da cache, ${visionErrorCount} errori)`);
  }

  const visionRigenerateCount = Array.from(visionResults.values()).filter((v) => v.verdict?.verdict === "rigenerare").length;
  const visionBorderlineCount = Array.from(visionResults.values()).filter((v) => v.verdict?.verdict === "borderline").length;
  const visionFailedCount = Array.from(visionResults.values()).filter((v) => v.error).length;

  // Build markdown
  const lines: string[] = [];
  lines.push(`# Scene Map — ${reelDir.split("/").slice(-2).join("/")}`);
  lines.push("");
  lines.push(`Generato: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Sintesi");
  lines.push("");
  lines.push(`- **Scene**: ${totalScenes} (KLING: ${klingCount}, VEO3: ${veoCount}, HEY: ${heyCount}, TEXT: ${textCount}, KIN: ${kineticCount})`);
  lines.push(`- **Durata totale**: ${formatTime(cursor)} (${cursor.toFixed(1)}s) — audio voiceover: ${audioDur.toFixed(1)}s`);
  lines.push(`- **Voce**: ${voiceMode}`);
  lines.push(`- **Continuity scene**: ${continuityCount}`);
  lines.push(`- **Lipsync applicato**: ${lipsyncCount} | **OmniHuman**: ${omniCount}`);
  if (visionRan) {
    lines.push(`- **Vision (${visionModelInUse()})**: ${visionRigenerateCount} da rigenerare, ${visionBorderlineCount} borderline, ${visionFailedCount} fallite`);
  }
  lines.push("");

  // Gate warnings (highlight in summary)
  const hasGateViolations = freezeCount > 0 || missingCount > 0 || visionRigenerateCount > 0;
  if (hasGateViolations) {
    lines.push("### ⚠️ Gate violati");
    lines.push("");
    if (freezeCount > 0) {
      const freezeScenes = rows.filter((r) => r.freezeRisk).map((r) => `#${r.sceneNum} (freeze ${(r.sceneDurSec - (r.clipDurSec ?? 0)).toFixed(1)}s)`);
      lines.push(`- 🔴 **FREEZE su ${freezeCount} scene** (clip < scena): ${freezeScenes.join(", ")}`);
      lines.push(`  - Azione: rigenera con \`durationSec\` aumentato, o splitta in 2 scene <10s, o riusa clip più lungo`);
    }
    if (missingCount > 0) {
      const missingScenes = rows.filter((r) => r.videoRelPath && r.clipDurSec === null).map((r) => `#${r.sceneNum}`);
      lines.push(`- ❌ **File mp4 mancanti su ${missingCount} scene**: ${missingScenes.join(", ")}`);
    }
    if (visionRigenerateCount > 0) {
      const toRegen = Array.from(visionResults.entries())
        .filter(([, v]) => v.verdict?.verdict === "rigenerare")
        .map(([n, v]) => `#${n} (${v.verdict!.adherence}/10)`);
      lines.push(`- 🔴 **Vision suggerisce di rigenerare ${visionRigenerateCount} scene**: ${toRegen.join(", ")}`);
      lines.push(`  - Vedi sezione "Dettaglio vision" sotto per descrizione e issue per ogni scena`);
    }
    lines.push("");
  } else {
    lines.push("✅ Tutti i gate passano (sync clip ≥ scena, nessun file mancante" + (visionRan ? ", vision aderenza ≥ borderline" : "") + ").");
    lines.push("");
  }

  // Table
  lines.push("## Tabella scene");
  lines.push("");
  if (visionRan) {
    lines.push("| # | Time | Dur | Tipo | Flags | Sync | Vision | Voiceover | Visual prompt |");
    lines.push("|---|------|-----|------|-------|------|--------|-----------|---------------|");
  } else {
    lines.push("| # | Time | Dur | Tipo | Flags | Sync | Voiceover | Visual prompt |");
    lines.push("|---|------|-----|------|-------|------|-----------|---------------|");
  }
  for (const r of rows) {
    const base = `| ${r.sceneNum} | ${formatTime(r.startSec)} | ${r.sceneDurSec.toFixed(1)}s | ${r.tipo} | ${r.flagsStr || "—"} | ${r.syncStatus} |`;
    const tail = ` ${escapePipes(r.voSegment)} | ${escapePipes(r.visualShort)} |`;
    if (visionRan) {
      const v = visionResults.get(r.sceneNum);
      let visionCell = "—";
      if (v?.error) visionCell = "❌ FAIL";
      else if (v?.verdict) {
        const emoji = v.verdict.verdict === "ok" ? "✅" : v.verdict.verdict === "borderline" ? "🟡" : "🔴";
        visionCell = `${emoji} ${v.verdict.adherence}/10`;
      }
      lines.push(`${base} ${visionCell} |${tail}`);
    } else {
      lines.push(`${base}${tail}`);
    }
  }
  lines.push("");

  // Vision details section (solo se vision ran e ci sono scene borderline/rigenerare/fail)
  if (visionRan && (visionRigenerateCount > 0 || visionBorderlineCount > 0 || visionFailedCount > 0)) {
    lines.push("## Dettaglio vision (scene non-OK)");
    lines.push("");
    const sortedEntries = Array.from(visionResults.entries()).sort(([a], [b]) => a - b);
    for (const [sceneNum, v] of sortedEntries) {
      if (v.verdict?.verdict === "ok") continue; // skip OK in dettaglio
      lines.push(`### Scena #${sceneNum}`);
      lines.push("");
      if (v.error) {
        lines.push(`**Vision FAIL**: ${v.error}`);
      } else if (v.verdict) {
        const emoji = v.verdict.verdict === "borderline" ? "🟡" : "🔴";
        lines.push(`**Verdict**: ${emoji} ${v.verdict.verdict.toUpperCase()} (${v.verdict.adherence}/10)`);
        lines.push("");
        lines.push(`**Osservato**: ${v.verdict.observed}`);
        if (v.verdict.issues.length > 0) {
          lines.push("");
          lines.push(`**Issue**:`);
          for (const issue of v.verdict.issues) {
            lines.push(`- ${issue}`);
          }
        }
      }
      lines.push("");
    }
  }

  lines.push("## Legenda");
  lines.push("");
  lines.push("- **Tipo**: KLING (text-to-video Kling 3.0), VEO3 (Veo 3 audio nativo), HEY (HeyGen avatar), TEXT (Remotion testo), KIN (KineticNumber)");
  lines.push("- **Flags**: 🔗 continuity (image-to-video da ultimo frame precedente), LIPSYNC (scene-N-original.mp4 backup), OMNI (OmniHuman v1.5 applicato)");
  lines.push("- **Sync**: ✅ clip ≥ scena | 🔴 FREEZE (clip < scena, Remotion congela ultimo frame) | ❌ file mancante");
  if (visionRan) {
    lines.push("- **Vision**: ✅ ok | 🟡 borderline | 🔴 rigenerare (Gemini judgment su 2 frame vs visualPrompt) | ❌ FAIL (errore API o JSON malformato)");
  }
  lines.push("");

  const md = lines.join("\n");

  // Write to disk
  const outPath = join(reelDir, "scene-map.md");
  await writeFile(outPath, md, "utf-8");

  // Print short summary to stdout (full md is on disk)
  console.log(`\n✅ Scene map generata: ${outPath}\n`);
  console.log(`   Scene: ${totalScenes} | Durata: ${cursor.toFixed(1)}s | Audio: ${audioDur.toFixed(1)}s`);
  if (freezeCount > 0) {
    console.log(`   🔴 FREEZE su ${freezeCount} scene — apri il file per dettaglio`);
  }
  if (missingCount > 0) {
    console.log(`   ❌ ${missingCount} mp4 mancanti`);
  }
  if (visionRan) {
    console.log(`   🔍 Vision: ${visionRigenerateCount} da rigenerare, ${visionBorderlineCount} borderline, ${visionFailedCount} fallite (${visionApiCallsMade} chiamate API)`);
  }
  if (freezeCount === 0 && missingCount === 0 && (!visionRan || (visionRigenerateCount === 0 && visionFailedCount === 0))) {
    console.log(`   ✅ Tutti i gate passano`);
  }
  console.log("");

  return {
    outPath,
    totalScenes,
    totalDurSec: cursor,
    audioDurSec: audioDur,
    freezeCount,
    missingCount,
    visionRan,
    visionRigenerateCount,
    visionBorderlineCount,
    visionFailedCount,
  };
}

// CLI entry point: pnpm scene-map <reel-dir> [--vision] [--vision-refresh]
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("scene-map.ts");

if (isDirectRun) {
  const args = process.argv.slice(2);
  const reelDir = args.find((a) => !a.startsWith("--"));
  if (!reelDir) {
    console.error("Usage: pnpm tsx scripts/scene-map.ts <reel-dir> [--vision] [--vision-refresh]");
    console.error("  --vision           Esegue L2 Gemini vision pass (costo ~$0.40-0.80 per reel da 30 scene con gemini-3.1-pro)");
    console.error("  --vision-refresh   Ignora cache scene-N-vision.json e re-interroga Gemini su tutte le scene");
    process.exit(1);
  }
  const vision = args.includes("--vision") || args.includes("--vision-refresh");
  const visionForceRefresh = args.includes("--vision-refresh");
  generateSceneMap(reelDir, { vision, visionForceRefresh }).catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
