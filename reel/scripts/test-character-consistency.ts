/**
 * Character Consistency Test — valida se la pipeline reel-engine è in grado di
 * mantenere riconoscibili 1+ personaggi distinti su N variazioni di
 * azione/emozione, e confronta i due engine disponibili:
 *
 *   - i2v  — Gemini 3 Pro Image keyframe → Kling 3.0 Pro image-to-video
 *            (path storico: ancora SOLO il primo frame, il volto può driftare
 *            durante il movimento)
 *   - r2v  — Kling O3 reference-to-video con Elements: keyframe come start
 *            frame + character sheet (frontale + tre quarti + profilo) come
 *            element binding → identità agganciata per l'intera clip
 *
 * Deal-breaker per concept multi-character (es. parodia talk show 90s con 5-6
 * archetipi-tool): se il character drifta scene-per-scene, il concept crolla.
 *
 * Flow per ogni character del cast:
 *   1. Gemini 3 Pro Image → keyframe.png canonical (close-up neutro)
 *   1b. [solo r2v] Gemini con keyframe come reference → sheet-3q.png +
 *       sheet-profile.png (character sheet multi-vista per gli elements)
 *   2. Per ciascuna variation × engine: clip 5s → var-N[-engine].mp4
 *   3. ffmpeg → estrai frame mid + last di ogni clip
 *   4. Gemini Vision (compareConsistency) → score 4D per ogni frame estratto
 *   5. Aggrega per character × engine: avg facialIdentity, avg overall, drift rate
 *
 * Output:
 *   <outDir>/cast.json                  — copia input
 *   <outDir>/<char-id>/keyframe.png     — riferimento canonical
 *   <outDir>/<char-id>/sheet-*.png      — character sheet (solo r2v)
 *   <outDir>/<char-id>/var-N[-eng].mp4  — clip generati
 *   <outDir>/<char-id>/var-N[-eng]-{mid,last}.png — frame estratti
 *   <outDir>/<char-id>/scores.json      — verdict raw Gemini per ogni frame
 *   <outDir>/report.md                  — sommario aggregato + verdict per engine
 *   <outDir>/report.html                — gallery comparativa navigabile
 *
 * Costi unitari (2026-06): keyframe/sheet Gemini ~$0.08 · clip i2v 5s ~$0.50 ·
 * clip r2v 5s ~$0.42 (audio off) · vision check ~$0.03 (2 per clip).
 * La stima totale viene stampata all'avvio del run.
 *
 * Usage:
 *   pnpm test:consistency <cast.json>
 *   pnpm test:consistency <cast.json> --ab                  (A/B i2v vs r2v)
 *   pnpm test:consistency <cast.json> --engines=r2v         (solo r2v)
 *   pnpm test:consistency <cast.json> --chars=email-marketing,sms-marketing
 *   pnpm test:consistency <cast.json> --variations=2 --duration=5
 *   pnpm test:consistency <cast.json> --skip-vision      (no Gemini score, solo asset)
 *   pnpm test:consistency <cast.json> --out=<outDir>     (default: output-movies/consistency-tests/YYYY-MM-DD/test-NNNN)
 */

import "dotenv/config";
import { join } from "node:path";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { z } from "zod";
import { ensureDir, readJson, writeJson, OUTPUT_BASE } from "../src/utils/file-io.js";
import { generateKeyframe, imageModelInUse } from "../src/services/gemini-image.js";
import {
  generateImageToVideo,
  generateReferenceToVideo,
} from "../src/services/fal.js";
import {
  compareConsistency,
  consistencyModelInUse,
  type ConsistencyVerdict,
} from "../src/services/gemini-consistency.js";
import {
  extractMidLastFrames,
  downloadVideo,
} from "../src/utils/video-frame-extract.js";

const VariationSchema = z.object({
  action: z.string().min(3),
  duration: z.union([z.literal(5), z.literal(10)]).default(5),
});

const CharacterSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "id deve essere kebab-case"),
  label: z.string().min(1),
  keyframePrompt: z.string().min(20),
  videoVariations: z.array(VariationSchema).min(1),
});

const CastSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  characters: z.array(CharacterSchema).min(1),
});

type Cast = z.infer<typeof CastSchema>;
type Character = z.infer<typeof CharacterSchema>;

type Engine = "i2v" | "r2v";

