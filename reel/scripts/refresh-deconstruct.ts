/**
 * REFRESH CREATIVO — Stage 0: DECONSTRUCT (analisi frame-by-frame dell'ad originale).
 *
 * Step deterministico, read-only sulla generazione: NON crea keyframe, NON chiama
 * Kling, NON spende crediti fal. Produce la materia prima per la TABELLA SCENE che
 * l'umano approva.
 *
 * Flow:
 *   1. ffprobe meta (durata, fps, risoluzione)
 *   2. ffmpeg scene-change detection → shot boundaries (timecode)
 *   3. estrazione frame rappresentativo per shot → frames/shot-NN.png
 *   4. whisper → trascrizione VO con timecode, mappata sugli shot
 *   5. Gemini vision per shot → verdetto riproducibilità (ai-recreate/static-png/card/splice)
 *   6. deconstruction.json (validato) + selection.md (tabella scene per il gate umano)
 *
 * Usage:
 *   pnpm refresh:deconstruct <original.mp4> --out <project-dir> \
 *     [--threshold 0.3] [--lang it] [--whisper-model large-v3] \
 *     [--skip-vision] [--skip-whisper]
 *
 * Costo: whisper locale = $0; Gemini vision ~$0.30-0.80 per ad da ~30 shot.
 */

import "dotenv/config";
import { basename, dirname, isAbsolute, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { ensureDir, writeJson, readJson } from "../src/utils/file-io.js";
import { extractFrameAt } from "../src/utils/video-frame-extract.js";
import { buildSelectionGallery } from "../src/utils/selection-gallery.js";
import {
  analyzeShotForDeconstruct,
  visionModelInUse,
} from "../src/services/gemini-vision.js";
import {
  DeconstructionSchema,
  type Deconstruction,
  type DeconstructShot,
} from "../src/schemas/refresh.js";

const execFileAsync = promisify(execFile);
const VISION_CONCURRENCY = 6;
const MIN_SHOT_SEC = 0.45; // shot più corti vengono fusi nel precedente

interface Opts {
  src: string;
  outDir: string;
  threshold: number;
  lang: string;
  whisperModel: string;
  skipVision: boolean;
  skipWhisper: boolean;
  galleryOnly: boolean;
}

function parseArgs(): Opts {
  const args = process.argv.slice(2);
  let src: string | undefined;
  let outDir: string | undefined;
  let threshold = 0.3;
  let lang = "it";
  let whisperModel = "large-v3";
  let skipVision = false;
  let skipWhisper = false;
  let galleryOnly = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out" && i + 1 < args.length) outDir = args[++i];
    else if (a.startsWith("--out=")) outDir = a.slice("--out=".length);
    else if (a.startsWith("--threshold=")) threshold = parseFloat(a.slice("--threshold=".length));
    else if (a === "--threshold" && i + 1 < args.length) threshold = parseFloat(args[++i]);
    else if (a.startsWith("--lang=")) lang = a.slice("--lang=".length);
    else if (a === "--lang" && i + 1 < args.length) lang = args[++i];
    else if (a.startsWith("--whisper-model=")) whisperModel = a.slice("--whisper-model=".length);
    else if (a === "--whisper-model" && i + 1 < args.length) whisperModel = args[++i];
    else if (a === "--skip-vision") skipVision = true;
    else if (a === "--skip-whisper") skipWhisper = true;
    else if (a === "--gallery-only") galleryOnly = true;
    else if (!a.startsWith("--")) src = a;
  }

  // --gallery-only rigenera solo selection.md/.html da un deconstruction.json esistente
  // (utile dopo aver editato a mano i verdetti). Non richiede il path dell'originale.
  if (!src && !galleryOnly) {
    console.error(
      "Usage: pnpm refresh:deconstruct <original.mp4> --out <project-dir> [--threshold 0.3] [--lang it] [--whisper-model large-v3] [--skip-vision] [--skip-whisper]\n   oppure: pnpm refresh:deconstruct --out <project-dir> --gallery-only   (rigenera solo la galleria dai verdetti correnti)"
    );
    process.exit(1);
  }
  const srcAbs = src ? (isAbsolute(src) ? src : join(process.cwd(), src)) : "";
  return {
    src: srcAbs,
    outDir: outDir ?? (srcAbs ? dirname(srcAbs) : process.cwd()),
    threshold: Number.isFinite(threshold) ? threshold : 0.3,
    lang,
    whisperModel,
    skipVision,
    skipWhisper,
    galleryOnly,
  };
}

