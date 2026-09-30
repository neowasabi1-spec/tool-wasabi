import { config } from "dotenv";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
// Carica .env del reel-engine via path assoluto → funziona da qualsiasi CWD
// (gli agenti del workflow non girano necessariamente in reel-engine/).
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import { generateKeyframe } from "../src/services/gemini-image.js";

// Helper: genera un singolo keyframe Gemini da prompt → outputPath.
// Uso:  npx tsx scripts/gen-variant.ts "<visualPrompt>" "/path/out.png" [--ref=<img>]... [--no-anchor]
//   --ref=<path>   immagine di riferimento (style/character anchor). RIPETIBILE: passa più --ref=
//                  per scene multi-personaggio (es. --ref=luca.png --ref=michel.png).
//   --no-anchor    disattiva lo STYLE_ANCHOR di default (photoreal iPhone) — necessario per stili
//                  non-fotoreali (es. claymation/3D) in cui l'anchor lavorerebbe contro il prompt
function mimeFromExt(p: string): "image/png" | "image/jpeg" | "image/webp" {
  const e = extname(p).toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".webp") return "image/webp";
  return "image/jpeg";
}

async function main() {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  const refPaths: string[] = [];
  let appendStyleAnchor = true;

  for (const a of argv) {
    if (a === "--no-anchor") appendStyleAnchor = false;
    else if (a.startsWith("--ref=")) refPaths.push(a.slice(6));
    else if (!a.startsWith("--")) positional.push(a);
  }

  const [prompt, outputPath] = positional;
  if (!prompt || !outputPath) {
    console.error('usage: tsx scripts/gen-variant.ts "<prompt>" "<outputPath>" [--ref=<img>]... [--no-anchor]');
    process.exit(1);
  }

  const referenceImages = await Promise.all(
    refPaths.map(async (p) => ({ buffer: await readFile(p), mimeType: mimeFromExt(p) }))
  );
  await generateKeyframe(prompt, {
    outputPath,
    appendStyleAnchor,
    ...(referenceImages.length ? { referenceImages } : {}),
  });
  console.log("GEN OK", outputPath, refPaths.length ? `(refs: ${refPaths.join(", ")})` : "", appendStyleAnchor ? "" : "(no-anchor)");
}

main().catch((e) => {
  console.error("GEN FAIL:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