const ENGINE_LABEL: Record<Engine, string> = {
  i2v: "Kling 3.0 Pro i2v (keyframe only)",
  r2v: "Kling O3 r2v + Elements (keyframe + character sheet)",
};

const ENGINE_MODEL: Record<Engine, string> = {
  i2v: "fal-ai/kling-video/v3/pro/image-to-video",
  r2v: "fal-ai/kling-video/o3/standard/reference-to-video",
};

/** Viste aggiuntive del character sheet (generate solo quando serve r2v). */
const SHEET_VIEWS = [
  {
    suffix: "3q",
    view: "Three-quarter view portrait, head and upper shoulders, head turned about 45 degrees to the left",
  },
  {
    suffix: "profile",
    view: "Side profile view, head and upper shoulders, head turned 90 degrees facing left",
  },
] as const;

interface CliOptions {
  castPath: string;
  outDir?: string;
  chars?: string[];
  variations?: number;
  duration?: 5 | 10;
  skipVision: boolean;
  klingModel?: string;
  engines: Engine[];
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  let castPath: string | undefined;
  let outDir: string | undefined;
  let chars: string[] | undefined;
  let variations: number | undefined;
  let duration: 5 | 10 | undefined;
  let skipVision = false;
  let klingModel: string | undefined;
  let engines: Engine[] = ["i2v"];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out" && i + 1 < args.length) outDir = args[++i];
    else if (a.startsWith("--out=")) outDir = a.slice(6);
    else if (a.startsWith("--chars=")) chars = a.slice(8).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--variations=")) variations = parseInt(a.slice(13), 10);
    else if (a.startsWith("--duration=")) {
      const d = parseInt(a.slice(11), 10);
      if (d === 5 || d === 10) duration = d;
    }
    else if (a === "--skip-vision") skipVision = true;
    else if (a.startsWith("--kling-model=")) klingModel = a.slice(14);
    else if (a === "--ab") engines = ["i2v", "r2v"];
    else if (a.startsWith("--engines=")) {
      const parsed = a.slice(10).split(",").map((s) => s.trim()).filter(Boolean);
      const valid = parsed.filter((e): e is Engine => e === "i2v" || e === "r2v");
      if (valid.length !== parsed.length || valid.length === 0) {
        console.error(`--engines accetta solo i2v,r2v (ricevuto: ${a.slice(10)})`);
        process.exit(1);
      }
      engines = [...new Set(valid)];
    }
    else if (!a.startsWith("--")) castPath = a;
  }

  if (!castPath) {
    console.error("Usage: pnpm test:consistency <cast.json> [--ab] [--engines=i2v,r2v] [--out=<dir>] [--chars=id1,id2] [--variations=N] [--duration=5|10] [--skip-vision]");
    process.exit(1);
  }

  return { castPath, outDir, chars, variations, duration, skipVision, klingModel, engines };
}

function defaultOutDir(): string {
  const date = new Date().toISOString().split("T")[0];
  const seq = String(Date.now()).slice(-4);
  return join(OUTPUT_BASE, "consistency-tests", date, `test-${seq}`);
}

/** Stima costo del run, stampata all'avvio (regola: avvisare PRIMA di spendere). */
function estimateCost(chars: Character[], variationCount: number | undefined, engines: Engine[], skipVision: boolean): number {
  const UNIT = { keyframe: 0.08, sheet: 0.08, i2v5s: 0.5, r2v5s: 0.42, vision: 0.03 };
  let cost = 0;
  for (const c of chars) {
    const nVar = variationCount ? Math.min(variationCount, c.videoVariations.length) : c.videoVariations.length;
    cost += UNIT.keyframe;
    if (engines.includes("r2v")) cost += SHEET_VIEWS.length * UNIT.sheet;
    for (const e of engines) {
      cost += nVar * (e === "i2v" ? UNIT.i2v5s : UNIT.r2v5s);
      if (!skipVision) cost += nVar * 2 * UNIT.vision;
    }
  }
  return cost;
}

interface VariationResult {
  index: number;
  engine: Engine;
  action: string;
  videoPath: string;
  durationSec: number;
  midFrame: string;
  lastFrame: string;
  midVerdict: ConsistencyVerdict | null;
  lastVerdict: ConsistencyVerdict | null;
}

interface Aggregate {
  avgFacialIdentity: number;
  avgHairStyle: number;
  avgOutfit: number;
  avgOverall: number;
  matchRate: number;
  driftRate: number;
  sampleCount: number;
}