interface ProbeMeta {
  durationSec: number;
  fps: number;
  width: number;
  height: number;
}

async function probeMeta(src: string): Promise<ProbeMeta> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    src,
  ]);
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s: any) => s.codec_type === "video");
  if (!v) throw new Error("Nessuno stream video trovato nell'originale");
  const [num, den] = String(v.avg_frame_rate || v.r_frame_rate || "25/1").split("/").map(Number);
  const fps = den ? num / den : 25;
  return {
    durationSec: parseFloat(j.format?.duration ?? v.duration ?? "0"),
    fps: Number.isFinite(fps) && fps > 0 ? fps : 25,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
  };
}

/** Rileva i cut via ffmpeg scene-change e ritorna i timecode di inizio shot. */
async function detectShotBoundaries(src: string, threshold: number, durationSec: number): Promise<number[]> {
  const cuts = await new Promise<number[]>((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-hide_banner",
      "-i", src,
      "-filter:v", `select='gt(scene,${threshold})',showinfo`,
      "-an",
      "-f", "null",
      "-",
    ]);
    let err = "";
    p.stderr.on("data", (c) => (err += c.toString()));
    p.on("error", reject);
    p.on("close", () => {
      const ts: number[] = [];
      const re = /pts_time:([0-9.]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(err)) !== null) {
        const t = parseFloat(m[1]);
        if (Number.isFinite(t) && t > MIN_SHOT_SEC) ts.push(t);
      }
      resolve(ts);
    });
  });

  // boundaries = [0, ...cuts, duration]; poi fondi gli shot troppo corti.
  const bounds = [0, ...cuts.filter((t) => t < durationSec - MIN_SHOT_SEC), durationSec];
  const merged: number[] = [bounds[0]];
  for (let i = 1; i < bounds.length; i++) {
    if (bounds[i] - merged[merged.length - 1] >= MIN_SHOT_SEC) merged.push(bounds[i]);
  }
  if (merged[merged.length - 1] < durationSec) merged[merged.length - 1] = durationSec;
  return merged;
}

interface WhisperSegment {
  startSec: number;
  endSec: number;
  text: string;
}

async function transcribe(src: string, outDir: string, model: string, lang: string): Promise<{ full: string; segments: WhisperSegment[] }> {
  // Default: "whisper" risolto dal PATH. Se l'installazione è fuori PATH
  // (es. Python.org framework su macOS), imposta WHISPER_BIN nel .env.
  const whisperBin = process.env.WHISPER_BIN?.trim() || "whisper";
  const whDir = join(outDir, ".whisper");
  await ensureDir(whDir);
  await new Promise<void>((resolve, reject) => {
    const p = spawn(whisperBin, [
      src,
      "--model", model,
      "--language", lang,
      "--task", "transcribe",
      "--output_format", "json",
      "--output_dir", whDir,
      "--fp16", "False",
      "--verbose", "False",
    ], { stdio: ["ignore", "ignore", "inherit"] });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`whisper exit ${code}`))));
  });
  const stem = basename(src).replace(/\.[^.]+$/, "");
  const jsonPath = join(whDir, `${stem}.json`);
  const raw = JSON.parse(await readFile(jsonPath, "utf-8"));
  const segments: WhisperSegment[] = (raw.segments || []).map((s: any) => ({
    startSec: Number(s.start) || 0,
    endSec: Number(s.end) || 0,
    text: String(s.text || "").trim(),
  }));
  return { full: String(raw.text || "").trim(), segments };
}

