import "dotenv/config";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { runPipeline } from "../src/pipeline.js";
import { generateSceneMap } from "./scene-map.js";

// Auto-open di un file binario al termine della pipeline.
// OPT-IN dal 2026-06-10: si attiva solo con --auto-open. Di default la CLI
// stampa il comando `open "<path>"` pronto da copiare nel terminale.
//
// Forziamo QuickTime Player (anche per .mp3) perché Apple Music è il
// default macOS per .mp3 ma non riproduce file fuori dalla sua libreria
// — si apre vuoto. QuickTime gestisce sia audio che video nativamente.
// Solo macOS: su Linux/Windows è sempre un no-op.
function autoOpen(path: string, label: string): void {
  if (!existsSync(path)) {
    console.warn(`   ⚠️  Auto-open ${label} skipped — file non trovato: ${path}`);
    return;
  }
  if (process.platform !== "darwin") {
    // Linux/Windows: log only, no auto-open
    return;
  }
  console.log(`   🎬 Auto-open ${label} (QuickTime Player): ${path}`);
  execFile("open", ["-a", "QuickTime Player", path], (err) => {
    if (err) console.warn(`   ⚠️  Auto-open fallito: ${err.message}`);
  });
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
//
// Usage:
//
//   pnpm reel <script.json>                          → full pipeline (audio + video)
//   pnpm reel <script.json> --audio-only             → solo voiceover (cheap iter)
//   pnpm reel <script.json> --video-only --from <reel-dir>
//                                                    → solo video, riusa l'audio
//                                                       approvato da <reel-dir>
//
// Workflow audio-first raccomandato:
//   1. Itera l'audio: edit script.json + `pnpm reel <script.json> --audio-only`
//      ad ogni iterazione. Costo basso (solo ElevenLabs).
//   2. Quando l'audio è approvato, ricorda la cartella reel-NNNN del run audio
//      che ti convince.
//   3. Genera il video sopra l'audio approvato:
//      `pnpm reel <script.json> --video-only --from <path/to/reel-NNNN>`
//      Il video viene scritto nella stessa cartella, sovrascrivendo eventuali
//      clip parziali.
//
// Flag legacy (ancora supportati per backward compat):
//   --skip-voiceover  alias di --video-only (richiede --from per riusare audio)
//   --skip-visuals    alias di --audio-only
// ----------------------------------------------------------------------------

const args = process.argv.slice(2);

const HELP = `\nUso: pnpm reel <path-to-script.json> [opzioni]

Opzioni:
  --audio-only              Genera solo l'audio (Stage 1). Skippa Kling.
                            ⚠️ Con --from DIR RIUSA l'audio esistente di DIR (non lo rigenera).
                            Per rigenerare l'audio nella stessa cartella usa --out DIR.
  --video-only --from DIR   Genera solo il video, riusa l'audio approvato da DIR.
  --from DIR                Riusa audio + word-timestamps esistenti in DIR (e scrive lì).
  --out DIR                 Output dir esplicita, NESSUN riuso audio (rigenera tutto lì).
  --sync-only --from DIR    Ricalcola solo sync VO↔scene + composition props. Zero API call.
  --skip-existing-videos    Stage 2 rigenera solo le scene senza clip (resume dopo errori).
  --skip-voiceover          Alias legacy di --video-only.
  --skip-visuals            Alias legacy di --audio-only.
  --skip-enhance            Salta l'enhancer automatico Audio Tags v3 (usa quando hai già scritto i tag inline nel voiceoverText).
  --lipsync                 Stage 2.5: fal-ai/sync-lipsync sulle scene con voiceoverSegment.
  --omnihuman               Stage 2.5b: OmniHuman v1.5 audio-driven (lipsync musi non-umani).
  --vision                  In coda alla pipeline, lancia scene-map con vision (Gemini 3.1 Pro su 2 frame per clip vs visualPrompt). Costo ~$0.40-0.80/reel.
  --bypass-keyframe-gate    Stage 2 procede anche se ci sono keyframe non approvati (sconsigliato: spende crediti su keyframe non validati).
  --allow-oversized         Procedi anche con scene il cui audio supera 10s (sconsigliato: il clip Kling max 10s freezerà in render — default = blocco con istruzioni di split).
  --auto-open               Apri voiceover.mp3 / final.mp4 in QuickTime al termine (solo macOS; default OFF, viene stampato il comando open da copiare).
  -h, --help                Mostra questo aiuto.

Workflow standard (4 gate — vedi reel-engine/CLAUDE.md):
  1) pnpm reel script.json --audio-only                          (voiceover → GATE 3 voce)
  2) pnpm storyboard script.json --from <reel-dir>               (keyframe Gemini → GATE 4)
  3) approva i keyframe: apri <reel-dir>/keyframes.html
       macOS/Linux:  touch <reel-dir>/assets/keyframes/scene-N.png.approved
       Windows PS:   New-Item <reel-dir>/assets/keyframes/scene-N.png.approved
  4) pnpm reel script.json --video-only --from <reel-dir>        (Stage 2 image-to-video, irreversibile)
  5) pnpm scene-map <reel-dir>                                   (review L1 gratis)

Workflow audio-first raccomandato:
  1) pnpm reel script.json --audio-only         (cheap iteration ~$0.30)
  2) ascolta reel-NNNN/assets/voiceover.mp3, decidi
  3) pnpm reel script.json --video-only --from /path/to/reel-NNNN
`;

if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
  console.error(HELP);
  process.exit(args.length === 0 ? 1 : 0);
}