type Verdict = "viable" | "risky" | "not-viable";

interface EngineResult {
  aggregate: Aggregate;
  verdict: Verdict;
}

interface CharacterResult {
  character: Character;
  keyframePath: string;
  sheetPaths: string[];
  variations: VariationResult[];
  byEngine: Partial<Record<Engine, EngineResult>>;
}

function aggregate(variations: VariationResult[]): Aggregate {
  const verdicts: ConsistencyVerdict[] = [];
  for (const v of variations) {
    if (v.midVerdict) verdicts.push(v.midVerdict);
    if (v.lastVerdict) verdicts.push(v.lastVerdict);
  }
  if (verdicts.length === 0) {
    return { avgFacialIdentity: 0, avgHairStyle: 0, avgOutfit: 0, avgOverall: 0, matchRate: 0, driftRate: 0, sampleCount: 0 };
  }
  const avg = (key: keyof Pick<ConsistencyVerdict, "facialIdentity" | "hairStyle" | "outfit" | "overall">) =>
    verdicts.reduce((s, v) => s + v[key], 0) / verdicts.length;
  const matches = verdicts.filter((v) => v.verdict === "match").length;
  const drifts = verdicts.filter((v) => v.verdict === "drift").length;
  return {
    avgFacialIdentity: avg("facialIdentity"),
    avgHairStyle: avg("hairStyle"),
    avgOutfit: avg("outfit"),
    avgOverall: avg("overall"),
    matchRate: matches / verdicts.length,
    driftRate: drifts / verdicts.length,
    sampleCount: verdicts.length,
  };
}

function characterVerdict(agg: Aggregate): Verdict {
  if (agg.sampleCount === 0) return "risky";
  if (agg.avgOverall >= 7.5 && agg.driftRate <= 0.15) return "viable";
  if (agg.avgOverall >= 5 && agg.driftRate <= 0.4) return "risky";
  return "not-viable";
}

/**
 * Genera le viste aggiuntive del character sheet partendo dal keyframe
 * canonico come reference Gemini. Ritorna i path delle viste generate
 * (il frontale resta il keyframe stesso).
 *
 * Il prompt è il keyframePrompt del character + override d'angolo: il prompt
 * forte gestisce contesto/stile, la reference tiene il volto (pattern validato
 * — vedi memoria feedback_reel_keyframe_gemini_gotchas). NIENTE style anchor:
 * i keyframePrompt del cast sono autocontenuti e l'anchor "iPhone photography"
 * litiga con stili di progetto (VHS 90s → renderizza un telefono con la UI).
 */
async function generateCharacterSheet(
  char: Character,
  keyframePath: string,
  charDir: string
): Promise<string[]> {
  const keyframeBuffer = await readFile(keyframePath);
  const paths: string[] = [];
  for (const view of SHEET_VIEWS) {
    const outPath = join(charDir, `sheet-${view.suffix}.png`);
    const prompt =
      `${char.keyframePrompt}\n\n` +
      `CRITICAL OVERRIDE: this image shows the SAME person as in the attached reference photo — ` +
      `identical face, identical hairstyle and hair color, identical makeup, accessories and outfit. ` +
      `But photographed from a different angle: ${view.view}, NOT looking at the camera. ` +
      `Same lighting and background style as the reference.`;
    console.log(`   🪞 sheet-${view.suffix}...`);
    await generateKeyframe(prompt, {
      outputPath: outPath,
      referenceBuffer: keyframeBuffer,
      referenceMimeType: "image/png",
      appendStyleAnchor: false,
    });
    paths.push(outPath);
  }
  return paths;
}

async function generateClip(
  engine: Engine,
  char: Character,
  v: { action: string; duration: 5 | 10 },
  keyframePath: string,
  sheetPaths: string[],
  dur: 5 | 10,
  klingModel: string | undefined
): Promise<{ url: string }> {
  if (engine === "i2v") {
    const klingPrompt = `${char.label}: ${v.action}. Maintain identical character identity, face, hair, and outfit as the input image.`;
    return generateImageToVideo(keyframePath, klingPrompt, {
      duration: dur,
      ...(klingModel ? { model: klingModel } : {}),
    });
  }
  // r2v: l'identità la portano gli elements — il prompt NON ridescrive il
  // personaggio (best practice Kling O3: azione + camera, non descrizione).
  const r2vPrompt = `@Element1 ${v.action}.`;
  return generateReferenceToVideo(
    r2vPrompt,
    [{ frontalImage: keyframePath, referenceImages: sheetPaths }],
    {
      duration: dur,
      startImagePath: keyframePath,
      aspectRatio: "9:16",
      generateAudio: false,
    }
  );
}