function voForShot(segments: WhisperSegment[], startSec: number, endSec: number): string {
  return segments
    .filter((s) => {
      const mid = (s.startSec + s.endSec) / 2;
      return mid >= startSec && mid < endSec;
    })
    .map((s) => s.text)
    .join(" ")
    .trim();
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

function buildSelectionMd(d: Deconstruction): string {
  const counts: Record<string, number> = { "ai-recreate": 0, "static-png": 0, card: 0, splice: 0 };
  for (const s of d.shots) counts[s.verdict]++;
  const rows = d.shots
    .map((s) => {
      const t = `${s.startSec.toFixed(1)}–${s.endSec.toFixed(1)}`;
      const see = `${s.subject}${s.setting ? `, ${s.setting}` : ""}`.replace(/\|/g, "/").slice(0, 70);
      const txt = (s.onScreenText || "").replace(/\|/g, "/").slice(0, 28);
      const vo = (s.vo || "").replace(/\|/g, "/").slice(0, 60);
      const lowConf = s.confidence < 0.6 ? " ⚠️" : "";
      return `| ${s.index} | ${t} | ${s.durationSec.toFixed(1)}s | ${see} | ${txt} | **${s.verdict}**${lowConf} | ${s.confidence.toFixed(2)} | ${vo} |`;
    })
    .join("\n");
  return `# Tabella scene — refresh creativo

> Verdetti **proposti** dal deconstruct. Approva o **ribalta** la colonna Verdetto prima di generare qualsiasi cosa.
> Vocabolario: \`ai-recreate\` | \`static-png\` | \`card\` | \`splice\`. Le righe con ⚠️ (confidenza < 0.60) vanno riviste a mano.

Origine: \`${d.meta.source}\`
${d.meta.durationSec.toFixed(1)}s · ${d.meta.width}x${d.meta.height} · ${d.meta.fps.toFixed(2)}fps · ${d.meta.shotCount} shot · soglia scene-change ${d.meta.shotThreshold}

| # | Tempo (s) | Durata | Cosa si vede | Testo a schermo | Verdetto | Conf | Voiceover |
|---|-----------|--------|--------------|-----------------|----------|------|-----------|
${rows}

## Legenda
- **ai-recreate** → keyframe Gemini + image-to-video ancorato (oggetti/atmosfere SENZA testo né identità specifica)
- **static-png** → PNG pulito (pack-shot) + Ken Burns (prodotto-con-scritte con asset brand disponibile)
- **card** → componente React registrato (badge / recensioni / garanzia / prezzo / QR / CTA / KPI)
- **splice** → spezzone VERBATIM dell'originale (talking-head, before/after con identità, dimostrazioni difficili)

## Conteggio proposto
ai-recreate: ${counts["ai-recreate"]} · static-png: ${counts["static-png"]} · card: ${counts.card} · splice: ${counts.splice}

> Frame rappresentativi: \`frames/shot-NN.png\`. Dati completi: \`deconstruction.json\`.
`;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  await ensureDir(opts.outDir);

  // Modalità rigenera-solo-galleria: legge il deconstruction.json esistente e
  // ricostruisce selection.md + selection.html (dopo edit manuale dei verdetti).
  if (opts.galleryOnly) {
    const decon = DeconstructionSchema.parse(await readJson(join(opts.outDir, "deconstruction.json")));
    await (await import("node:fs/promises")).writeFile(join(opts.outDir, "selection.md"), buildSelectionMd(decon), "utf-8");
    const htmlPath = await buildSelectionGallery(opts.outDir, decon);
    console.log(`🖼️  Galleria rigenerata: ${htmlPath}`);
    return;
  }

  const framesDir = join(opts.outDir, "frames");
  await ensureDir(framesDir);

  console.log(`\n🔬 REFRESH — DECONSTRUCT`);
  console.log(`   Originale: ${opts.src}`);
  console.log(`   Output:    ${opts.outDir}`);

  // 1. meta
  const meta = await probeMeta(opts.src);
  console.log(`   Meta: ${meta.durationSec.toFixed(1)}s · ${meta.width}x${meta.height} · ${meta.fps.toFixed(2)}fps`);

  // 2. shot boundaries
  const bounds = await detectShotBoundaries(opts.src, opts.threshold, meta.durationSec);
  const shotsRaw = bounds.slice(0, -1).map((start, i) => ({ start, end: bounds[i + 1] }));
  console.log(`   Shot rilevati: ${shotsRaw.length} (soglia ${opts.threshold})`);

  // 3. frame per shot
  for (let i = 0; i < shotsRaw.length; i++) {
    const { start, end } = shotsRaw[i];
    const at = (start + end) / 2;
    const fp = join(framesDir, `shot-${String(i + 1).padStart(2, "0")}.png`);
    await extractFrameAt(opts.src, at, fp);
  }
  console.log(`   Frame estratti: ${shotsRaw.length} → frames/`);

  // 4. trascrizione
  let transcription = { full: "", segments: [] as WhisperSegment[] };
  if (!opts.skipWhisper) {
    process.stdout.write(`   Whisper (${opts.whisperModel}, ${opts.lang})… `);
    transcription = await transcribe(opts.src, opts.outDir, opts.whisperModel, opts.lang);
    console.log(`OK (${transcription.segments.length} segmenti)`);
  } else {
    console.log("   Whisper: skip");
  }

  // 5. vision per shot
  const shots: DeconstructShot[] = [];
  if (!opts.skipVision) {
    console.log(`   Vision (${visionModelInUse()}, x${VISION_CONCURRENCY})…`);
    const results = await mapWithConcurrency(shotsRaw, VISION_CONCURRENCY, async (s, i) => {
      const fpRel = `frames/shot-${String(i + 1).padStart(2, "0")}.png`;
      const fpAbs = join(opts.outDir, fpRel);
      const vo = voForShot(transcription.segments, s.start, s.end);
      try {
        const v = await analyzeShotForDeconstruct(fpAbs, { vo, durationSec: s.end - s.start });
        return { i, fpRel, vo, v };
      } catch (e) {
        console.log(`   ⚠️  Shot ${i + 1}: vision fallita (${e instanceof Error ? e.message : e}) → splice fallback`);
        return { i, fpRel, vo, v: null as null | Awaited<ReturnType<typeof analyzeShotForDeconstruct>> };
      }
    });
    for (const r of results) {
      const s = shotsRaw[r.i];
      shots.push({
        index: r.i + 1,
        startSec: s.start,
        endSec: s.end,
        durationSec: s.end - s.start,
        framePath: r.fpRel,
        vo: r.vo,
        onScreenText: r.v?.onScreenText ?? "",
        subject: r.v?.subject ?? "",
        setting: r.v?.setting ?? "",
        motion: r.v?.motion ?? "",
        hasReadableText: r.v?.hasReadableText ?? false,
        hasLogoOrUI: r.v?.hasLogoOrUI ?? false,
        isProductWithText: r.v?.isProductWithText ?? false,
        isTalkingHead: r.v?.isTalkingHead ?? false,
        isBeforeAfter: r.v?.isBeforeAfter ?? false,
        verdict: r.v?.verdict ?? "splice",
        rationale: r.v?.rationale ?? "vision non disponibile — default splice",
        confidence: r.v ? r.v.confidence : 0,
      });
    }
  } else {
    console.log("   Vision: skip (verdetti = splice placeholder)");
    shotsRaw.forEach((s, i) => {
      shots.push({
        index: i + 1,
        startSec: s.start,
        endSec: s.end,
        durationSec: s.end - s.start,
        framePath: `frames/shot-${String(i + 1).padStart(2, "0")}.png`,
        vo: voForShot(transcription.segments, s.start, s.end),
        onScreenText: "",
        subject: "",
        setting: "",
        motion: "",
        hasReadableText: false,
        hasLogoOrUI: false,
        isProductWithText: false,
        isTalkingHead: false,
        isBeforeAfter: false,
        verdict: "splice",
        rationale: "vision skippata",
        confidence: 0,
      });
    });
  }

  // 6. assembla + valida + scrivi
  const decon: Deconstruction = DeconstructionSchema.parse({
    meta: {
      source: opts.src,
      durationSec: meta.durationSec,
      fps: meta.fps,
      width: meta.width,
      height: meta.height,
      shotThreshold: opts.threshold,
      shotCount: shots.length,
      generatedAt: new Date().toISOString(),
      whisperModel: opts.skipWhisper ? undefined : opts.whisperModel,
      visionModel: opts.skipVision ? undefined : visionModelInUse(),
    },
    transcription: {
      full: transcription.full,
      segments: transcription.segments,
    },
    shots,
  });

  const deconPath = join(opts.outDir, "deconstruction.json");
  const selPath = join(opts.outDir, "selection.md");
  await writeJson(deconPath, decon);
  await (await import("node:fs/promises")).writeFile(selPath, buildSelectionMd(decon), "utf-8");
  const htmlPath = await buildSelectionGallery(opts.outDir, decon);

  const counts: Record<string, number> = { "ai-recreate": 0, "static-png": 0, card: 0, splice: 0 };
  for (const s of shots) counts[s.verdict]++;
  console.log(`\n📊 Verdetti proposti: ai-recreate ${counts["ai-recreate"]} · static-png ${counts["static-png"]} · card ${counts.card} · splice ${counts.splice}`);
  console.log(`\n🟡 GATE TABELLA SCENE — apri la galleria visiva, rivedi e approva i verdetti prima di generare:`);
  console.log(`   ${htmlPath}`);
  console.log(`   (markdown: ${selPath} · dati: ${deconPath})\n`);
}

main().catch((err) => {
  console.error("\n❌ Deconstruct error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
