import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

async function ffprobeDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);
    let out = "";
    p.stdout.on("data", (c) => (out += c.toString()));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}`));
      const n = parseFloat(out.trim());
      if (Number.isNaN(n)) return reject(new Error(`ffprobe bad duration: ${out}`));
      resolve(n);
    });
    p.on("error", reject);
  });
}

async function ffmpegFrame(videoPath: string, atSec: number, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-y",
      "-ss", atSec.toFixed(3),
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "2",
      outPath,
    ]);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
    p.on("error", reject);
  });
}

/** Estrae un singolo frame a `atSec` da un video in `outPath` (PNG). */
export async function extractFrameAt(
  videoPath: string,
  atSec: number,
  outPath: string
): Promise<void> {
  await ffmpegFrame(videoPath, atSec, outPath);
}

/** ffprobe della durata di un video (secondi). Esportato per i tool di refresh. */
export async function probeDuration(videoPath: string): Promise<number> {
  return ffprobeDuration(videoPath);
}

export interface ExtractedFrames {
  mid: string;
  last: string;
  durationSec: number;
}

export async function extractMidLastFrames(
  videoPath: string,
  outDir: string,
  basename: string
): Promise<ExtractedFrames> {
  await stat(videoPath);
  const dur = await ffprobeDuration(videoPath);
  const midSec = dur * 0.5;
  const lastSec = Math.max(0, dur - 0.15);

  const mid = `${outDir}/${basename}-mid.png`;
  const last = `${outDir}/${basename}-last.png`;

  await ffmpegFrame(videoPath, midSec, mid);
  await ffmpegFrame(videoPath, lastSec, last);

  return { mid, last, durationSec: dur };
}

export async function downloadVideo(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outPath, buf);
}