async function runCharacter(
  char: Character,
  outRoot: string,
  variationCount: number | undefined,
  durationOverride: 5 | 10 | undefined,
  klingModel: string | undefined,
  skipVision: boolean,
  engines: Engine[]
): Promise<CharacterResult> {
  const charDir = join(outRoot, char.id);
  await ensureDir(charDir);

  const keyframePath = join(charDir, "keyframe.png");

  console.log(`\n👤 [${char.id}] keyframe...`);
  // No style anchor: i keyframePrompt del cast sono autocontenuti; l'anchor
  // default ("iPhone photography") in conflitto con lo stile del cast produce
  // keyframe-spazzatura (es. mano che fotografa uno schermo con UI iPhone).
  await generateKeyframe(char.keyframePrompt, {
    outputPath: keyframePath,
    appendStyleAnchor: false,
  });
  console.log(`   ✓ keyframe → ${keyframePath}`);

  let sheetPaths: string[] = [];
  if (engines.includes("r2v")) {
    // Una vista rifiutata da Gemini (safety flakiness) NON deve uccidere il
    // character: r2v degrada a frontal-only (elements con solo il keyframe).
    try {
      sheetPaths = await generateCharacterSheet(char, keyframePath, charDir);
      console.log(`   ✓ character sheet → ${sheetPaths.length} viste extra`);
    } catch (err) {
      console.warn(`   ⚠️  character sheet fallito (${err instanceof Error ? err.message : err}) — r2v procede frontal-only`);
      sheetPaths = [];
    }
  }

  const limited = variationCount
    ? char.videoVariations.slice(0, variationCount)
    : char.videoVariations;

  const variations: VariationResult[] = [];

  for (let i = 0; i < limited.length; i++) {
    const v = limited[i];
    const idx = i + 1;
    const dur = (durationOverride ?? v.duration ?? 5) as 5 | 10;

    for (const engine of engines) {
      // Suffisso engine solo quando il run ne confronta più di uno: il run
      // single-engine resta identico al formato storico (var-N.mp4).
      const stem = engines.length > 1 ? `var-${idx}-${engine}` : `var-${idx}`;
      const videoPath = join(charDir, `${stem}.mp4`);

      console.log(`   🎬 ${stem} (${dur}s, ${engine}): ${v.action.slice(0, 60)}...`);
      try {
        const videoRes = await generateClip(engine, char, v, keyframePath, sheetPaths, dur, klingModel);
        await downloadVideo(videoRes.url, videoPath);
        console.log(`      ✓ video → ${videoPath}`);
      } catch (err) {
        // Un engine che fallisce (moderazione, endpoint, saldo) non deve
        // uccidere il run dell'altro engine: logga e continua. I ValidationError
        // fal portano il dettaglio in body.detail, non in message.
        const detail = (err as { body?: { detail?: unknown } })?.body?.detail;
        const msg = err instanceof Error && err.message ? err.message : String(err);
        console.error(`      ❌ ${stem} fallito: ${msg}${detail ? ` — detail: ${JSON.stringify(detail)}` : ""}`);
        continue;
      }

      const frames = await extractMidLastFrames(videoPath, charDir, stem);
      console.log(`      ✓ frames mid (${(frames.durationSec * 0.5).toFixed(2)}s) + last (${(frames.durationSec - 0.15).toFixed(2)}s)`);

      let midVerdict: ConsistencyVerdict | null = null;
      let lastVerdict: ConsistencyVerdict | null = null;
      if (!skipVision) {
        // La vision Gemini ogni tanto risponde malformata (observed vuoto):
        // 1 retry, poi sample perso (null) — MAI buttare il character per
        // un check flaky quando le clip sono già state pagate e generate.
        const safeCompare = async (frame: string): Promise<ConsistencyVerdict | null> => {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              return await compareConsistency(keyframePath, frame, char.label);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (attempt === 0) {
                console.warn(`      ⚠️  vision flaky (${msg.slice(0, 80)}) — retry...`);
                await new Promise((r) => setTimeout(r, 3000));
              } else {
                console.warn(`      ⚠️  vision fallita anche al retry — sample perso`);
              }
            }
          }
          return null;
        };
        midVerdict = await safeCompare(frames.mid);
        lastVerdict = await safeCompare(frames.last);
        if (midVerdict || lastVerdict) {
          console.log(`      📊 mid overall ${midVerdict?.overall ?? "—"}/10 (${midVerdict?.verdict ?? "n/a"}) · last overall ${lastVerdict?.overall ?? "—"}/10 (${lastVerdict?.verdict ?? "n/a"})`);
        }
      }

      variations.push({
        index: idx,
        engine,
        action: v.action,
        videoPath,
        durationSec: frames.durationSec,
        midFrame: frames.mid,
        lastFrame: frames.last,
        midVerdict,
        lastVerdict,
      });
    }
  }

  const byEngine: Partial<Record<Engine, EngineResult>> = {};
  for (const engine of engines) {
    const engineVars = variations.filter((v) => v.engine === engine);
    const agg = aggregate(engineVars);
    byEngine[engine] = { aggregate: agg, verdict: characterVerdict(agg) };
  }

  await writeJson(join(charDir, "scores.json"), {
    character: char,
    sheetPaths,
    variations,
    byEngine,
  });

  return { character: char, keyframePath, sheetPaths, variations, byEngine };
}