// Estrai il primo arg posizionale (script path) — ignorando i flag
const scriptPath = args.find((a) => !a.startsWith("--") && !a.startsWith("-"));
if (!scriptPath) {
  console.error("❌ Manca il path al file script.json");
  console.error(HELP);
  process.exit(1);
}

// Estrai --from <path>
let audioFromDir: string | undefined;
const fromIdx = args.indexOf("--from");
if (fromIdx !== -1) {
  const next = args[fromIdx + 1];
  if (!next || next.startsWith("--")) {
    console.error("❌ --from richiede un path. Esempio: --from /path/to/reel-NNNN");
    process.exit(1);
  }
  audioFromDir = next;
}

// Estrai --out <path> (output dir esplicito, no reuse audio)
let outputDirArg: string | undefined;
const outIdx = args.indexOf("--out");
if (outIdx !== -1) {
  const next = args[outIdx + 1];
  if (!next || next.startsWith("--")) {
    console.error("❌ --out richiede un path.");
    process.exit(1);
  }
  outputDirArg = next;
}

const audioOnly = args.includes("--audio-only") || args.includes("--skip-visuals");
const videoOnly = args.includes("--video-only") || args.includes("--skip-voiceover");
const syncOnly = args.includes("--sync-only");
const lipsync = args.includes("--lipsync");
const omnihuman = args.includes("--omnihuman");
const skipExistingVideos = args.includes("--skip-existing-videos");
const skipEnhance = args.includes("--skip-enhance");
const vision = args.includes("--vision");
const bypassKeyframeGate = args.includes("--bypass-keyframe-gate");
const allowOversized = args.includes("--allow-oversized");
// Auto-open OPT-IN dal 2026-06-10 (prima era default ON con --no-auto-open).
// --no-auto-open resta accettato per retrocompat (è già il comportamento di default).
const autoOpenEnabled = args.includes("--auto-open");

// --sync-only = ricalcola solo il sync VO↔scene + composition props.
// Implementato come (skipVoiceover + skipVisuals): nessuna API call.
const effectiveSkipVoiceover = videoOnly || syncOnly;
const effectiveSkipVisuals = audioOnly || syncOnly;

if (audioOnly && videoOnly) {
  console.error(
    "❌ Non combinare --audio-only e --video-only. Per ricalcolare solo il sync usa --sync-only --from <reel-dir>."
  );
  process.exit(1);
}

if ((videoOnly || syncOnly) && !audioFromDir) {
  console.error(
    `❌ ${syncOnly ? "--sync-only" : "--video-only"} richiede --from <reel-dir> per leggere l'audio esistente.`
  );
  console.error(
    '   Esempio: pnpm reel script.json --sync-only --from "/Users/.../reel-NNNN"'
  );
  process.exit(1);
}

console.log(`\n🎬 Reel Engine — Avvio pipeline`);
console.log(`   Script: ${scriptPath}`);
if (syncOnly) console.log(`   Mode:   SYNC ONLY (skip voiceover + visuals, ricalcola solo sync)`);
else if (audioOnly) console.log(`   Mode:   AUDIO ONLY (skip video Kling)`);
else if (videoOnly) console.log(`   Mode:   VIDEO ONLY (skip voiceover)`);
if (audioFromDir) console.log(`   Reuse audio from: ${audioFromDir}`);
if (skipExistingVideos) console.log(`   Skip existing videos: ON (rigenera solo le scene mancanti)`);
if (skipEnhance) console.log(`   Skip enhance: ON (usa voiceoverText as-is, nessun tag v3 aggiunto)`);
if (lipsync) console.log(`   Lipsync: ON (fal-ai/sync-lipsync su ogni scena)`);
if (omnihuman) console.log(`   OmniHuman v1.5: ON (audio-driven regeneration su ogni scena)`);
if (vision) console.log(`   Vision: ON (Gemini 3.1 Pro adherence check in scene-map)`);
console.log();

runPipeline({
  scriptPath,
  outputDir: outputDirArg,
  skipVoiceover: effectiveSkipVoiceover,
  skipVisuals: effectiveSkipVisuals,
  audioFromDir,
  skipExistingVideos,
  skipEnhance,
  lipsync,
  omnihuman,
  bypassKeyframeGate,
  allowOversized,
})
  .then(async (result) => {
    console.log("🎉 Fatto! File pronti in:", result.outputDir);

    // Scene map: skip in audio-only (mancano i clip video).
    // Failure non bloccante: il reel è già pronto, la scene map è un nice-to-have.
    if (!audioOnly) {
      try {
        await generateSceneMap(result.outputDir, { vision });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`\n⚠️  Scene map non generata (${msg}). Il reel è comunque pronto.`);
        console.warn(`   Puoi rilanciarla manualmente: pnpm scene-map "${result.outputDir}"${vision ? " --vision" : ""}`);
      }
    }

    if (audioOnly) {
      console.log("\n   👂 Per ascoltare l'audio:");
      console.log(`      open "${result.outputDir}/assets/voiceover.mp3"`);
      console.log("\n   ✅ Quando l'audio è approvato, genera il video con:");
      console.log(
        `      pnpm reel ${scriptPath} --video-only --from "${result.outputDir}"`
      );
      if (autoOpenEnabled) autoOpen(`${result.outputDir}/assets/voiceover.mp3`, "voiceover");
    } else {
      // Pipeline completa o --video-only: comando pronto da copiare nel terminale
      console.log(`\n   ▶️  Per vedere il reel:`);
      console.log(`      open "${result.outputDir}/final.mp4"`);
      if (autoOpenEnabled) autoOpen(`${result.outputDir}/final.mp4`, "final.mp4");
    }
  })
  .catch((err) => {
    console.error("❌ Errore nella pipeline:", err.message);
    process.exit(1);
  });
