import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

/**
 * Cover burned-in subtitles with a solid band and burn new lines.
 * Run on the reel server (the machine that already renders Remotion):
 *   pnpm cover-subs --input clip.mp4 --output pulito.mp4 --captions captions.json
 *
 * captions.json: [{ "text": "...", "startSec": 0, "endSec": 1.4 }, ...]
 * Optional: --top 0.72 --height 0.22
 */

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : "";
};

const input = resolve(flag("--input"));
const output = resolve(flag("--output"));
const captionsPath = flag("--captions");
const top = Number(flag("--top") || "0.72");
const height = Number(flag("--height") || "0.22");

if (!input || !output || !existsSync(input)) {
  console.error("Uso: pnpm cover-subs --input clip.mp4 --output pulito.mp4 [--captions file.json] [--top 0.72] [--height 0.22]");
  process.exit(1);
}

function probe(file: string): Promise<{ w: number; h: number; dur: number }> {
  return new Promise((res, rej) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height:format=duration",
      "-of", "json",
      file,
    ]);
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", (code) => {
      if (code !== 0) return rej(new Error("ffprobe failed"));
      const j = JSON.parse(out) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
      res({
        w: j.streams?.[0]?.width || 1080,
        h: j.streams?.[0]?.height || 1920,
        dur: Number(j.format?.duration || 0),
      });
    });
  });
}

const projectRoot = resolve(decodeURIComponent(new URL("..", import.meta.url).pathname));

const server = createServer((req, reply) => {
  const url = decodeURIComponent((req.url || "").split("?")[0]);
  if (url !== "/video.mp4") {
    reply.writeHead(404);
    reply.end();
    return;
  }
  reply.writeHead(200, { "Content-Type": "video/mp4" });
  createReadStream(input).pipe(reply);
});

await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;

try {
  const meta = await probe(input);
  const fps = 30;
  const durationInFrames = Math.max(1, Math.round(meta.dur * fps));
  let captions: Array<{ text: string; startSec: number; endSec: number }> = [];
  if (captionsPath && existsSync(resolve(captionsPath))) {
    captions = JSON.parse(await (await import("node:fs/promises")).readFile(resolve(captionsPath), "utf8"));
  }
  const props = {
    videoUrl: `http://127.0.0.1:${port}/video.mp4`,
    bands: [{ top, height, color: "#111111" }],
    captions: captions.map((c) => ({
      text: c.text,
      startFrame: Math.round(c.startSec * fps),
      endFrame: Math.round(c.endSec * fps),
    })),
  };

  const bundled = await bundle({ entryPoint: join(projectRoot, "remotion/index.ts") });
  const composition = await selectComposition({ serveUrl: bundled, id: "CoverSubs", inputProps: props });
  composition.durationInFrames = durationInFrames;
  composition.width = meta.w;
  composition.height = meta.h;
  composition.fps = fps;

  await renderMedia({
    composition,
    serveUrl: bundled,
    codec: "h264",
    outputLocation: output,
    inputProps: props,
    imageFormat: "png",
    crf: 18,
  });
  console.log(output);
} finally {
  server.close();
}