function relPath(absPath: string, root: string): string {
  return absPath.startsWith(root + "/") ? absPath.slice(root.length + 1) : absPath;
}

function globalVerdict(results: CharacterResult[], engine: Engine): Verdict {
  const engineResults = results
    .map((r) => r.byEngine[engine])
    .filter((e): e is EngineResult => Boolean(e));
  if (engineResults.length === 0) return "not-viable";
  const viable = engineResults.filter((r) => r.verdict === "viable").length;
  const notViable = engineResults.filter((r) => r.verdict === "not-viable").length;
  if (notViable > 0) return "not-viable";
  if (viable / engineResults.length >= 0.8) return "viable";
  return "risky";
}

function verdictEmoji(v: string): string {
  if (v === "viable" || v === "match") return "✅";
  if (v === "risky" || v === "borderline") return "⚠️";
  return "❌";
}

function fmtDelta(d: number): string {
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(1)}`;
}

async function writeMarkdownReport(
  results: CharacterResult[],
  outRoot: string,
  cast: Cast,
  skipVision: boolean,
  engines: Engine[]
): Promise<void> {
  const lines: string[] = [];
  lines.push(`# Character Consistency Report — ${cast.name}\n`);
  lines.push(`> Generato: ${new Date().toISOString()}`);
  lines.push(`> Image model: \`${imageModelInUse()}\``);
  lines.push(`> Vision model: \`${skipVision ? "(skipped)" : consistencyModelInUse()}\``);
  for (const e of engines) {
    lines.push(`> Engine \`${e}\`: ${ENGINE_LABEL[e]} — \`${ENGINE_MODEL[e]}\``);
  }
  lines.push("");

  for (const e of engines) {
    const gv = globalVerdict(results, e);
    lines.push(`## Verdict ${e}: ${verdictEmoji(gv)} **${gv.toUpperCase()}**`);
  }
  lines.push("");
  lines.push(`- **viable** = avg overall ≥ 7.5 e drift rate ≤ 15% per ogni character, almeno 80% characters viable`);
  lines.push(`- **risky** = qualche borderline ma nessun drift bloccante`);
  lines.push(`- **not-viable** = almeno un character con drift rate >40% o overall <5 → concept non sostenibile\n`);

  if (!skipVision) {
    for (const e of engines) {
      lines.push(`## Tabella aggregata — ${e} (${ENGINE_LABEL[e]})\n`);
      lines.push(`| Character | Avg face | Avg hair | Avg outfit | Avg overall | Match% | Drift% | Verdict |`);
      lines.push(`|---|---|---|---|---|---|---|---|`);
      for (const r of results) {
        const er = r.byEngine[e];
        if (!er) continue;
        const a = er.aggregate;
        lines.push(
          `| ${r.character.label} | ${a.avgFacialIdentity.toFixed(1)} | ${a.avgHairStyle.toFixed(1)} | ${a.avgOutfit.toFixed(1)} | ${a.avgOverall.toFixed(1)} | ${(a.matchRate * 100).toFixed(0)}% | ${(a.driftRate * 100).toFixed(0)}% | ${verdictEmoji(er.verdict)} ${er.verdict} |`
        );
      }
      lines.push("");
    }

    if (engines.length === 2) {
      const [e1, e2] = engines;
      lines.push(`## Delta ${e2} − ${e1} (positivo = ${e2} migliore)\n`);
      lines.push(`| Character | Δ face | Δ hair | Δ outfit | Δ overall | Δ drift |`);
      lines.push(`|---|---|---|---|---|---|`);
      for (const r of results) {
        const a1 = r.byEngine[e1]?.aggregate;
        const a2 = r.byEngine[e2]?.aggregate;
        if (!a1 || !a2 || a1.sampleCount === 0 || a2.sampleCount === 0) continue;
        lines.push(
          `| ${r.character.label} | ${fmtDelta(a2.avgFacialIdentity - a1.avgFacialIdentity)} | ${fmtDelta(a2.avgHairStyle - a1.avgHairStyle)} | ${fmtDelta(a2.avgOutfit - a1.avgOutfit)} | ${fmtDelta(a2.avgOverall - a1.avgOverall)} | ${fmtDelta((a2.driftRate - a1.driftRate) * 100)}pt |`
        );
      }
      lines.push("");
    }
  }

  lines.push(`## Dettaglio per character\n`);
  for (const r of results) {
    lines.push(`### ${r.character.label} (\`${r.character.id}\`)\n`);
    lines.push(`Keyframe: [\`${relPath(r.keyframePath, outRoot)}\`](${relPath(r.keyframePath, outRoot)})`);
    if (r.sheetPaths.length) {
      lines.push(`Character sheet: ${r.sheetPaths.map((p) => `[\`${relPath(p, outRoot)}\`](${relPath(p, outRoot)})`).join(" · ")}`);
    }
    lines.push(`\nPrompt keyframe:\n\n> ${r.character.keyframePrompt.replace(/\n/g, " ")}\n`);
    if (!skipVision) {
      for (const e of engines) {
        const er = r.byEngine[e];
        if (!er) continue;
        lines.push(`Verdict ${e}: ${verdictEmoji(er.verdict)} **${er.verdict}** — overall ${er.aggregate.avgOverall.toFixed(1)}/10`);
      }
      lines.push("");
    }
    lines.push(`Variazioni:\n`);
    for (const v of r.variations) {
      lines.push(`- **var-${v.index} [${v.engine}]** (${v.durationSec.toFixed(1)}s) — _${v.action}_`);
      lines.push(`  - video: [\`${relPath(v.videoPath, outRoot)}\`](${relPath(v.videoPath, outRoot)})`);
      if (v.midVerdict && v.lastVerdict) {
        lines.push(`  - mid: ${verdictEmoji(v.midVerdict.verdict)} overall ${v.midVerdict.overall}/10 (face ${v.midVerdict.facialIdentity}, hair ${v.midVerdict.hairStyle}, outfit ${v.midVerdict.outfit}) — _${v.midVerdict.observed}_`);
        if (v.midVerdict.issues.length) lines.push(`    - issues: ${v.midVerdict.issues.join("; ")}`);
        lines.push(`  - last: ${verdictEmoji(v.lastVerdict.verdict)} overall ${v.lastVerdict.overall}/10 (face ${v.lastVerdict.facialIdentity}, hair ${v.lastVerdict.hairStyle}, outfit ${v.lastVerdict.outfit}) — _${v.lastVerdict.observed}_`);
        if (v.lastVerdict.issues.length) lines.push(`    - issues: ${v.lastVerdict.issues.join("; ")}`);
      }
    }
    lines.push("");
  }

  await writeFile(join(outRoot, "report.md"), lines.join("\n"), "utf-8");
}

