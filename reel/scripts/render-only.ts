import "dotenv/config";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readJson, hashContent } from "../src/utils/file-io.js";
import { recalcProps } from "./recalc-props.js";

const reelDir = process.argv[2];

if (!reelDir) {
  console.error("Uso: pnpm render <path-to-reel-dir>");
  console.error("Es:  pnpm render output/2026-03-30/reel-1234");
  process.exit(1);
}

const resolvedDir = resolve(reelDir);
const projectRoot = resolve(
  decodeURIComponent(new URL("..", import.meta.url).pathname)
);

/** Start a local HTTP server to serve reel assets */
function startAssetServer(assetsBaseDir: string): Promise<{ url: string; close: () => void }> {
  return new Promise((res) => {
    const server = createServer((req, reply) => {
      const filePath = join(assetsBaseDir, decodeURIComponent(req.url ?? ""));
      if (!existsSync(filePath)) {
        reply.writeHead(404);
        reply.end("Not found");
        return;
      }
      const ext = filePath.split(".").pop();
      const contentType: Record<string, string> = {
        mp3: "audio/mpeg",
        wav: "audio/wav",
        png: "image/png",
        jpg: "image/jpeg",
        mp4: "video/mp4",
      };
      reply.writeHead(200, { "Content-Type": contentType[ext ?? ""] ?? "application/octet-stream" });
      createReadStream(filePath).pipe(reply);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

interface RenderConfig {
  compositionId: string;
  props: Record<string, unknown>;
  durationInFrames: number;
  scriptHash?: string;
}

async function render() {
  const propsPath = join(resolvedDir, "composition-props.json");
  let config = await readJson<RenderConfig>(propsPath);

  // Hash-guard (dal 2026-06-10): se script.json è stato modificato dopo
  // l'ultimo calcolo dei props, ricalcola in automatico — elimina il gotcha
  // "pnpm render usa i props cached" dopo un edit manuale dello script.
  const scriptPath = join(resolvedDir, "script.json");
  if (existsSync(scriptPath)) {
    if (config.scriptHash) {
      const currentHash = hashContent(await readFile(scriptPath, "utf-8"));
      if (currentHash !== config.scriptHash) {
        console.log(
          "\n♻️  script.json modificato dopo l'ultimo calcolo dei props → ricalcolo automatico (recalc-props)..."
        );
        await recalcProps(resolvedDir);
        config = await readJson<RenderConfig>(propsPath);
      }
    } else {
      console.log(
        "\nℹ️  composition-props.json senza scriptHash (generato prima del 2026-06-10): " +
          "salto il check di coerenza. Se hai modificato script.json a mano, lancia prima `pnpm recalc-props`."
      );
    }
  }

  console.log(`\n🎬 Rendering ${config.compositionId}...`);
  console.log(`   Durata: ${(config.durationInFrames / 30).toFixed(1)}s`);

  // Start local asset server
  const assetServer = await startAssetServer(resolvedDir);
  console.log(`   🌐 Asset server: ${assetServer.url}`);

  // Rewrite local asset paths to use the asset server
  const props = JSON.parse(
    JSON.stringify(config.props).replace(
      /(?<=")(assets\/[^"]+)(?=")/g,
      `${assetServer.url}/$1`
    )
  );

  try {
    const entryPoint = join(projectRoot, "remotion/index.ts");

    console.log("   📦 Bundling...");
    const bundled = await bundle({ entryPoint });

    const composition = await selectComposition({
      serveUrl: bundled,
      id: config.compositionId,
      inputProps: props,
    });

    composition.durationInFrames = config.durationInFrames;

    const outputPath = join(resolvedDir, "final.mp4");

    console.log("   🎥 Rendering...");
    await renderMedia({
      composition,
      serveUrl: bundled,
      codec: "h264",
      outputLocation: outputPath,
      inputProps: props,
      // Frame intermedi in PNG (lossless) invece del default JPEG q80: il JPEG
      // sui frame intermedi produceva blocchi DCT 8x8 sulle lettere dei
      // sottotitoli (testo bianco ad alto contrasto su sfondo in movimento) →
      // "quadratini nelle lettere" (bocciato Michel 2026-06-07). PNG li elimina.
      imageFormat: "png",
      // crf più basso del default (18) per un encode finale più nitido sul testo.
      crf: 16,
      // Aumentato da default 30s a 120s per dare margine a clip Kling complessi
      // (default fallisce su scene con OffthreadVideo pesanti). Vedi incident 2026-05-25.
      timeoutInMilliseconds: 120000,
    });

    console.log(`\n✅ Video renderizzato: ${outputPath}\n`);
  } finally {
    assetServer.close();
  }
}

render().catch((err) => {
  console.error("❌ Errore nel rendering:", err.message);
  process.exit(1);
});