async function writeHtmlReport(
  results: CharacterResult[],
  outRoot: string,
  cast: Cast,
  engines: Engine[]
): Promise<void> {
  const scoreBlock = (label: string, vd: ConsistencyVerdict | null) => {
    if (!vd) return `<div class="score">${label}: skipped</div>`;
    const cls = vd.verdict === "match" ? "ok" : vd.verdict === "borderline" ? "warn" : "bad";
    return `<div class="score ${cls}"><b>${label}</b> · overall ${vd.overall}/10 (${vd.verdict}) · face ${vd.facialIdentity} · hair ${vd.hairStyle} · outfit ${vd.outfit}<br><small>${vd.observed}</small></div>`;
  };

  const cards = results.map((r) => {
    const indices = [...new Set(r.variations.map((v) => v.index))].sort((a, b) => a - b);
    const variationCards = indices.map((idx) => {
      const perEngine = engines
        .map((e) => r.variations.find((v) => v.index === idx && v.engine === e))
        .filter((v): v is VariationResult => Boolean(v));
      if (perEngine.length === 0) return "";
      const action = perEngine[0].action;
      const engineCols = perEngine.map((v) => `
            <div class="engine-col">
              <h5>${v.engine} — ${ENGINE_LABEL[v.engine]}</h5>
              <div class="frames">
                <figure><img src="${relPath(v.midFrame, outRoot)}" /><figcaption>mid (${(v.durationSec * 0.5).toFixed(1)}s)</figcaption></figure>
                <figure><img src="${relPath(v.lastFrame, outRoot)}" /><figcaption>last (${(v.durationSec - 0.15).toFixed(1)}s)</figcaption></figure>
              </div>
              ${scoreBlock("mid", v.midVerdict)}
              ${scoreBlock("last", v.lastVerdict)}
              <video src="${relPath(v.videoPath, outRoot)}" controls preload="metadata"></video>
            </div>`).join("\n");
      return `
        <div class="var">
          <h4>var-${idx} — ${action}</h4>
          <div class="ref-row">
            <figure><img src="${relPath(r.keyframePath, outRoot)}" /><figcaption>reference</figcaption></figure>
            ${r.sheetPaths.map((p, i) => `<figure><img src="${relPath(p, outRoot)}" /><figcaption>sheet ${SHEET_VIEWS[i]?.suffix ?? i + 1}</figcaption></figure>`).join("\n")}
          </div>
          <div class="engine-grid cols-${perEngine.length}">
            ${engineCols}
          </div>
        </div>`;
    }).join("\n");

    const badges = engines.map((e) => {
      const er = r.byEngine[e];
      if (!er) return "";
      const cls = er.verdict === "viable" ? "ok" : er.verdict === "risky" ? "warn" : "bad";
      return `<span class="badge ${cls}">${e}: ${er.verdict}</span>`;
    }).join(" ");

    const aggLines = engines.map((e) => {
      const a = r.byEngine[e]?.aggregate;
      if (!a || a.sampleCount === 0) return "";
      return `<p class="agg"><b>${e}</b> · face <b>${a.avgFacialIdentity.toFixed(1)}</b> · hair <b>${a.avgHairStyle.toFixed(1)}</b> · outfit <b>${a.avgOutfit.toFixed(1)}</b> · overall <b>${a.avgOverall.toFixed(1)}</b> · drift rate <b>${(a.driftRate * 100).toFixed(0)}%</b></p>`;
    }).join("\n");

    return `
      <section class="char">
        <h2>${r.character.label} ${badges}</h2>
        <p class="prompt">${r.character.keyframePrompt}</p>
        ${aggLines}
        ${variationCards}
      </section>`;
  }).join("\n");

  const globalBanner = engines.map((e) => {
    const gv = globalVerdict(results, e);
    const cls = gv === "viable" ? "ok" : gv === "risky" ? "warn" : "bad";
    return `<div class="verdict-global ${cls}">${e} (${ENGINE_LABEL[e]}): <b>${gv.toUpperCase()}</b></div>`;
  }).join("\n");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Consistency Test — ${cast.name}</title>
<style>
  body{font-family:-apple-system,sans-serif;margin:0;padding:24px;background:#0e1116;color:#e8e1d2;max-width:1300px;margin:auto}
  h1{margin-top:0}
  .badge{display:inline-block;padding:4px 10px;border-radius:6px;font-size:13px;font-weight:600;text-transform:uppercase;margin-left:6px}
  .ok{background:#1b5e20;color:#c8e6c9}
  .warn{background:#7a5c00;color:#fff3b0}
  .bad{background:#7a1f1f;color:#ffd1d1}
  .verdict-global{font-size:18px;padding:14px;border-radius:8px;margin:12px 0}
  .verdict-global.ok{background:#0f3a13}
  .verdict-global.warn{background:#3a2c00}
  .verdict-global.bad{background:#3a0e0e}
  .char{margin:32px 0;padding:20px;background:#1b2434;border-radius:10px}
  .prompt{font-size:13px;color:#9aa3b2;font-style:italic}
  .agg{font-size:14px;color:#c9a36b;margin:4px 0}
  .var{margin:24px 0;padding:16px;background:#0e1116;border-radius:8px}
  .ref-row{display:flex;gap:8px;margin:12px 0}
  .ref-row figure{margin:0;max-width:140px}
  .ref-row img{width:100%;height:auto;border-radius:4px;display:block;border:1px solid #2a3548}
  .ref-row figcaption{font-size:11px;color:#9aa3b2;text-align:center;margin-top:4px}
  .engine-grid{display:grid;gap:16px}
  .engine-grid.cols-1{grid-template-columns:1fr}
  .engine-grid.cols-2{grid-template-columns:1fr 1fr}
  .engine-col{padding:12px;background:#141b27;border-radius:8px}
  .engine-col h5{margin:0 0 8px;color:#c9a36b;font-size:13px}
  .frames{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:12px 0}
  .frames figure{margin:0}
  .frames img{width:100%;height:auto;border-radius:4px;display:block}
  .frames figcaption{font-size:11px;color:#9aa3b2;text-align:center;margin-top:4px}
  .score{padding:8px 12px;border-radius:6px;margin:6px 0;background:#1b2434;font-size:13px}
  .score.ok{background:#0f3a13}
  .score.warn{background:#3a2c00}
  .score.bad{background:#3a0e0e}
  .score small{display:block;margin-top:4px;color:#9aa3b2;font-size:12px}
  video{width:100%;max-width:360px;display:block;margin-top:12px;border-radius:6px}
</style></head><body>
<h1>Consistency Test — ${cast.name}</h1>
<p>Image: <code>${imageModelInUse()}</code> · Vision: <code>${consistencyModelInUse()}</code></p>
<p>${engines.map((e) => `<code>${e}</code> = ${ENGINE_MODEL[e]}`).join(" · ")}</p>
${globalBanner}
${cards}
</body></html>`;

  await writeFile(join(outRoot, "report.html"), html, "utf-8");
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const raw = await readJson<unknown>(opts.castPath);
  const cast = CastSchema.parse(raw);
  const outRoot = opts.outDir ?? defaultOutDir();
  await ensureDir(outRoot);

  const filteredChars = opts.chars
    ? cast.characters.filter((c) => opts.chars!.includes(c.id))
    : cast.characters;
  if (filteredChars.length === 0) {
    console.error(`Nessun character matcha --chars=${opts.chars?.join(",")}`);
    process.exit(1);
  }

  const estCost = estimateCost(filteredChars, opts.variations, opts.engines, opts.skipVision);

  console.log(`\n🎭 Consistency test — ${cast.name}`);
  console.log(`   Cast: ${filteredChars.length} character(s)`);
  console.log(`   Variations: ${opts.variations ?? "all"} per character`);
  console.log(`   Engines: ${opts.engines.join(" vs ")}`);
  console.log(`   Vision audit: ${opts.skipVision ? "SKIPPED" : "enabled"}`);
  console.log(`   💰 Stima costo run: ~$${estCost.toFixed(2)}`);
  console.log(`   Out: ${outRoot}\n`);

  await copyFile(opts.castPath, join(outRoot, "cast.json"));

  const results: CharacterResult[] = [];
  for (const c of filteredChars) {
    try {
      const r = await runCharacter(c, outRoot, opts.variations, opts.duration, opts.klingModel, opts.skipVision, opts.engines);
      results.push(r);
    } catch (err) {
      console.error(`\n❌ [${c.id}] errore:`, err instanceof Error ? err.message : err);
    }
  }

  await writeMarkdownReport(results, outRoot, cast, opts.skipVision, opts.engines);
  await writeHtmlReport(results, outRoot, cast, opts.engines);

  console.log(`\n\n========================================`);
  for (const e of opts.engines) {
    const gv = globalVerdict(results, e);
    console.log(`🎯 Verdict ${e}: ${gv.toUpperCase()}`);
    if (!opts.skipVision) {
      const engineAggs = results.map((r) => r.byEngine[e]?.aggregate).filter((a): a is Aggregate => Boolean(a) && a!.sampleCount > 0);
      if (engineAggs.length > 0) {
        const allOverall = engineAggs.reduce((s, a) => s + a.avgOverall, 0) / engineAggs.length;
        console.log(`   Avg overall: ${allOverall.toFixed(1)}/10`);
      }
    }
  }
  console.log(`   ${results.length} characters analizzati`);
  console.log(`\n📄 Report: ${join(outRoot, "report.md")}`);
  console.log(`🌐 Gallery: ${join(outRoot, "report.html")}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
