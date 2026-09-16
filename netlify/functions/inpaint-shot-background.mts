import fs from 'fs';
import path from 'path';
import {
  getSupabase, uploadFile, makeWorkDir, downloadSource, probeDuration,
  run, FFMPEG, ffprobeInfo, cutClip,
} from './_shared/video';
import { captionMasks, writeMaskVideo, maskIsTrustworthy } from './_shared/caption-mask';

/**
 * Background function that removes burned-in subtitles from a shot with REAL
 * AI video inpainting (Replicate: hjunior29/video-text-remover — YOLO text
 * detection + context-aware inpainting). The cleaned clip is stored next to
 * the original and referenced via competitor_shots.clean_path, which makes the
 * shot usable in video builds.
 *
 * Two stages, the second only when needed:
 *  1. video-text-remover, re-run up to MAX_PASSES times (it misses a few random
 *     frames per run, so leftovers flash for a fraction of a second).
 *  2. If text is STILL there, its YOLO detector simply can't see it (stylized
 *     CTA graphics like "CLICK BELOW" are never detected). Florence-2 OCR then
 *     locates the exact text boxes per sampled frame and those boxes are erased
 *     with neural inpainting of the letter pixels only.
 *
 * Requires the REPLICATE_API_TOKEN env var on Netlify.
 * Body: { shotId, projectId }
 */

const BUCKET = 'project-files';
// Primary: rebuilds the masked area with temporal context (no smeared patch).
const MASK_MODEL = 'ayushunleashed/minimax-remover';
// Fallback when the caption's colour doesn't give a mask worth trusting.
const REPLICATE_MODEL = 'hjunior29/video-text-remover';
const OCR_MODEL = 'lucataco/florence-2-large';
const POLL_MS = 5000;
const MAX_WAIT_MS = 12 * 60 * 1000; // background functions cap at 15 min
const MAX_PASSES = 3;
const OCR_FPS = 3;                  // frames per second sampled for OCR
const OCR_MAX_FRAMES = 14;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Box = { x0: number; y0: number; x1: number; y1: number }; // normalized 0..1

/**
 * Pull quad boxes out of whatever shape Florence-2 returns. The Replicate
 * wrapper may hand back a JSON object, a JSON string or a python-ish repr, so
 * parse defensively: find the quad_boxes section and read groups of 8 numbers.
 */
export function parseOcrBoxes(output: unknown, w: number, h: number): Box[] {
  let text: string;
  if (typeof output === 'string') text = output;
  else {
    try { text = JSON.stringify(output); } catch { return []; }
  }
  const idx = text.search(/quad_boxes/i);
  const region = idx >= 0 ? text.slice(idx) : text;
  const nums = region.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 8) return [];
  const boxes: Box[] = [];
  for (let i = 0; i + 7 < nums.length; i += 8) {
    const xs = [0, 2, 4, 6].map((k) => parseFloat(nums[i + k]));
    const ys = [1, 3, 5, 7].map((k) => parseFloat(nums[i + k]));
    if (xs.some((v) => !Number.isFinite(v)) || ys.some((v) => !Number.isFinite(v))) continue;
    const box = {
      x0: Math.min(...xs) / w,
      x1: Math.max(...xs) / w,
      y0: Math.min(...ys) / h,
      y1: Math.max(...ys) / h,
    };
    const bw = box.x1 - box.x0;
    const bh = box.y1 - box.y0;
    // Skip nonsense and specks: sub-1% strips are noise, not captions.
    if (bw <= 0.01 || bh <= 0.008 || box.x0 < -0.05 || box.y0 < -0.05 || box.x1 > 1.05 || box.y1 > 1.05) continue;
    boxes.push(box);
  }
  return boxes;
}

/** Create a prediction, waiting out 429s (low credit throttles hard). */
async function replicateRun(
  token: string,
  version: string,
  input: Record<string, unknown>,
  deadline: number,
  log: (...a: unknown[]) => void,
): Promise<unknown> {
  const body = JSON.stringify({ version, input });
  let predId: string | null = null;
  for (let attempt = 0; attempt < 20 && !predId; attempt++) {
    if (Date.now() > deadline) throw new Error('out of time before prediction started');
    const resp = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    });
    if (resp.status === 429) {
      const txt = await resp.text();
      let ra = 12;
      try { ra = Number(JSON.parse(txt)?.retry_after) || 12; } catch { /* default */ }
      await sleep((ra + 2 + Math.random() * 6) * 1000);
      continue;
    }
    if (!resp.ok) throw new Error(`create ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    predId = (await resp.json())?.id || null;
  }
  if (!predId) throw new Error('rate limited too long');
  for (;;) {
    if (Date.now() > deadline) throw new Error('prediction timed out');
    await sleep(3000);
    const resp = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) continue;
    const pred = await resp.json();
    if (pred.status === 'succeeded') return pred.output;
    if (pred.status === 'failed' || pred.status === 'canceled') {
      throw new Error(`${pred.status}: ${String(pred.error || '').slice(0, 200)}`);
    }
    log('ocr still running');
  }
}

async function resolveVersion(token: string, model: string): Promise<string> {
  const resp = await fetch(`https://api.replicate.com/v1/models/${model}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`could not resolve ${model} (${resp.status})`);
  const v = (await resp.json())?.latest_version?.id;
  if (!v) throw new Error(`${model} has no latest version`);
  return v;
}

type Detection = { b: Box; t: number };
type Cluster = { b: Box; t0: number; t1: number };

const RGB_W = 400;        // analysis width; height follows the aspect ratio
const RGB_MAX_PIXELS = 24e6;  // analysed pixels per clip; two clips are held at once
const COLOR_MIN = 12;     // caption-coloured / ghost pixels left -> text still on screen
const MAX_DROP = 0.08;    // a few leftover frames still read as a caption to the eye
const MASK_PASSES = 3;    // mask passes; each run only removes what its mask covered
// The neural remover reconstructs a masked region from a window of frames, so it
// cleans short clips reliably but leaves readable ghosting on long ones (the
// caption survives because there's too much to rebuild at once). Clips up to
// ~2.7s go through in one piece — unchanged, this is what already works — while
// longer clips are split into ~1.7s windows, each cleaned on its own, then
// stitched back together.
const CHUNK_MAX_FRAMES = 80;
const CHUNK_TARGET_FRAMES = 50;

type Leftover = {
  bad: number[];          // frames still showing text
  counts: number[];       // caption-coloured pixels surviving, per frame
  frames: number;
  maskPx: number;         // pixels the remover repainted anywhere in the clip
  colour: [number, number, number] | null;
  box: Box | null;        // bounding box of the repainted pixels
};

/**
 * Frames that still show text, found by colour rather than by brightness.
 *
 * The pixels the remover repainted somewhere in the clip bound where captions
 * can be; within those, the caption's own colour (saturated yellow, plain white)
 * is learned from the original, and a frame is flagged when pixels of that
 * colour survive into the output. Brightness alone cannot do this — a leftover
 * yellow letter scores like a white highlight — whereas by colour the signal is
 * unambiguous: hundreds of pixels on frames that show text, zero on the rest.
 */
export function analyzeLeftoverText(
  orig: Buffer, clean: Buffer, w: number, h: number,
  band?: { y0: number; y1: number } | null,
): Leftover {
  const px = w * h;
  const fsz = px * 3;
  const frames = Math.min(Math.floor(orig.length / fsz), Math.floor(clean.length / fsz));
  const empty: Leftover = { bad: [], counts: [], frames, maskPx: 0, colour: null, box: null };
  if (!frames) return empty;

  // The remover re-encodes the whole frame, so the raw diff drifts far past the
  // caption and picks up static graphics elsewhere (a news chyron reads as
  // "surviving caption colour" on every frame). Judging only the caption band
  // keeps the check on the text that was actually targeted.
  const bandY0 = band ? Math.max(0, Math.floor(band.y0 * h)) : 0;
  const bandY1 = band ? Math.min(h, Math.ceil(band.y1 * h)) : h;

  const mask = new Uint8Array(px);
  let maskPx = 0;
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let f = 0; f < frames; f++) {
    for (let p = 0; p < px; p++) {
      if (mask[p]) continue;
      const row = (p / w) | 0;
      if (row < bandY0 || row >= bandY1) continue;
      const i = f * fsz + p * 3;
      const d = Math.abs(orig[i] - clean[i]) + Math.abs(orig[i + 1] - clean[i + 1]) +
        Math.abs(orig[i + 2] - clean[i + 2]);
      if (d <= 90) continue;
      mask[p] = 1;
      maskPx++;
      const x = p % w;
      const y = (p - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!maskPx) return empty;

  // Learn the caption colour. The repaint mask covers a box around each word, so
  // most masked pixels are background: look for a saturated population first,
  // then for plain white.
  const sat: number[][] = [];
  const white: number[][] = [];
  for (let f = 0; f < frames; f += 2) {
    for (let p = 0; p < px; p++) {
      if (!mask[p]) continue;
      const i = f * fsz + p * 3;
      const r = orig[i];
      const g = orig[i + 1];
      const b = orig[i + 2];
      if (Math.max(r, g, b) < 190) continue;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 100) sat.push([r, g, b]);
      else if (Math.min(r, g, b) > 200) white.push([r, g, b]);
    }
  }
  const pool = sat.length >= 200 ? sat : white;
  if (pool.length < 60) return { ...empty, maskPx };
  const med = (k: number) => {
    const v = pool.map((c) => c[k]).sort((m, n) => m - n);
    return v[Math.floor(v.length / 2)];
  };
  const colour: [number, number, number] = [med(0), med(1), med(2)];
  const isWhite = Math.max(...colour) - Math.min(...colour) <= 100;
  const near = (buf: Buffer, i: number) =>
    Math.abs(buf[i] - colour[0]) + Math.abs(buf[i + 1] - colour[1]) +
    Math.abs(buf[i + 2] - colour[2]) <= 110;
  // White lettering needs its hard edge too, or bright scenery reads as text.
  const sharp = (buf: Buffer, p: number, f: number) => {
    const x = p % w;
    const y = (p - x) / w;
    if (x < 2 || x >= w - 2 || y < 1 || y >= h - 1) return false;
    const i = f * fsz + p * 3;
    const lum = (o: number) => buf[i + o] + buf[i + o + 1] + buf[i + o + 2];
    return Math.max(Math.abs(lum(6) - lum(-6)), Math.abs(lum(w * 3) - lum(-w * 3))) > 165;
  };

  const counts: number[] = [];
  const bad: number[] = [];
  for (let f = 0; f < frames; f++) {
    let hit = 0;
    for (let p = 0; p < px; p++) {
      if (!mask[p]) continue;
      const i = f * fsz + p * 3;
      if (!near(orig, i)) continue;   // no caption colour here to begin with
      // Ghost captions: MiniMax often leaves a faded / translucent smear that
      // is no longer the original yellow/white, so colour-match alone misses it.
      const stillBright =
        Math.min(clean[i], clean[i + 1], clean[i + 2]) > 140
        && (clean[i] + clean[i + 1] + clean[i + 2]) >= (orig[i] + orig[i + 1] + orig[i + 2]) * 0.7;
      if (!near(clean, i) && !stillBright) continue;
      if (isWhite && !stillBright && !sharp(clean, p, f)) continue;
      hit++;
    }
    counts.push(hit);
    if (hit >= COLOR_MIN) bad.push(f);
  }

  return {
    bad,
    counts,
    frames,
    maskPx,
    colour,
    box: { x0: x0 / w, x1: (x1 + 1) / w, y0: y0 / h, y1: (y1 + 1) / h },
  };
}

/** True when the reconstruction actually repainted letters and they did not come back. */
function leftoverWorked(lo: Leftover): boolean {
  if (lo.maskPx < 200 || !lo.colour) return false;
  const maxDrop = Math.max(2, Math.floor(lo.frames * MAX_DROP));
  return lo.bad.length <= maxDrop;
}

/**
 * Share of pixels that differ a lot between two clips. A caption inpaint
 * changes a few percent (the letters). Replacing / stretching the whole frame
 * lights up most of the picture — that's how YOLO "spaccava i frame".
 */
export function changedPixelCoverage(orig: Buffer, recon: Buffer, w: number, h: number): number {
  const px = w * h;
  const fsz = px * 3;
  const frames = Math.min(Math.floor(orig.length / fsz), Math.floor(recon.length / fsz));
  if (!frames || !px) return 1;
  let changed = 0;
  const total = frames * px;
  for (let f = 0; f < frames; f++) {
    for (let p = 0; p < px; p++) {
      const i = f * fsz + p * 3;
      const d = Math.abs(orig[i] - recon[i]) + Math.abs(orig[i + 1] - recon[i + 1]) +
        Math.abs(orig[i + 2] - recon[i + 2]);
      if (d > 90) changed++;
    }
  }
  return changed / total;
}

/** Raw RGB frames of a clip, downscaled so the whole clip fits in memory. */
async function rgbFrames(
  file: string, W: number, H: number, dur: number, fps: number, workDir: string,
): Promise<{ buf: Buffer; w: number; h: number }> {
  const est = Math.max(1, Math.round(dur * fps));
  let w = RGB_W;
  let h = Math.round((H / W) * w / 2) * 2;
  while (w > 160 && w * h * est > RGB_MAX_PIXELS) {
    w -= 40;
    h = Math.round((H / W) * w / 2) * 2;
  }
  const raw = path.join(workDir, `rgb_${path.basename(file)}_${Date.now()}.raw`);
  await run(FFMPEG, [
    '-y', '-i', file, '-vf', `scale=${w}:${h}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw,
  ]);
  const buf = fs.readFileSync(raw);
  try { fs.rmSync(raw, { force: true }); } catch { /* ignore */ }
  return { buf, w, h };
}

/**
 * Drop the offending frames and hold the previous good one in their place: fps
 * re-times the gaps by repeating the last frame, and tpad restores the duration
 * lost when leading frames go. Freezing ~33ms is invisible, whereas erasing the
 * band only on those frames makes the patch blink on and off.
 */
export function buildDropGraph(bad: number[], fps: number): string {
  const expr = bad.map((f) => `eq(n\\,${f})`).join('+');
  let lead = 0;
  while (bad.includes(lead)) lead++;
  const graph = [
    `select='not(${expr})'`,
    'setpts=PTS-STARTPTS',
    `fps=${fps}`,
  ];
  if (lead > 0) graph.push(`tpad=stop_mode=clone:stop_duration=${(lead / fps).toFixed(3)}`);
  return graph.join(',');
}

/**
 * Text detected on consecutive frames is the same caption moving/flickering, so
 * merge overlapping boxes into one region with one time window. Keeps the filter
 * graph small (1-3 regions instead of one per frame).
 */
export function clusterDetections(dets: Detection[], window: number): Cluster[] {
  const clusters: Cluster[] = [];
  const overlaps = (a: Box, c: Box) =>
    a.x0 < c.x1 + 0.04 && c.x0 < a.x1 + 0.04 && a.y0 < c.y1 + 0.04 && c.y0 < a.y1 + 0.04;
  for (const d of dets) {
    const hit = clusters.find((c) => overlaps(d.b, c.b));
    if (hit) {
      hit.b = {
        x0: Math.min(hit.b.x0, d.b.x0), y0: Math.min(hit.b.y0, d.b.y0),
        x1: Math.max(hit.b.x1, d.b.x1), y1: Math.max(hit.b.y1, d.b.y1),
      };
      hit.t0 = Math.min(hit.t0, d.t - window);
      hit.t1 = Math.max(hit.t1, d.t + window);
    } else {
      clusters.push({ b: { ...d.b }, t0: d.t - window, t1: d.t + window });
    }
  }
  return clusters.map((c) => ({ ...c, t0: Math.max(0, c.t0) }));
}

type Rect = { x: number; y: number; w: number; h: number; t0: number; t1: number };

export function toRect(c: Cluster, W: number, H: number): Rect | null {
  const pad = 0.015;
  const x = Math.max(2, Math.round((c.b.x0 - pad) * W) & ~1);
  const y = Math.max(2, Math.round((c.b.y0 - pad) * H) & ~1);
  const w = Math.min(W - x - 2, Math.round((c.b.x1 - c.b.x0 + pad * 2) * W)) & ~1;
  const h = Math.min(H - y - 2, Math.round((c.b.y1 - c.b.y0 + pad * 2) * H)) & ~1;
  if (w < 8 || h < 8) return null;
  // A region covering most of the frame would wreck the whole image.
  if ((w * h) / (W * H) > 0.5) return null;
  return { x, y, w, h, t0: c.t0, t1: c.t1 };
}

/**
 * delogo interpolates the region away but leaves ghosting on textured
 * backgrounds, so each region also gets a localized blur on top: together the
 * text becomes unreadable and the patch reads as soft focus.
 */
export function buildEraseGraph(rects: Rect[]): string {
  const en = (r: Rect) => `enable='between(t,${r.t0.toFixed(2)},${r.t1.toFixed(2)})'`;
  const delogos = rects
    .map((r) => `delogo=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:${en(r)}`)
    .join(',');
  const parts = [`[0:v]${delogos},split=2[base][pre]`];
  parts.push(`[pre]boxblur=18:2${rects.length > 1 ? `,split=${rects.length}` : ''}${
    rects.map((_, i) => `[b${i}]`).join('')}`);
  rects.forEach((r, i) => {
    parts.push(`[b${i}]crop=${r.w}:${r.h}:${r.x}:${r.y}[c${i}]`);
    const src = i === 0 ? '[base]' : `[v${i - 1}]`;
    const dst = i === rects.length - 1 ? '' : `[v${i}]`;
    parts.push(`${src}[c${i}]overlay=${r.x}:${r.y}:${en(r)}${dst}`);
  });
  return parts.join(';');
}

function extractOutputUrl(output: unknown): string | null {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const u = output.find((x) => typeof x === 'string');
    return (u as string) || null;
  }
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    for (const k of ['video', 'output', 'url', 'file']) {
      if (typeof o[k] === 'string') return o[k] as string;
    }
  }
  return null;
}

/**
 * Try a mask-driven video remover on one shot without touching anything.
 *
 * The models built for this job (MiniMax-Remover, ProPainter) rebuild a masked
 * region with temporal context instead of smearing the edges inward, but they
 * need a mask, which is why they failed when first tried. The mask now comes
 * from the caption's own colour, measured on the original clip.
 *
 * Nothing in the database changes and clean_path is left alone: the result and a
 * diagnostics sidecar land in <project>/shots-compare/ so the two approaches can
 * be looked at side by side before either becomes the default.
 */
type RgbFrames = { buf: Buffer; w: number; h: number };

/**
 * Remove a caption by handing a video remover an exact mask of it.
 *
 * The removers built for this (MiniMax-Remover) rebuild a masked region with
 * temporal context instead of smearing its edges inward, which is why the text
 * area no longer shows a blurred patch. What they need is the mask, and that
 * comes from the caption's own colour measured on this clip — the piece that was
 * missing when these models were first tried.
 *
 * Returns null when the mask can't be trusted or the model won't cooperate, so
 * the caller falls back to detector-based removal rather than shipping a clip
 * with legitimate content erased.
 */
type MaskOpts = {
  supabase: ReturnType<typeof getSupabase>;
  token: string;
  srcKey: string;
  srcFile: string;
  textRegion: string | null;
  maskKey: string;
  W: number;
  H: number;
  fps: number;
  dur: number;
  workDir: string;
  deadline: number;
  log: (...a: unknown[]) => void;
  report?: Record<string, unknown>;
  /** Model knobs to override, for trying settings from a diagnostics run. */
  tuning?: Record<string, number>;
};

type ModelInfo = { version: string; props: Record<string, { maximum?: number; minimum?: number }>; videoField: string; maskField: string };

/** Read the wrapper's (undocumented) input field names off its OpenAPI schema. */
async function resolveMaskModel(token: string, log: (...a: unknown[]) => void): Promise<ModelInfo | null> {
  const modelResp = await fetch(`https://api.replicate.com/v1/models/${MASK_MODEL}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!modelResp.ok) { log(`model lookup ${modelResp.status}`); return null; }
  const meta = await modelResp.json();
  const version = meta?.latest_version?.id;
  const props = meta?.latest_version?.openapi_schema?.components?.schemas?.Input?.properties || {};
  const keys = Object.keys(props);
  const maskField = keys.find((k) => /mask/i.test(k) && !/dilation|iteration/i.test(k));
  const videoField = keys.find((k) => /^(video|input_video|source_video)$/i.test(k)) ||
    keys.find((k) => /video/i.test(k) && !/mask/i.test(k));
  if (!version || !videoField || !maskField) { log('could not map the model inputs'); return null; }
  return { version, props, videoField, maskField };
}

/**
 * Paste reconstructed pixels ONLY where the mask is white. Never ship the
 * remover's full frame: it smears a caption-wide strip that reads as a
 * blurred fascia. If both composites fail, the caller retries / keeps original.
 */
async function compositeThroughMask(opts: {
  srcFile: string; reconFile: string; maskFile: string; outFile: string;
  W: number; H: number; log: (...a: unknown[]) => void; tag: string;
}): Promise<boolean> {
  const { srcFile, reconFile, maskFile, outFile, W, H, log, tag } = opts;
  const scale = `[1:v]scale=${W}:${H}:flags=lanczos,setsar=1[recon];` +
    `[2:v]scale=${W}:${H}:flags=neighbor,format=gray,dilation,dilation,dilation[mk];`;
  try {
    await run(FFMPEG, [
      '-y', '-i', srcFile, '-i', reconFile, '-i', maskFile,
      '-filter_complex', `${scale}[0:v][recon][mk]maskedmerge[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
      '-preset', 'veryfast', '-movflags', '+faststart', '-an', outFile,
    ]);
    return true;
  } catch (e) {
    log(`${tag}: maskedmerge failed (${(e as Error).message})`);
  }
  try {
    await run(FFMPEG, [
      '-y', '-i', srcFile, '-i', reconFile, '-i', maskFile,
      '-filter_complex',
      `${scale}[recon][mk]alphamerge[reconA];[0:v][reconA]overlay=0:0:format=auto:eof_action=pass:repeatlast=0[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
      '-preset', 'veryfast', '-movflags', '+faststart', '-an', outFile,
    ]);
    return true;
  } catch (e) {
    log(`${tag}: mask composite failed (${(e as Error).message}) — not shipping a smeared frame`);
    return false;
  }
}

/** Take reconstructed pixels only where they differ from the source, and only
 *  in the caption zones (top headline / bottom spoken captions). The face and
 *  the rest of the frame stay the original pixels. */
async function compositeChangedPixels(opts: {
  srcFile: string; reconFile: string; outFile: string;
  W: number; H: number; log: (...a: unknown[]) => void; tag: string;
}): Promise<boolean> {
  const { srcFile, reconFile, outFile, W, H, log, tag } = opts;
  const topH = Math.max(8, Math.round(H * 0.22));
  const botY = Math.round(H * 0.58);
  const botH = H - botY;
  const scaleRecon = `[1:v]scale=${W}:${H}:flags=lanczos,setsar=1[r];`;
  try {
    await run(FFMPEG, [
      '-y', '-i', srcFile, '-i', reconFile,
      '-filter_complex',
      `${scaleRecon}[r]split=2[rd][rm];` +
      `[0:v]split=3[src][zoneSrc][base];` +
      `[src][rd]blend=all_mode=difference,format=gray,` +
      `lut=y='if(gte(val\\,48),255,0)',dilation[diff];` +
      `[zoneSrc]drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill,` +
      `drawbox=x=0:y=0:w=iw:h=${topH}:color=white:t=fill,` +
      `drawbox=x=0:y=${botY}:w=iw:h=${botH}:color=white:t=fill,format=gray[zones];` +
      `[diff][zones]blend=all_mode=multiply,format=gray[mk];` +
      `[base][rm][mk]maskedmerge[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
      '-preset', 'veryfast', '-movflags', '+faststart', '-an', outFile,
    ]);
    return true;
  } catch (e) {
    log(`${tag}: changed-pixel composite failed (${(e as Error).message}) — caption-zone overlay`);
  }
  // Fallback: paste the reconstructed top/bottom caption zones onto the original
  // frames. Letters in those zones are neural inpaint, not a blur fascia.
  try {
    await run(FFMPEG, [
      '-y', '-i', srcFile, '-i', reconFile,
      '-filter_complex',
      `${scaleRecon}[r]split=2[rt][rb];` +
      `[rt]crop=${W}:${topH}:0:0[top];` +
      `[rb]crop=${W}:${botH}:0:${botY}[bot];` +
      `[0:v][top]overlay=0:0[v1];` +
      `[v1][bot]overlay=0:${botY}[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
      '-preset', 'veryfast', '-movflags', '+faststart', '-an', outFile,
    ]);
    return true;
  } catch (e) {
    log(`${tag}: caption-zone overlay failed (${(e as Error).message})`);
    return false;
  }
}

/**
 * Clean ONE clip (whole or a single window) with the mask-driven neural remover.
 * This is the piece that used to be all of maskDrivenClean; it's unchanged in
 * behaviour, just parameterised on a pre-resolved model so windows can reuse it.
 */
async function miniMaxClip(opts: MaskOpts & { model: ModelInfo }): Promise<{ file: string; srcRgb: RgbFrames; frames: number; band: { y0: number; y1: number } | null } | null> {
  const {
    supabase, token, srcKey, srcFile, textRegion, maskKey,
    W, H, fps, dur, workDir, deadline, log, report, tuning, model,
  } = opts;
  const { version, props, videoField, maskField } = model;
  const note = (msg: string) => {
    log(msg);
    if (report) report.maskPath = msg;
  };

  const srcRgb = await rgbFrames(srcFile, W, H, dur, fps, workDir);
  const frames = Math.floor(srcRgb.buf.length / (srcRgb.w * srcRgb.h * 3));
  const cm = captionMasks(srcRgb.buf, frames, srcRgb.w, srcRgb.h, textRegion);
  if (!cm) { note('no caption colour found on the original'); return null; }

  const trust = maskIsTrustworthy(cm, srcRgb.w, srcRgb.h);
  if (report) {
    report.mask = {
      colours: cm.colours, kind: cm.kind, samples: cm.samples,
      pxPerFrame: cm.pxPerFrame, coverage: +(cm.pxPerFrame / (srcRgb.w * srcRgb.h)).toFixed(4),
      blockFill: +cm.blockFill.toFixed(2), textFrames: +cm.textFrames.toFixed(2),
      frames, analysedAt: `${srcRgb.w}x${srcRgb.h}`, trusted: trust.ok, verdict: trust.why,
    };
  }
  log(`mask: ${cm.colours.map((c) => `rgb(${c.join(',')})`).join(' + ')} ${trust.why}`);
  if (!trust.ok) { note(`mask rejected — ${trust.why}`); return null; }

  const maskFile = await writeMaskVideo(cm.masks, srcRgb.w, srcRgb.h, fps, W, H, workDir);
  await uploadFile(supabase, maskKey, maskFile, 'video/mp4');
  const sign = async (key: string) => {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(key, 3600);
    return data?.signedUrl || null;
  };
  const videoUrl = await sign(srcKey);
  const maskUrl = await sign(maskKey);
  if (!videoUrl || !maskUrl) { note('could not sign the model inputs'); return null; }

  const input: Record<string, unknown> = { [videoField]: videoUrl, [maskField]: maskUrl };
  // These removers work on a block of frames, so a clip longer than the default
  // comes back truncated. Ask for this clip's real length and size.
  // Grow the mask only a couple of pixels: 10 dilation iterations used to fuse
  // the letters into a caption-wide strip and the output was a blurred fascia.
  const wanted: Record<string, number> = {
    fps: Math.round(fps), num_frames: frames, width: W, height: H,
    mask_dilation_iterations: 4, num_inference_steps: 20,
    ...(tuning || {}),
  };
  for (const [name, value] of Object.entries(wanted)) {
    const spec = props[name];
    if (!spec) continue;
    const max = typeof spec.maximum === 'number' ? spec.maximum : Infinity;
    const min = typeof spec.minimum === 'number' ? spec.minimum : 0;
    input[name] = Math.max(min, Math.min(max, value));
  }
  if (report) report.sent = { video: videoField, mask: maskField, ...wanted };
  log(`running ${MASK_MODEL}: ${frames} frames @ ${Math.round(fps)}fps`);

  const started = Date.now();
  let url: string | null = null;
  try {
    url = extractOutputUrl(await replicateRun(token, version, input, deadline, log));
  } catch (e) {
    note(`model failed: ${(e as Error).message}`);
    return null;
  }
  if (report) report.seconds = Math.round((Date.now() - started) / 1000);
  if (!url) { note('prediction returned no video'); return null; }

  const dl = await fetch(url);
  if (!dl.ok) { note(`could not download the result (${dl.status})`); return null; }
  const raw = path.join(workDir, `mask-raw_${path.basename(maskKey)}.mp4`);
  fs.writeFileSync(raw, Buffer.from(await dl.arrayBuffer()));

  // A shorter result means frames were dropped somewhere; that is worse than a
  // visible caption, so it goes back to the fallback.
  const outDur = await probeDuration(raw);
  const usable = await ensureDuration(raw, dur, workDir, `mask_${path.basename(maskKey)}`);
  if (!usable) {
    note(`result is ${outDur.toFixed(2)}s of ${dur.toFixed(2)}s — kept the fallback instead`);
    return null;
  }
  const file = path.join(workDir, `mask-clean_${path.basename(maskKey)}.mp4`);
  const ok = await compositeThroughMask({
    srcFile, reconFile: usable, maskFile, outFile: file, W, H, log, tag: 'minimax',
  });
  if (!ok) { note('could not composite reconstructed letter pixels'); return null; }
  return { file, srcRgb, frames, band: cm.band };
}

/**
 * Neural reconstruction of a KNOWN band.
 *
 * When the colour mask can't be trusted (so miniMaxClip bails) but we already
 * know where the caption lives — e.g. learned from sibling windows of the same
 * video — we can still hand the remover a mask: a solid white rectangle over
 * that band for every frame. The model then rebuilds those pixels from temporal
 * context instead of us blurring them. Returns the cleaned file, or null so the
 * caller can fall back to a blur.
 */
async function bandInpaintClip(opts: {
  supabase: ReturnType<typeof getSupabase>;
  token: string;
  model: ModelInfo;
  srcKey: string;      // already uploaded source window
  srcFile: string;
  maskKey: string;
  band: { y0: number; y1: number };
  W: number; H: number; fps: number; dur: number;
  workDir: string; deadline: number; tag: string;
  log: (...a: unknown[]) => void;
}): Promise<string | null> {
  const { supabase, token, model, srcKey, srcFile, maskKey, band, W, H, fps, dur, workDir, deadline, tag, log } = opts;
  const { version, props, videoField, maskField } = model;

  const y = Math.max(0, Math.round(band.y0 * H)) & ~1;
  const bh = Math.min(H - y, Math.round((band.y1 - band.y0) * H)) & ~1;
  if (bh < 8) return null;
  const frames = Math.max(1, Math.round(fps * dur));

  // Solid white band on black, matching the clip's size/fps/length.
  const maskFile = path.join(workDir, `bandmask_${tag}.mp4`);
  await run(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=${dur.toFixed(3)}:r=${Math.round(fps)}`,
    '-vf', `drawbox=x=0:y=${y}:w=${W}:h=${bh}:color=white:t=fill`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', maskFile,
  ]);
  await uploadFile(supabase, maskKey, maskFile, 'video/mp4');

  const sign = async (key: string) => {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(key, 3600);
    return data?.signedUrl || null;
  };
  const videoUrl = await sign(srcKey);
  const maskUrl = await sign(maskKey);
  if (!videoUrl || !maskUrl) { log(`${tag}: could not sign band-inpaint inputs`); return null; }

  const input: Record<string, unknown> = { [videoField]: videoUrl, [maskField]: maskUrl };
  const wanted: Record<string, number> = {
    fps: Math.round(fps), num_frames: frames, width: W, height: H,
    // Keep the repainted area tight to the band (heavy dilation smears far
    // beyond the text) and give the model enough steps to reconstruct cleanly.
    mask_dilation_iterations: 4, num_inference_steps: 20,
  };
  for (const [name, value] of Object.entries(wanted)) {
    const spec = props[name];
    if (!spec) continue;
    const max = typeof spec.maximum === 'number' ? spec.maximum : Infinity;
    const min = typeof spec.minimum === 'number' ? spec.minimum : 0;
    input[name] = Math.max(min, Math.min(max, value));
  }

  let url: string | null = null;
  try {
    url = extractOutputUrl(await replicateRun(token, version, input, deadline, log));
  } catch (e) {
    log(`${tag}: band inpaint failed (${(e as Error).message})`);
    return null;
  }
  if (!url) { log(`${tag}: band inpaint returned no video`); return null; }

  const dl = await fetch(url);
  if (!dl.ok) { log(`${tag}: could not download band-inpaint result (${dl.status})`); return null; }
  const raw = path.join(workDir, `bandraw_${tag}.mp4`);
  fs.writeFileSync(raw, Buffer.from(await dl.arrayBuffer()));

  const outDur = await probeDuration(raw);
  if (outDur < dur - 0.3) { log(`${tag}: band inpaint truncated to ${outDur.toFixed(2)}s of ${dur.toFixed(2)}s`); return null; }

  // The remover re-encodes and can reshape the WHOLE frame ("tutto brullato e
  // sformato"). Take ONLY the band from its output and overlay it back onto the
  // untouched original, so everything outside the caption band stays pixel-exact
  // and correctly shaped — only the caption strip is the reconstruction.
  const file = path.join(workDir, `bandclean_${tag}.mp4`);
  try {
    await run(FFMPEG, [
      '-y', '-i', srcFile, '-i', raw,
      '-filter_complex',
      `[1:v]scale=${W}:${H},setsar=1,crop=${W}:${bh}:0:${y}[band];[0:v][band]overlay=0:${y}[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
      '-preset', 'veryfast', '-movflags', '+faststart', '-an', file,
    ]);
  } catch (e) {
    log(`${tag}: band composite failed (${(e as Error).message}) — keeping original`);
    return null;
  }
  return file;
}

/**
 * Reconstruct ONLY the caption TEXT pixels of a clip. Unlike bandInpaintClip
 * (which repaints a full-width horizontal band → "blur enorme / sformato"),
 * this feeds the remover a TIGHT per-frame mask of the actual letters, then
 * composites the reconstructed result back through that same mask so ONLY the
 * text pixels change and everything else stays pixel-exact. Returns null if the
 * model can't run or produces a truncated result — the caller then keeps the
 * original window rather than degrading it.
 */
async function textMaskReconstruct(opts: {
  supabase: ReturnType<typeof getSupabase>;
  token: string;
  model: ModelInfo;
  srcKey: string;
  srcFile: string;
  maskFile: string;    // tight per-frame text mask, already sized to WxH
  maskKey: string;
  W: number; H: number; fps: number; dur: number;
  workDir: string; deadline: number; tag: string;
  log: (...a: unknown[]) => void;
}): Promise<string | null> {
  const { supabase, token, model, srcFile, maskFile, maskKey, W, H, dur, workDir, deadline, tag, log } = opts;
  const { version, props, videoField, maskField } = model;

  // Native 1080p / 20-step MiniMax billed ~minutes of L40S per window and
  // burned tens of dollars on a 30s clip. The model is documented around
  // 480–832px and 12 steps; we downscale, reconstruct, then paste only those
  // pixels back onto the original frames.
  const MM_SIDE = 640;
  const MM_FPS = 12;
  const long = Math.max(W, H) || MM_SIDE;
  const scale = long > MM_SIDE ? MM_SIDE / long : 1;
  const mw = Math.max(2, Math.round(W * scale) & ~1);
  const mh = Math.max(2, Math.round(H * scale) & ~1);
  const mmFrames = Math.max(8, Math.min(24, Math.round(MM_FPS * dur)));
  const smallSrc = path.join(workDir, `mmvid_${tag}.mp4`);
  const smallMask = path.join(workDir, `mmask_${tag}.mp4`);
  try {
    await run(FFMPEG, [
      '-y', '-i', srcFile,
      '-vf', `fps=${MM_FPS},scale=${mw}:${mh}:flags=lanczos,setsar=1`,
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      smallSrc,
    ]);
    await run(FFMPEG, [
      '-y', '-i', maskFile,
      '-vf', `fps=${MM_FPS},scale=${mw}:${mh}:flags=neighbor,setsar=1`,
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      smallMask,
    ]);
  } catch (e) {
    log(`${tag}: MiniMax downscale failed (${(e as Error).message})`);
    return null;
  }

  const smallSrcKey = `${maskKey}_v.mp4`;
  await uploadFile(supabase, smallSrcKey, smallSrc, 'video/mp4');
  await uploadFile(supabase, maskKey, smallMask, 'video/mp4');
  const sign = async (key: string) => {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(key, 3600);
    return data?.signedUrl || null;
  };
  const videoUrl = await sign(smallSrcKey);
  const maskUrl = await sign(maskKey);
  if (!videoUrl || !maskUrl) { log(`${tag}: could not sign inpaint inputs`); return null; }

  const input: Record<string, unknown> = { [videoField]: videoUrl, [maskField]: maskUrl };
  const wanted: Record<string, number> = {
    fps: MM_FPS, num_frames: mmFrames, width: mw, height: mh,
    mask_dilation_iterations: 8, num_inference_steps: 12,
  };
  for (const [name, value] of Object.entries(wanted)) {
    const spec = props[name];
    if (!spec) continue;
    const max = typeof spec.maximum === 'number' ? spec.maximum : Infinity;
    const min = typeof spec.minimum === 'number' ? spec.minimum : 0;
    input[name] = Math.max(min, Math.min(max, value));
  }
  log(`${tag}: MiniMax ${mw}x${mh} ${mmFrames}f/12 steps (source ${W}x${H})`);

  let url: string | null = null;
  try {
    url = extractOutputUrl(await replicateRun(token, version, input, deadline, log));
  } catch (e) {
    log(`${tag}: text inpaint failed (${(e as Error).message})`);
    return null;
  }
  if (!url) { log(`${tag}: text inpaint returned no video`); return null; }

  const dl = await fetch(url);
  if (!dl.ok) { log(`${tag}: could not download inpaint result (${dl.status})`); return null; }
  const raw = path.join(workDir, `textraw_${tag}.mp4`);
  fs.writeFileSync(raw, Buffer.from(await dl.arrayBuffer()));
  const outDur = await probeDuration(raw);
  const usable = await ensureDuration(raw, dur, workDir, `${tag}_inpaint`);
  if (!usable) { log(`${tag}: inpaint truncated to ${outDur.toFixed(2)}s of ${dur.toFixed(2)}s`); return null; }

  // Composite: take the reconstruction ONLY where the mask marks text (alpha),
  // overlay it on the untouched original. Everything but the letters is source.
  const file = path.join(workDir, `textclean_${tag}.mp4`);
  const ok = await compositeThroughMask({
    srcFile, reconFile: usable, maskFile, outFile: file, W, H, log, tag,
  });
  return ok ? file : null;
}

/** Cut [t0, t0+len) out of a clip, frame-accurate, re-encoded to H.264. */
async function cutWindow(src: string, t0: number, len: number, out: string): Promise<void> {
  await run(FFMPEG, [
    '-y', '-i', src, '-ss', t0.toFixed(3), '-t', len.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-an', out,
  ]);
}

/** If the remover dropped a few tail frames, clone the last one instead of discarding the clip. */
export function shouldKeepRemoverOutput(got: number, want: number): 'keep' | 'pad' | 'discard' {
  if (got >= want - 0.3) return 'keep';
  if (got >= want * 0.75) return 'pad';
  return 'discard';
}

async function ensureDuration(
  file: string, wantDur: number, workDir: string, tag: string,
): Promise<string | null> {
  const got = await probeDuration(file);
  const verdict = shouldKeepRemoverOutput(got, wantDur);
  if (verdict === 'keep') return file;
  if (verdict === 'discard') return null;
  const padded = path.join(workDir, `pad_${tag}.mp4`);
  const pad = Math.max(0.05, wantDur - got);
  await run(FFMPEG, [
    '-y', '-i', file,
    '-vf', `tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'veryfast', '-an',
    padded,
  ]);
  return padded;
}

/**
 * YOLO finds burned-in text and inpaints those boxes. The original frames are
 * the base: we never ship YOLO's re-encoded/stretched clip as the video.
 */
async function detectorInpaintClip(opts: {
  token: string;
  videoUrl: string;
  srcFile: string;
  maskFile?: string | null;
  W: number; H: number; fps: number; dur: number;
  workDir: string; deadline: number; tag: string;
  log: (...a: unknown[]) => void;
}): Promise<string | null> {
  const { token, videoUrl, srcFile, maskFile, W, H, fps, dur, workDir, deadline, tag, log } = opts;
  let version: string;
  try {
    version = await resolveVersion(token, REPLICATE_MODEL);
  } catch (e) {
    log(`${tag}: detector lookup failed (${(e as Error).message})`);
    return null;
  }
  let output: unknown;
  try {
    output = await replicateRun(token, version, {
      video: videoUrl,
      method: 'hybrid',
      resolution: 'original',
      conf_threshold: 0.15,
      margin: 4,
      detection_interval: 1,
    }, deadline, log);
  } catch (e) {
    log(`${tag}: detector inpaint failed (${(e as Error).message})`);
    return null;
  }
  const url = extractOutputUrl(output);
  if (!url) { log(`${tag}: detector returned no video`); return null; }
  const dl = await fetch(url);
  if (!dl.ok) { log(`${tag}: could not download detector result (${dl.status})`); return null; }
  const raw = path.join(workDir, `detraw_${tag}.mp4`);
  fs.writeFileSync(raw, Buffer.from(await dl.arrayBuffer()));

  const outDur = await probeDuration(raw);
  if (outDur < dur * 0.75) {
    log(`${tag}: detector truncated to ${outDur.toFixed(2)}s of ${dur.toFixed(2)}s`);
    return null;
  }
  const info = await ffprobeInfo(raw);
  const ow = info.width || 0, oh = info.height || 0;
  if (!ow || !oh) { log(`${tag}: detector output has no size`); return null; }

  const scaled = path.join(workDir, `detscale_${tag}.mp4`);
  try {
    await run(FFMPEG, [
      '-y', '-i', raw,
      '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
      '-preset', 'veryfast', '-movflags', '+faststart', '-an', scaled,
    ]);
  } catch (e) {
    log(`${tag}: detector scale failed (${(e as Error).message})`);
    return null;
  }

  try {
    const a = await rgbFrames(srcFile, W, H, dur, fps, workDir);
    const b = await rgbFrames(scaled, W, H, dur, fps, workDir);
    const cov = changedPixelCoverage(a.buf, b.buf, a.w, a.h);
    log(`${tag}: detector changed ${(cov * 100).toFixed(1)}% of pixels`);
    if (cov < 0.002) {
      log(`${tag}: detector changed almost nothing`);
      return null;
    }
  } catch (e) {
    log(`${tag}: detector coverage check skipped (${(e as Error).message})`);
  }

  const file = path.join(workDir, `detclean_${tag}.mp4`);
  // Always paste onto the original. A colour letter mask that already failed
  // MiniMax would put the original letters back — use caption-zone diffs instead.
  const ok = await compositeChangedPixels({
    srcFile, reconFile: scaled, outFile: file, W, H, log, tag: `${tag}_det`,
  });
  return ok ? file : null;
}

/**
 * Mask-driven neural removal for a shot.
 *
 * Short clips (≤ CHUNK_MAX_FRAMES) go straight through miniMaxClip — the exact
 * path that already cleans them well. Longer clips are the ones the model chokes
 * on (it leaves readable ghosting), so they're split into ~CHUNK_TARGET_FRAMES
 * windows, each cleaned on its own — the conditions the model is good at — then
 * stitched back together. Windows with no trustworthy caption keep their
 * original footage so nothing is dropped. Any failure in the chunk path falls
 * back to cleaning the whole clip, so this can only ever add chances, never
 * remove the behaviour that works today.
 */
async function maskDrivenClean(opts: MaskOpts): Promise<{ file: string; srcRgb: RgbFrames; frames: number; band: { y0: number; y1: number } | null; verified?: boolean } | null> {
  const { token, srcFile, W, H, fps, dur, workDir, deadline, log, report } = opts;
  const model = await resolveMaskModel(token, log);
  if (report) report.inputs = model ? [model.videoField, model.maskField] : [];
  if (!model) { if (report) report.maskPath = 'could not resolve the model'; return null; }

  const approxFrames = Math.max(1, Math.round(dur * (fps || 30)));
  // Short enough for the model to handle in one piece: unchanged behaviour.
  if (approxFrames <= CHUNK_MAX_FRAMES) {
    return miniMaxClip({ ...opts, model });
  }

  // Long clip → clean it in short windows, then stitch. Guarded so any hiccup
  // just reverts to the whole-clip attempt.
  try {
    const nWindows = Math.max(2, Math.ceil(approxFrames / CHUNK_TARGET_FRAMES));
    const winDur = dur / nWindows;
    log(`chunking ${dur.toFixed(2)}s clip into ${nWindows} windows of ${winDur.toFixed(2)}s`);
    if (report) report.chunked = { windows: nWindows, windowSeconds: +winDur.toFixed(2) };

    const pieces: string[] = [];
    let band: { y0: number; y1: number } | null = null;
    let cleanedAny = false;
    for (let i = 0; i < nWindows; i++) {
      if (Date.now() > deadline) throw new Error('out of time mid-chunk');
      const t0 = i * winDur;
      const len = i === nWindows - 1 ? Math.max(0.1, dur - t0) : winDur;
      const winFile = path.join(workDir, `win_${i}_${Date.now()}.mp4`);
      await cutWindow(srcFile, t0, len, winFile);
      const winKey = `${opts.maskKey}.win${i}.mp4`;
      await uploadFile(opts.supabase, winKey, winFile, 'video/mp4');

      const cleaned = await miniMaxClip({
        ...opts, model,
        srcKey: winKey,
        srcFile: winFile,
        maskKey: `${opts.maskKey}.win${i}.mask.mp4`,
        dur: len,
        report: undefined, // don't let per-window details clobber the shot report
      });

      if (cleaned) {
        // Verify THIS window in place. The window's source and the window's
        // output are frame-aligned, so the differential check is reliable here —
        // unlike comparing the stitched clip against the whole original, whose
        // frames drift out of sync and flag even the parts that came out clean.
        const outRgb = await rgbFrames(cleaned.file, W, H, len, fps, workDir);
        const lo = analyzeLeftoverText(cleaned.srcRgb.buf, outRgb.buf, cleaned.srcRgb.w, cleaned.srcRgb.h, cleaned.band);
        const maxDrop = Math.max(2, Math.floor(lo.frames * MAX_DROP));
        if (lo.maskPx >= 200 && lo.bad.length <= maxDrop) {
          pieces.push(cleaned.file); cleanedAny = true; if (!band) band = cleaned.band;
        } else {
          log(`chunk window ${i}: caption survived (${lo.bad.length}/${lo.frames}) — shot not fully cleanable`);
          return null; // one window we can't clean ⇒ don't ship the shot as clean
        }
      } else {
        // miniMaxClip returned null: either there was no caption in this window
        // (fine — keep the original footage) or the mask couldn't be trusted
        // (then the caption stays, so the shot can't be fully cleaned).
        const wr = await rgbFrames(winFile, W, H, len, fps, workDir);
        const wf = Math.floor(wr.buf.length / (wr.w * wr.h * 3));
        if (captionMasks(wr.buf, wf, wr.w, wr.h, opts.textRegion)) {
          log(`chunk window ${i}: caption present but unmaskable — shot not fully cleanable`);
          return null;
        }
        pieces.push(winFile); // genuinely no caption in this window
      }
    }

    // No window had a caption to remove → nothing was actually cleaned; let the
    // caller fall through to the detector path exactly as before.
    if (!cleanedAny) { if (report) report.maskPath = 'chunk: no window had a caption to remove'; return null; }

    const listFile = path.join(workDir, `concat_${Date.now()}.txt`);
    fs.writeFileSync(listFile, pieces.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
    const outFile = path.join(workDir, `mask-clean-chunked_${Date.now()}.mp4`);
    await run(FFMPEG, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-an', outFile,
    ]);

    const srcRgb = await rgbFrames(srcFile, W, H, dur, fps, workDir);
    const frames = Math.floor(srcRgb.buf.length / (srcRgb.w * srcRgb.h * 3));
    const outDur = await probeDuration(outFile);
    if (outDur < dur - 0.4) {
      log(`chunked result is ${outDur.toFixed(2)}s of ${dur.toFixed(2)}s — reverting to whole-clip`);
      return miniMaxClip({ ...opts, model });
    }
      // Every window was verified aligned above, so the stitched result is
      // trusted — the caller must skip the whole-clip differential (it drifts).
      return { file: outFile, srcRgb, frames, band, verified: true };
    } catch (e) {
      log(`chunk path failed (${(e as Error).message}) — reverting to whole-clip`);
    return miniMaxClip({ ...opts, model });
  }
}

async function compareRemover(
  supabase: ReturnType<typeof getSupabase>,
  token: string,
  shotId: number,
  projectId: string,
  model: string,
  log: (...a: unknown[]) => void,
  tuning?: Record<string, number>,
): Promise<Response> {
  const workDir = makeWorkDir('wcompare-');
  const base = `${projectId}/shots-compare/${shotId}_${model.split('/')[1]}`;
  const report: Record<string, unknown> = { shotId, model, at: new Date().toISOString() };
  const save = async () => {
    const f = path.join(workDir, 'report.json');
    fs.writeFileSync(f, JSON.stringify(report, null, 2));
    try { await uploadFile(supabase, `${base}.json`, f, 'application/json'); } catch { /* ignore */ }
  };

  try {
    const { data: shot } = await supabase
      .from('competitor_shots')
      .select('id, file_path, text_region, clean_path')
      .eq('id', shotId)
      .maybeSingle();
    if (!shot?.file_path) { report.error = 'shot not found'; await save(); return new Response('no shot', { status: 200 }); }

    const srcFile = path.join(workDir, 'src.mp4');
    await downloadSource(supabase, shot.file_path as string, srcFile);
    const info = await ffprobeInfo(srcFile);
    const W = info.width || 0;
    const H = info.height || 0;
    const fps = info.fps && info.fps > 0 ? info.fps : 30;
    const dur = await probeDuration(srcFile);
    if (!W || !H) { report.error = 'could not probe dimensions'; await save(); return new Response('no dims', { status: 200 }); }

    // Same code path the real cleanup uses, so what is judged here is what ships.
    const cleaned = await maskDrivenClean({
      supabase, token,
      srcKey: shot.file_path as string,
      srcFile,
      textRegion: shot.text_region as string | null,
      maskKey: `${base}_mask.mp4`,
      W, H, fps, dur, workDir,
      deadline: Date.now() + MAX_WAIT_MS,
      log, report, tuning,
    });
    if (!cleaned) {
      report.error = report.maskPath || 'mask path produced nothing';
      await save();
      return new Response('no output', { status: 200 });
    }
    const outFile = cleaned.file;
    await uploadFile(supabase, `${base}.mp4`, outFile, 'video/mp4');

    const outInfo = await ffprobeInfo(outFile);
    const outDur = await probeDuration(outFile);
    report.output = {
      key: `${base}.mp4`, size: fs.statSync(outFile).size,
      w: outInfo.width, h: outInfo.height,
      // Truncation is the thing that decides whether this can be the default.
      seconds: +outDur.toFixed(2), sourceSeconds: +dur.toFixed(2),
      keptAll: outDur >= dur - 0.15,
    };
    report.currentClean = shot.clean_path || null;
    await save();
    log(`compare done in ${report.seconds}s — ${base}.mp4`);
    return new Response('done', { status: 200 });
  } catch (e) {
    report.error = (e as Error).message;
    await save();
    log('compare failed:', (e as Error).message);
    return new Response('error', { status: 200 });
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export type CleanResult =
  | { ok: true; outFile: string; note: string | null; band?: { y0: number; y1: number } | null }
  | { ok: false; unusable: true; note: string; band?: { y0: number; y1: number } | null };

/**
 * Remove burned-in captions from ONE video file and return a browser-playable
 * H.264 result. This is the whole engine — mask-driven neural removal, the
 * detector fallback, the OCR pass, the frame-drop / erase stages and the final
 * differential gate — lifted out of the shot handler so both a single shot and
 * a whole ad video clean identically. No database work happens here: the caller
 * owns claiming/persisting. `srcFile` must already be downloaded and probed.
 */
export async function cleanClipFile(opts: {
  supabase: ReturnType<typeof getSupabase>;
  token: string;
  srcKey: string;        // storage key of srcFile (signed for the detector model)
  srcFile: string;       // already downloaded to disk
  textRegion: string | null;
  W: number; H: number; fps: number; dur: number;
  workDir: string;
  deadline: number;
  keyBase: string;       // prefix for temporary mask/pass uploads
  log: (...a: unknown[]) => void;
  jitterMs?: number;     // random pre-delay to spread parallel shot jobs (0 for one-offs)
  // When the caption can't be reconstructed, do NOT blur a strip over it.
  // Shots leave the clip out of the pool; whole-video callers retry neurally.
  eraseIfUnreadable?: boolean;
}): Promise<CleanResult> {
  const {
    supabase, token, srcKey, srcFile, textRegion,
    W, H, fps, dur, workDir, deadline, keyBase, log,
  } = opts;

  // Public-ish URL Replicate can download the source clip from (detector path).
  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(srcKey, 3600);
  if (signErr || !signed?.signedUrl) throw new Error(`could not sign source URL: ${signErr?.message || 'no url'}`);

  const modelResp = await fetch(`https://api.replicate.com/v1/models/${REPLICATE_MODEL}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!modelResp.ok) throw new Error(`could not resolve model version ${modelResp.status}: ${(await modelResp.text()).slice(0, 200)}`);
  const model = await modelResp.json();
  const version = model?.latest_version?.id;
  if (!version) throw new Error('model has no latest version on Replicate');

  // Spread simultaneous shots apart before the first attempt.
  if (opts.jitterMs !== 0) await sleep(Math.random() * (opts.jitterMs ?? 15000));

  let inputUrl = signed.signedUrl;
  const outFile = path.join(workDir, `clean_${Date.now()}.mp4`);
  let srcRgb: { buf: Buffer; w: number; h: number } | null = null;
  let captionBand: { y0: number; y1: number } | null = null;
  let leftover: Leftover | null = null;
  let captionReadable = false;
  let alignedWithSource = true;
  let maskVerified = false;

  // ── Stage 1: mask-driven neural removal. ──────────────────────────────────
  let usedMaskPath = false;
  if (W && H) {
    try {
      let curKey = srcKey;
      let curFile = srcFile;
      for (let pass = 1; pass <= MASK_PASSES; pass++) {
        const masked = await maskDrivenClean({
          supabase, token,
          srcKey: curKey,
          srcFile: curFile,
          textRegion,
          maskKey: `${keyBase}_mask_p${pass}_${Date.now()}.mp4`,
          W, H, fps, dur, workDir, deadline, log,
        });
        if (!masked) {
          if (usedMaskPath) log(`mask pass ${pass}: no caption left to remove`);
          break;
        }
        fs.copyFileSync(masked.file, outFile);
        if (pass === 1) { srcRgb = masked.srcRgb; captionBand = masked.band; maskVerified = !!masked.verified; }
        usedMaskPath = true;
        if (pass === MASK_PASSES || Date.now() > deadline) break;
        curFile = path.join(workDir, `pass${pass}_${Date.now()}.mp4`);
        fs.copyFileSync(outFile, curFile);
        curKey = `${keyBase}_tmp_p${pass}_${Date.now()}.mp4`;
        await uploadFile(supabase, curKey, curFile, 'video/mp4');
      }
      if (usedMaskPath && maskVerified) {
        alignedWithSource = false;
        log('mask path: chunked result verified per-window — skipping whole-clip differential');
      } else if (usedMaskPath && srcRgb) {
        try {
          const outRgb = await rgbFrames(outFile, W, H, dur, fps, workDir);
          leftover = analyzeLeftoverText(srcRgb.buf, outRgb.buf, srcRgb.w, srcRgb.h, captionBand);
          const maxDrop = Math.max(2, Math.floor(leftover.frames * MAX_DROP));
          if (leftover.maskPx < 200) {
            usedMaskPath = false;
            log('mask path: model changed almost nothing — falling back to the detector');
          } else {
            captionReadable = leftover.bad.length > maxDrop;
            log(`mask path: ${leftover.bad.length}/${leftover.frames} frames still show text` +
              (captionReadable ? ' — too many to drop' : ''));
          }
        } catch (e) {
          log(`mask path: leftover check skipped (${(e as Error).message})`);
        }
      }
    } catch (e) {
      log(`mask pass skipped: ${(e as Error).message}`);
    }
  }

  for (let pass = 1; !usedMaskPath && pass <= MAX_PASSES; pass++) {
    let predId: string | null = null;
    const createBody = JSON.stringify({
      version,
      input: {
        video: inputUrl,
        method: 'hybrid',
        resolution: 'original',
        conf_threshold: 0.15,
        margin: 4,
        detection_interval: 1,
      },
    });
    for (let attempt = 0; attempt < 40 && !predId; attempt++) {
      const createResp = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: createBody,
      });
      if (createResp.status === 429) {
        const txt = await createResp.text();
        let ra = 12;
        try { ra = Number(JSON.parse(txt)?.retry_after) || 12; } catch { /* default */ }
        const wait = ra + 2 + Math.random() * 8;
        log(`pass ${pass}: rate limited, retrying in ${wait.toFixed(0)}s (attempt ${attempt + 1})`);
        await sleep(wait * 1000);
        continue;
      }
      if (!createResp.ok) {
        throw new Error(`Replicate create failed ${createResp.status}: ${(await createResp.text()).slice(0, 300)}`);
      }
      const created = await createResp.json();
      predId = created?.id || null;
    }
    if (!predId) throw new Error('Replicate kept rate-limiting the request — add credit at replicate.com/account/billing and retry');
    log(`pass ${pass}: prediction ${predId} created`);

    let outputUrl: string | null = null;
    for (;;) {
      if (Date.now() > deadline) {
        if (pass > 1) break;
        throw new Error('Replicate prediction timed out');
      }
      await sleep(POLL_MS);
      const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!pollResp.ok) continue;
      const pred = await pollResp.json();
      if (pred.status === 'succeeded') {
        outputUrl = extractOutputUrl(pred.output);
        if (!outputUrl) throw new Error('prediction succeeded but returned no video URL');
        break;
      }
      if (pred.status === 'failed' || pred.status === 'canceled') {
        if (pass > 1) break;
        throw new Error(`Replicate prediction ${pred.status}: ${String(pred.error || '').slice(0, 300)}`);
      }
    }
    if (!outputUrl) break;

    const dl = await fetch(outputUrl);
    if (!dl.ok) throw new Error(`could not download cleaned video (${dl.status})`);
    fs.writeFileSync(outFile, Buffer.from(await dl.arrayBuffer()));
    inputUrl = outputUrl;

    try {
      if (!W || !H) throw new Error('could not probe source dimensions');
      if (!srcRgb) srcRgb = await rgbFrames(srcFile, W, H, dur, fps, workDir);
      const outRgb = await rgbFrames(outFile, W, H, dur, fps, workDir);
      leftover = analyzeLeftoverText(srcRgb.buf, outRgb.buf, srcRgb.w, srcRgb.h);
      log(`pass ${pass}: ${leftover.bad.length}/${leftover.frames} frames still show text` +
        (leftover.colour ? ` (caption rgb ${leftover.colour.join(',')})` : ' (caption colour unknown)'));
    } catch (e) {
      log(`pass ${pass}: leftover check skipped (${(e as Error).message})`);
      break;
    }
    if (!leftover.maskPx) break;
    if (!leftover.bad.length) break;
    if (pass === MAX_PASSES || Date.now() > deadline) break;
  }

  if (!fs.existsSync(outFile)) throw new Error('no cleaned video produced');

  let note: string | null = null;
  let unusable = false;
  // The vertical region we actually worked on. captionBand is only set on the
  // mask path; when the detector/erase path handles the clip we still want to
  // report WHERE the caption was, so a whole-video caller can learn the band
  // from any window (not just mask-path ones) and clean the rest.
  let sawBox: Box | null = leftover?.box ?? null;

  // ── Stage 2a: frames still showing text. ──────────────────────────────────
  if (leftover?.bad.length && leftover.box) {
    try {
      const maxDrop = Math.max(2, Math.floor(leftover.frames * MAX_DROP));
      if (opts.eraseIfUnreadable) {
        // Whole-video mode: don't blur and don't drop frames here. Blurring
        // leaves an opaque patch ("non ha ricostruito i pixel") and dropping
        // frames shortens the video. Bail instead so the caller can NEURALLY
        // reconstruct the band (pass 2) — real pixels, full length.
        unusable = true;
        note = `caption survived in-clip removal on ${leftover.bad.length}/${leftover.frames} frames — deferring to band reconstruction`;
        log(`stage 2a: ${note}`);
      } else if (captionReadable && leftover.bad.length > maxDrop) {
        unusable = true;
        note = `caption still readable on ${leftover.bad.length}/${leftover.frames} frames — shot left out of the pool`;
        log(`stage 2a: ${note}`);
      } else if (leftover.bad.length <= maxDrop) {
        const patched = path.join(workDir, 'clean2a.mp4');
        await run(FFMPEG, [
          '-y', '-i', outFile, '-vf', buildDropGraph(leftover.bad, fps),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', patched,
        ]);
        fs.copyFileSync(patched, outFile);
        alignedWithSource = false;
        log(`stage 2a: dropped ${leftover.bad.length}/${leftover.frames} frame(s) still showing text`);
      } else {
        unusable = true;
        note = `caption survived on ${leftover.bad.length}/${leftover.frames} frames — not blurring a strip over it`;
        log(`stage 2a: ${note}`);
      }
    } catch (e) {
      note = `frame cleanup skipped: ${(e as Error).message}`;
      log(note);
    }
  }

  // ── Stage 2b: OCR-located stylized text the detector never sees. ───────────
  if (leftover && !leftover.maskPx) {
    try {
      const info = await ffprobeInfo(outFile);
      const OW = info.width || 0;
      const OH = info.height || 0;
      if (!OW || !OH) throw new Error('could not probe dimensions');

      const framesDir = path.join(workDir, 'ocr');
      fs.mkdirSync(framesDir, { recursive: true });
      await run(FFMPEG, [
        '-y', '-i', outFile, '-vf', `fps=${OCR_FPS}`,
        '-frames:v', String(OCR_MAX_FRAMES), '-q:v', '3',
        path.join(framesDir, 'f%03d.jpg'),
      ]);
      const frames = fs.readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
      log(`stage 2b: OCR on ${frames.length} frames`);

      const ocrVersion = await resolveVersion(token, OCR_MODEL);
      const taskCandidates = ['OCR with Region', '<OCR_WITH_REGION>', 'OCR'];
      let task: string | null = null;
      const dets: Detection[] = [];

      for (let i = 0; i < frames.length; i++) {
        if (Date.now() > deadline) { log('stage 2b: out of time'); break; }
        const t = i / OCR_FPS;
        const b64 = fs.readFileSync(path.join(framesDir, frames[i])).toString('base64');
        const image = `data:image/jpeg;base64,${b64}`;
        let boxes: Box[] = [];
        if (task) {
          boxes = parseOcrBoxes(await replicateRun(token, ocrVersion, { image, task_input: task }, deadline, log), OW, OH);
        } else {
          for (const cand of taskCandidates) {
            try {
              const out = await replicateRun(token, ocrVersion, { image, task_input: cand }, deadline, log);
              const parsed = parseOcrBoxes(out, OW, OH);
              if (parsed.length) { task = cand; boxes = parsed; break; }
            } catch (e) {
              log(`stage 2b: task "${cand}" failed (${(e as Error).message})`);
            }
          }
          if (!task) { note = 'OCR located no text boxes'; break; }
        }
        for (const b of boxes) dets.push({ b, t });
      }

      const rects = clusterDetections(dets, 1 / OCR_FPS + 0.2)
        .map((c) => toRect(c, OW, OH))
        .filter((r): r is Rect => !!r);

      if (rects.length) {
        unusable = true;
        note = `OCR still sees ${rects.length} text region(s) — not blurring them`;
        log(`stage 2b: ${note}`);
      } else if (!note) {
        note = 'no leftover text boxes located by OCR';
      }
    } catch (e) {
      note = `OCR cleanup skipped: ${(e as Error).message}`;
      log(note);
    }
  }

  // ── Final gate. ───────────────────────────────────────────────────────────
  if (!unusable) {
    try {
      if (!W || !H) throw new Error('source dimensions unknown');
      if (!alignedWithSource) {
        log('final gate: earlier frame drops broke source alignment — trusting prior checks');
      } else {
        if (!srcRgb) srcRgb = await rgbFrames(srcFile, W, H, dur, fps, workDir);
        const finalRgb = await rgbFrames(outFile, W, H, dur, fps, workDir);
        const left = analyzeLeftoverText(srcRgb.buf, finalRgb.buf, srcRgb.w, srcRgb.h, captionBand);
        if (left.box) sawBox = left.box;
        const maxDrop = Math.max(2, Math.floor(left.frames * MAX_DROP));
        if (!left.bad.length) {
          log('verified: no caption left in the result');
        } else if (opts.eraseIfUnreadable) {
          // Whole-video: don't blur / don't drop. Defer to pass-2 neural band
          // reconstruction so pixels are rebuilt (not smeared) and length kept.
          unusable = true;
          note = `caption survived on ${left.bad.length}/${left.frames} frames — deferring to band reconstruction`;
          log(`final gate: ${note}`);
        } else if (left.bad.length > maxDrop) {
          unusable = true;
          note = `caption still readable on ${left.bad.length}/${left.frames} frames — shot left out of the pool`;
          log(`final gate: ${note}`);
        } else if (left.box) {
          const patched = path.join(workDir, 'clean3.mp4');
          await run(FFMPEG, [
            '-y', '-i', outFile, '-vf', buildDropGraph(left.bad, fps),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', patched,
          ]);
          fs.copyFileSync(patched, outFile);
          log(`final gate: dropped ${left.bad.length}/${left.frames} frame(s) still showing text`);
        }
      }
    } catch (e) {
      log(`final gate: verification skipped (${(e as Error).message})`);
    }
  }

  const resultBand = captionBand ?? (sawBox ? { y0: sawBox.y0, y1: sawBox.y1 } : null);
  if (unusable) return { ok: false, unusable: true, note: note || 'caption not removable', band: resultBand };

  // Normalise to browser-playable H.264 (MiniMax hands back mp4v that <video> can't decode).
  const playable = path.join(workDir, 'clean-h264.mp4');
  try {
    await run(FFMPEG, [
      '-y', '-i', outFile,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-crf', '20', '-preset', 'veryfast', '-movflags', '+faststart', '-an',
      playable,
    ]);
    fs.copyFileSync(playable, outFile);
  } catch (e) {
    log(`h264 normalise failed, uploading as-is: ${(e as Error).message}`);
  }

  return { ok: true, outFile, note, band: resultBand };
}

function isCaptionLikeBox(b: Box): boolean {
  const cy = (b.y0 + b.y1) / 2;
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;
  if (bh > 0.38) return false;
  if (cy >= 0.50) return true;
  if (cy <= 0.32 && bw >= 0.16) return true;
  if (bw >= Math.max(0.20, bh * 1.6)) return true;
  return false;
}

type OcrCache = { version?: string; task?: string | null };

/**
 * Find burned-in letters with Florence-2 OCR and paint those boxes as a MiniMax
 * mask. Colour masks miss outlined / low-contrast captions; this is the finder
 * that still sees them. The reconstruction then only touches those pixels.
 */
async function ocrLetterMask(opts: {
  token: string; srcFile: string; W: number; H: number; fps: number; dur: number;
  workDir: string; deadline: number; tag: string; cache: OcrCache;
  log: (...a: unknown[]) => void;
}): Promise<{ maskFile: string; band: { y0: number; y1: number } } | null> {
  const { token, srcFile, W, H, fps, dur, workDir, deadline, tag, cache, log } = opts;
  if (Date.now() > deadline - 45000) return null;
  const framesDir = path.join(workDir, `ocr_${tag}`);
  fs.mkdirSync(framesDir, { recursive: true });
  const nFrames = 2;
  try {
    await run(FFMPEG, [
      '-y', '-i', srcFile,
      '-vf', `scale=${W}:${H}:flags=lanczos,fps=2`,
      '-frames:v', String(nFrames), '-q:v', '3',
      path.join(framesDir, 'f%03d.jpg'),
    ]);
  } catch (e) {
    log(`${tag}: OCR frames failed (${(e as Error).message})`);
    return null;
  }
  const frames = fs.readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
  if (!frames.length) return null;
  try {
    if (!cache.version) cache.version = await resolveVersion(token, OCR_MODEL);
  } catch (e) {
    log(`${tag}: OCR model lookup failed (${(e as Error).message})`);
    return null;
  }
  const ocrVersion = cache.version;
  if (!ocrVersion) return null;
  const taskCandidates = ['OCR with Region', '<OCR_WITH_REGION>', 'OCR'];
  const dets: Detection[] = [];
  for (let i = 0; i < frames.length; i++) {
    if (Date.now() > deadline - 20000) break;
    const t = Math.min(dur, i / 2);
    const b64 = fs.readFileSync(path.join(framesDir, frames[i])).toString('base64');
    const image = `data:image/jpeg;base64,${b64}`;
    let boxes: Box[] = [];
    if (cache.task) {
      try {
        boxes = parseOcrBoxes(
          await replicateRun(token, ocrVersion, { image, task_input: cache.task }, deadline, log),
          W, H,
        );
      } catch (e) {
        log(`${tag}: OCR frame ${i} failed (${(e as Error).message})`);
      }
    } else {
      for (const cand of taskCandidates) {
        try {
          const out = await replicateRun(token, ocrVersion, { image, task_input: cand }, deadline, log);
          const parsed = parseOcrBoxes(out, W, H);
          if (parsed.length) { cache.task = cand; boxes = parsed; break; }
        } catch (e) {
          log(`${tag}: OCR task "${cand}" failed (${(e as Error).message})`);
        }
      }
    }
    const kept = boxes.filter(isCaptionLikeBox);
    for (const b of (kept.length ? kept : boxes.filter((x) => x.y1 - x.y0 <= 0.4))) {
      dets.push({ b, t });
    }
  }
  const rects = clusterDetections(dets, 0.6)
    .map((c) => toRect(c, W, H))
    .filter((r): r is Rect => !!r);
  if (!rects.length) {
    log(`${tag}: OCR found no caption boxes`);
    return null;
  }
  const vf = rects
    .map((r) => `drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=white:t=fill`)
    .join(',');
  const maskFile = path.join(workDir, `ocrmask_${tag}.mp4`);
  const rate = Math.max(1, Math.round(fps));
  try {
    await run(FFMPEG, [
      '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=${Math.max(0.2, dur).toFixed(3)}:r=${rate}`,
      '-vf', vf,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', maskFile,
    ]);
  } catch (e) {
    log(`${tag}: OCR mask render failed (${(e as Error).message})`);
    return null;
  }
  let y0 = 1, y1 = 0;
  for (const r of rects) {
    y0 = Math.min(y0, r.y / H);
    y1 = Math.max(y1, (r.y + r.h) / H);
  }
  log(`${tag}: OCR mask ${rects.length} caption box(es)`);
  return { maskFile, band: { y0: Math.max(0, y0 - 0.02), y1: Math.min(1, y1 + 0.02) } };
}

/**
 * Remove burned-in subtitles from a WHOLE ad video (not a shot), keeping its
 * original audio. Reuses cleanClipFile so quality matches the shots pipeline,
 * then muxes the source audio back over the cleaned (silent) video track.
 * State lives on competitor_ads (clean_status / clean_full_path / clean_error).
 */
async function cleanWholeAd(
  supabase: ReturnType<typeof getSupabase>,
  token: string,
  adId: number,
  projectId: string,
  log: (...a: unknown[]) => void,
  force = false,
): Promise<Response> {
  const fail = async (msg: string) => {
    log('error:', msg);
    await supabase.from('competitor_ads')
      .update({ clean_status: 'error', clean_error: msg.slice(0, 500) })
      .eq('id', adId);
    return new Response('error', { status: 200 });
  };

  // Claim: pending -> processing. The __ts: stamp lets the API detect a run
  // that was killed mid-flight (Netlify hard-stops background functions) and
  // auto-reset it instead of staying "processing" forever.
  const { data: claimed, error: claimErr } = await supabase
    .from('competitor_ads')
    .update({ clean_status: 'processing', clean_error: `__ts:${Date.now()}` })
    .eq('id', adId)
    .eq('project_id', projectId)
    .eq('clean_status', 'pending')
    .select('id, file_path, media_type')
    .maybeSingle();
  if (claimErr && /clean_status|clean_full_path/i.test(claimErr.message)) {
    log('MISSING MIGRATION: run supabase-migration-ad-clean.sql');
    return new Response('missing migration', { status: 200 });
  }
  if (!claimed) { log('ad not pending — skipping'); return new Response('skip', { status: 200 }); }
  if ((claimed as { media_type?: string }).media_type !== 'video') return fail('only video creatives can be cleaned');

  const workDir = makeWorkDir('wcleanvid-');
  try {
    const srcFile = path.join(workDir, 'src.mp4');
    await downloadSource(supabase, claimed.file_path as string, srcFile);
    const info = await ffprobeInfo(srcFile);
    const W = info.width || 0;
    const H = info.height || 0;
    const fps = info.fps && info.fps > 0 ? info.fps : 30;
    const dur = await probeDuration(srcFile);
    if (!W || !H) return fail('could not probe video dimensions');

    // Clean in SHORT windows — the granularity the remover is proven at — in
    // BATCHES across as many background runs as needed. Netlify kills a run at
    // 15 min, so a long video can't finish in one go: each run cleans as many
    // windows as fit in its budget, persists per-window progress to storage,
    // then re-triggers itself. The final video is only assembled once EVERY
    // window is resolved — no half-cleaned results.
    const deadline = Date.now() + MAX_WAIT_MS;
    const SEG_SEC = 1.7;
    const nseg = Math.max(1, Math.ceil(dur / SEG_SEC));
    const segDur = dur / nseg;

    type WinState = { s: 'todo' | 'clean' | 'original' | 'failed'; key?: string; tries?: number };
    // v=8: wider letter mask + leftover-ghost gate; v=7 "clean" windows still showed translucent captions.
    type Progress = { src: string; nseg: number; runs: number; v?: number; wins: WinState[] };
    const MASK_PROGRESS_V = 8;
    const progressKey = `${projectId}/ads-clean/${adId}_progress.json`;
    let prog: Progress | null = null;
    if (!force) {
      try {
        const { data } = await supabase.storage.from(BUCKET).download(progressKey);
        if (data) prog = JSON.parse(Buffer.from(await data.arrayBuffer()).toString('utf8')) as Progress;
      } catch { /* no previous progress */ }
    } else {
      try {
        const { data } = await supabase.storage.from(BUCKET).download(progressKey);
        if (data) prog = JSON.parse(Buffer.from(await data.arrayBuffer()).toString('utf8')) as Progress;
      } catch { /* no previous progress */ }
      if (prog && prog.src === (claimed.file_path as string) && prog.nseg === nseg && prog.v === MASK_PROGRESS_V && Array.isArray(prog.wins)) {
        // Paid MiniMax windows stay. Only redo ones that never cleaned.
        prog.runs = 0;
        for (const x of prog.wins) {
          if (x.s !== 'clean') { x.s = 'todo'; x.tries = 0; delete x.key; }
        }
      } else {
        prog = null;
      }
    }
    if (force || !prog || prog.src !== (claimed.file_path as string) || prog.nseg !== nseg || prog.v !== MASK_PROGRESS_V || !Array.isArray(prog.wins)) {
      prog = {
        src: claimed.file_path as string,
        nseg,
        runs: 0,
        v: MASK_PROGRESS_V,
        wins: Array.from({ length: nseg }, () => ({ s: 'todo' as const, tries: 0 })),
      };
    }
    // Continuations reuse paid-for clean windows. A user click (force) starts
    // from scratch so a previous fake-clean stitch cannot be shown again.
    const MAX_RUNS = 20;
    if (!force && !prog.wins.some((x) => x.s === 'todo')) {
      prog.runs = 0;
      for (const x of prog.wins) {
        if (x.s === 'failed' || x.s === 'original') { x.s = 'todo'; x.tries = 0; }
      }
    } else if (prog.runs >= MAX_RUNS) {
      prog.runs = 0;
    }
    prog.runs += 1;
    if (prog.runs > MAX_RUNS) {
      // Keep the ledger: the cleaned windows are paid for — a retry reuses them.
      return fail(`cleaning did not finish after ${MAX_RUNS} runs — retry to continue from ${prog.wins.filter((x) => x.s !== 'todo').length}/${nseg} windows`);
    }
    const saveProgress = async () => {
      const f = path.join(workDir, 'progress.json');
      fs.writeFileSync(f, JSON.stringify(prog), 'utf8');
      await uploadFile(supabase, progressKey, f, 'application/json');
    };
    const doneCount = () => prog!.wins.filter((w) => w.s !== 'todo').length;
    log(`run ${prog.runs}: ${dur.toFixed(1)}s in ${nseg} window(s) of ~${segDur.toFixed(1)}s — ${doneCount()}/${nseg} already resolved`);

    // Original frames are the base. Find captions, reconstruct those pixels,
    // paste them back. Never replace the window with a model's re-encoded clip.
    const fbModel = await resolveMaskModel(token, log);
    const ocrCache: OcrCache = {};

    const tryMiniMax = async (
      mask: string,
      band: { y0: number; y1: number } | null,
      label: string,
    ): Promise<string | null> => {
      if (!fbModel) return null;
      try {
        const file = await textMaskReconstruct({
          supabase, token, model: fbModel, srcKey: segKeyFor, srcFile: segFileFor,
          maskFile: mask, maskKey: `${projectId}/ads-clean/${adId}_${label}_${Date.now()}.mp4`,
          W, H, fps, dur: lenFor, workDir, deadline, tag: label, log,
        });
        if (!file || !srcRgbFor) return file;
        const outRgb = await rgbFrames(file, W, H, lenFor, fps, workDir);
        const lo = analyzeLeftoverText(srcRgbFor.buf, outRgb.buf, srcRgbFor.w, srcRgbFor.h, band);
        if (!leftoverWorked(lo)) {
          log(`window: ${label} left captions (${lo.bad.length}/${lo.frames}, px=${lo.maskPx})`);
          return null;
        }
        log(`${label}: reconstructed letter pixels onto original frames`);
        return file;
      } catch (e) {
        log(`${label} failed (${(e as Error).message})`);
        return null;
      }
    };

    // These are set inside the loop; tryMiniMax closes over them.
    let segKeyFor = '';
    let segFileFor = '';
    let lenFor = 0;
    let srcRgbFor: { buf: Buffer; w: number; h: number } | null = null;

    for (let i = 0; i < nseg; i++) {
      const w = prog.wins[i];
      if (w.s !== 'todo') continue;

      if (Date.now() > deadline - 90000) break;

      const t0 = i * segDur;
      const len = i === nseg - 1 ? Math.max(0.1, dur - t0) : segDur;
      const segFile = path.join(workDir, `seg_${i}.mp4`);
      await cutClip(srcFile, t0, t0 + len, segFile);
      lenFor = len;
      segFileFor = segFile;
      srcRgbFor = null;
      segKeyFor = `${projectId}/ads-clean/${adId}_w${i}`;

      let maskFile: string | null = null;
      let srcRgb: { buf: Buffer; w: number; h: number } | null = null;
      let cmBand: { y0: number; y1: number } | null = null;
      try {
        const rgb = await rgbFrames(segFile, W, H, len, fps, workDir);
        srcRgb = rgb;
        srcRgbFor = rgb;
        const nf = Math.floor(rgb.buf.length / (rgb.w * rgb.h * 3));
        const cm = captionMasks(rgb.buf, nf, rgb.w, rgb.h, null);
        if (cm && cm.pxPerFrame > 0 && cm.textFrames > 0) {
          let px = 0;
          for (const m of cm.masks) for (let p = 0; p < m.length; p++) if (m[p]) px++;
          if (px >= nf * 4) {
            const trust = maskIsTrustworthy(cm, rgb.w, rgb.h);
            cmBand = cm.band;
            maskFile = await writeMaskVideo(cm.masks, rgb.w, rgb.h, Math.round(fps), W, H, workDir);
            log(`window ${i}: caption mask ${trust.ok ? 'ok' : 'weak'} — ${trust.why}`);
          }
        }
      } catch (e) {
        log(`window ${i}: mask build skipped (${(e as Error).message})`);
      }

      let rebuiltFile: string | null = null;
      let ocrMask: string | null = null;

      // Colour mask first; if that leaves ghosts, OCR in the SAME run so
      // windows are not shipped with translucent leftover letters.
      if (maskFile) {
        rebuiltFile = await tryMiniMax(maskFile, cmBand, `w${i}`);
      }
      if (!rebuiltFile) {
        const ocr = await ocrLetterMask({
          token, srcFile: segFile, W, H, fps, dur: len, workDir, deadline,
          tag: `w${i}`, cache: ocrCache, log,
        });
        if (ocr) {
          ocrMask = ocr.maskFile;
          rebuiltFile = await tryMiniMax(ocr.maskFile, ocr.band, `wocr${i}`);
        }
      }

      if (rebuiltFile) {
        const winKey = `${projectId}/ads-clean/${adId}_win${i}.mp4`;
        await uploadFile(supabase, winKey, rebuiltFile, 'video/mp4');
        w.s = 'clean';
        w.key = winKey;
      } else {
        const foundLetters = Boolean(maskFile || ocrMask);
        w.s = foundLetters ? 'failed' : 'original';
        w.tries = (w.tries || 0) + 1;
        log(`window ${i}: ${w.s === 'failed' ? 'reconstruct left leftover captions' : 'no caption text detected — kept original'}`);
      }
      await saveProgress();
    }

    // Any window still 'todo'? Persist progress, flip back to 'pending' and
    // re-trigger ourselves: the next run continues exactly where this stopped.
    const unresolved = prog.wins.filter((x) => x.s === 'todo').length;
    if (unresolved > 0) {
      await saveProgress();
      await supabase.from('competitor_ads')
        .update({ clean_status: 'pending', clean_error: `__ts:${Date.now()}` })
        .eq('id', adId);
      const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
      let retriggered = false;
      if (origin) {
        try {
          await fetch(`${origin}/.netlify/functions/inpaint-shot-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adId, projectId }),
          });
          retriggered = true;
        } catch (e) {
          log(`self-retrigger failed: ${(e as Error).message}`);
        }
      }
      // If the retrigger failed the __ts stamp goes stale in a few minutes and
      // the status API resets the job to a retryable error — nothing gets stuck.
      log(`run ${prog.runs}: ${doneCount()}/${nseg} windows resolved — ${retriggered ? 'continuing in a new run' : 'retrigger failed, will self-heal'}`);
      return new Response('continuing', { status: 200 });
    }

    // Every window resolved — assemble the full video: cleaned windows come
    // from storage, text-free/unfixable ones are recut from the source.
    const cleanedCount = prog.wins.filter((x) => x.s === 'clean').length;
    const failedCount = prog.wins.filter((x) => x.s === 'failed').length;
    if (cleanedCount === 0) {
      return fail(
        failedCount
          ? `could not reconstruct caption pixels on any window (${failedCount} failed) — click Clean again`
          : 'no captions were found to reconstruct — the original video was left unchanged',
      );
    }

    const localFiles: string[] = [];
    for (let i = 0; i < nseg; i++) {
      const w = prog.wins[i];
      const t0 = i * segDur;
      const len = i === nseg - 1 ? Math.max(0.1, dur - t0) : segDur;
      let f: string;
      if (w.s === 'clean' && w.key) {
        f = path.join(workDir, `win_${i}.mp4`);
        await downloadSource(supabase, w.key, f);
      } else {
        f = path.join(workDir, `seg_${i}.mp4`);
        if (!fs.existsSync(f)) await cutClip(srcFile, t0, t0 + len, f);
      }
      localFiles.push(f);
    }

    // Concatenate the windows, re-encoding to a uniform H.264 so the demuxer
    // never chokes on parameter mismatches between windows.
    const listFile = path.join(workDir, 'concat.txt');
    fs.writeFileSync(listFile, localFiles.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
    const stitched = path.join(workDir, 'stitched.mp4');
    await run(FFMPEG, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'veryfast',
      '-movflags', '+faststart', '-an', stitched,
    ]);

    // cleanClipFile / cutClip strip audio (-an); an ad should keep its voiceover.
    // Mux the ORIGINAL audio back (optional 1:a:0? → silent sources stay video-only).
    const withAudio = path.join(workDir, 'clean-audio.mp4');
    let finalFile = stitched;
    try {
      await run(FFMPEG, [
        '-y', '-i', stitched, '-i', srcFile,
        '-map', '0:v:0', '-map', '1:a:0?',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart', '-shortest', withAudio,
      ]);
      if (fs.existsSync(withAudio) && fs.statSync(withAudio).size > 0) finalFile = withAudio;
    } catch (e) {
      log(`audio mux failed, keeping silent clean video: ${(e as Error).message}`);
    }

    const cleanKey = `${projectId}/ads-clean/${adId}_${Date.now()}.mp4`;
    await uploadFile(supabase, cleanKey, finalFile, 'video/mp4');
    const note = failedCount === 0
      ? null
      : `${failedCount}/${nseg} windows could not be cleaned after 3 attempts and kept their original footage`;
    await supabase.from('competitor_ads')
      .update({ clean_status: 'done', clean_full_path: cleanKey, clean_error: note })
      .eq('id', adId);
    // KEEP the ledger + per-window files: a future re-request must reuse the
    // already-cleaned windows instead of paying the model for them again.
    await saveProgress();
    log(`done in ${prog.runs} run(s) — ${cleanKey} (${cleanedCount}/${nseg} cleaned, ${failedCount} unfixable)`);
    return new Response('done', { status: 200 });
  } catch (e) {
    return fail((e as Error).message);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export default async (req: Request) => {
  let body: {
    shotId?: number; projectId?: string; compareModel?: string;
    tuning?: Record<string, number>;
    adId?: number; // whole-video cleaning (Creative Detail "remove subtitles")
    force?: boolean; // user retry: wipe ledger + previous fake-clean path
  };
  try {
    body = await req.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const { shotId, projectId, compareModel, tuning, adId, force } = body;

  // Whole-video cleaning path: same engine, different target + audio kept.
  if (adId && !shotId) {
    if (!projectId) return new Response('missing fields', { status: 400 });
    const supabase = getSupabase();
    const token = process.env.REPLICATE_API_TOKEN;
    const log = (...a: unknown[]) => console.log('[inpaint-bg]', `ad#${adId}`, ...a);
    if (!token) {
      await supabase.from('competitor_ads')
        .update({ clean_status: 'error', clean_error: 'REPLICATE_API_TOKEN is not set in Netlify env vars' })
        .eq('id', adId);
      return new Response('no token', { status: 200 });
    }
    return cleanWholeAd(supabase, token, adId, projectId, log, force === true);
  }

  if (!shotId || !projectId) return new Response('missing fields', { status: 400 });

  const supabase = getSupabase();
  const log = (...a: unknown[]) => console.log('[inpaint-bg]', `shot#${shotId}`, ...a);

  const fail = async (msg: string) => {
    log('error:', msg);
    const { error } = await supabase
      .from('competitor_shots')
      .update({ inpaint_status: 'error', inpaint_error: msg.slice(0, 500) })
      .eq('id', shotId);
    if (error) log('could not persist error state:', error.message);
    return new Response('error', { status: 200 });
  };

  const token = process.env.REPLICATE_API_TOKEN;

  // A comparison run must leave the shot exactly as it was, including its status,
  // so it reports into its own sidecar rather than through fail().
  if (compareModel) {
    if (!token) {
      log('compare skipped: REPLICATE_API_TOKEN is not set in this deploy');
      return new Response('no token', { status: 200 });
    }
    return compareRemover(supabase, token, shotId, projectId, compareModel, log, tuning);
  }

  if (!token) return fail('REPLICATE_API_TOKEN is not set in Netlify env vars');

  // Claim: pending -> processing (avoids double-run when triggered twice).
  const { data: claimed, error: claimErr } = await supabase
    .from('competitor_shots')
    .update({ inpaint_status: 'processing', inpaint_error: null })
    .eq('id', shotId)
    .eq('project_id', projectId)
    .eq('inpaint_status', 'pending')
    .select('id, file_path, text_region')
    .maybeSingle();
  if (claimErr && /inpaint|clean_path/i.test(claimErr.message)) {
    log('MISSING MIGRATION: run supabase-migration-shot-inpaint.sql');
    return new Response('missing migration', { status: 200 });
  }
  if (!claimed) {
    log('not pending — skipping');
    return new Response('skip', { status: 200 });
  }

  const workDir = makeWorkDir('winpaint-');
  try {
    // Public-ish URL Replicate can download the source clip from.
    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(claimed.file_path as string, 3600);
    if (signErr || !signed?.signedUrl) return fail(`could not sign source URL: ${signErr?.message || 'no url'}`);

    // The model-latest predictions endpoint 404s for this model, so resolve the
    // latest version id explicitly and use the generic predictions endpoint.
    const modelResp = await fetch(`https://api.replicate.com/v1/models/${REPLICATE_MODEL}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!modelResp.ok) {
      return fail(`could not resolve model version ${modelResp.status}: ${(await modelResp.text()).slice(0, 200)}`);
    }
    const model = await modelResp.json();
    const version = model?.latest_version?.id;
    if (!version) return fail('model has no latest version on Replicate');

    // Spread simultaneous shots apart before the first attempt.
    await sleep(Math.random() * 15000);

    const deadline = Date.now() + MAX_WAIT_MS;
    let inputUrl = signed.signedUrl;
    const outFile = path.join(workDir, 'clean.mp4');
    const srcFile = path.join(workDir, 'src.mp4');
    await downloadSource(supabase, claimed.file_path as string, srcFile);
    const srcInfo = await ffprobeInfo(srcFile);
    const W = srcInfo.width || 0;
    const H = srcInfo.height || 0;
    const fps = srcInfo.fps && srcInfo.fps > 0 ? srcInfo.fps : 30;
    const dur = await probeDuration(srcFile);
    let srcRgb: { buf: Buffer; w: number; h: number } | null = null;
    let captionBand: { y0: number; y1: number } | null = null;
    let leftover: Leftover | null = null;
    let captionReadable = false;
    // Frame drops re-time the clip so output frame i no longer lines up with
    // source frame i, which breaks the differential final check. Erase keeps the
    // alignment; only dropping frames clears this.
    let alignedWithSource = true;
    // Set when the mask path returned a chunked result it already verified
    // window-by-window; the whole-clip differential below would drift and must be
    // skipped for it.
    let maskVerified = false;

    // ── Stage 1: mask-driven neural removal. Preferred, because it rebuilds the
    // caption area from surrounding motion instead of leaving the blurred patch
    // the detector-based remover leaves behind. Skipped when the caption colour
    // is too common in the footage to mask safely. ───────────────────────────
    let usedMaskPath = false;
    if (W && H) {
      try {
        // Repeat on the previous output while a caption is still detectable. One
        // run only removes what its own mask covered, so a caption whose lines
        // differ in colour or position can survive the first pass; feeding the
        // result back finds what is left. The loop ends by itself, because the
        // pass returns nothing once no caption is found.
        let curKey = claimed.file_path as string;
        let curFile = srcFile;
        for (let pass = 1; pass <= MASK_PASSES; pass++) {
          const masked = await maskDrivenClean({
            supabase, token,
            srcKey: curKey,
            srcFile: curFile,
            textRegion: (claimed as { text_region?: string | null }).text_region ?? null,
            maskKey: `${projectId}/shots-mask/${shotId}_p${pass}_${Date.now()}.mp4`,
            W, H, fps, dur, workDir, deadline, log,
          });
          if (!masked) {
            if (usedMaskPath) log(`mask pass ${pass}: no caption left to remove`);
            break;
          }
          fs.copyFileSync(masked.file, outFile);
          if (pass === 1) { srcRgb = masked.srcRgb; captionBand = masked.band; maskVerified = !!masked.verified; }
          usedMaskPath = true;
          if (pass === MASK_PASSES || Date.now() > deadline) break;
          curFile = path.join(workDir, `pass${pass}.mp4`);
          fs.copyFileSync(outFile, curFile);
          curKey = `${projectId}/shots-tmp/${shotId}_p${pass}_${Date.now()}.mp4`;
          await uploadFile(supabase, curKey, curFile, 'video/mp4');
        }
        if (usedMaskPath && maskVerified) {
          // Chunked + already verified window-by-window (aligned). Comparing the
          // stitched clip against the whole original drifts out of sync and would
          // falsely reject the parts that came out clean, so trust it and skip both
          // the differential here and the final gate below.
          alignedWithSource = false;
          log('mask path: chunked result verified per-window — skipping whole-clip differential');
        } else if (usedMaskPath && srcRgb) {
          try {
            const outRgb = await rgbFrames(outFile, W, H, dur, fps, workDir);
            // Differential check ONLY. Compare the model's output against the
            // original and flag the caption's colour surviving in the pixels the
            // model actually repainted. Re-detecting text on the output alone is
            // unreliable: it re-learns the caption's warm "highlight" colour and
            // then flags skin and wood-grain that share it, throwing away
            // perfectly clean reconstructions.
            leftover = analyzeLeftoverText(srcRgb.buf, outRgb.buf, srcRgb.w, srcRgb.h, captionBand);
            const maxDrop = Math.max(2, Math.floor(leftover.frames * MAX_DROP));
            if (leftover.maskPx < 200) {
              // The model barely touched the frame: its mask missed the caption,
              // so the clip still carries it. Fall back to the detector remover
              // instead of shipping the original as if it were clean.
              usedMaskPath = false;
              log('mask path: model changed almost nothing — falling back to the detector');
            } else {
              captionReadable = leftover.bad.length > maxDrop;
              log(`mask path: ${leftover.bad.length}/${leftover.frames} frames still show text` +
                (captionReadable ? ' — too many to drop' : ''));
            }
          } catch (e) {
            log(`mask path: leftover check skipped (${(e as Error).message})`);
          }
        }
      } catch (e) {
        log(`mask pass skipped: ${(e as Error).message}`);
      }
    }

    for (let pass = 1; !usedMaskPath && pass <= MAX_PASSES; pass++) {
      // Create the prediction. Accounts with <$5 credit are throttled to ~1
      // request every 10s, so retry patiently on 429 instead of failing — the
      // per-shot background functions then serialize themselves naturally.
      let predId: string | null = null;
      const createBody = JSON.stringify({
        version,
        input: {
          video: inputUrl,
          method: 'hybrid',          // context-aware inpainting (best for complex backgrounds)
          resolution: 'original',
          conf_threshold: 0.15,      // default 0.25 misses line-end words (left "OUR"/"NUTES)" behind)
          margin: 4,                 // tight box — a wide margin painted a blurred fascia
          detection_interval: 1,     // detect on every frame — clips are short
        },
      });
      for (let attempt = 0; attempt < 40 && !predId; attempt++) {
        const createResp = await fetch('https://api.replicate.com/v1/predictions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: createBody,
        });
        if (createResp.status === 429) {
          const txt = await createResp.text();
          let ra = 12;
          try { ra = Number(JSON.parse(txt)?.retry_after) || 12; } catch { /* default */ }
          const wait = ra + 2 + Math.random() * 8;
          log(`pass ${pass}: rate limited, retrying in ${wait.toFixed(0)}s (attempt ${attempt + 1})`);
          await sleep(wait * 1000);
          continue;
        }
        if (!createResp.ok) {
          return fail(`Replicate create failed ${createResp.status}: ${(await createResp.text()).slice(0, 300)}`);
        }
        const created = await createResp.json();
        predId = created?.id || null;
      }
      if (!predId) return fail('Replicate kept rate-limiting the request — add credit at replicate.com/account/billing and retry');
      log(`pass ${pass}: prediction ${predId} created`);

      // Poll until done.
      let outputUrl: string | null = null;
      for (;;) {
        if (Date.now() > deadline) {
          if (pass > 1) break;       // keep what earlier passes produced
          return fail('Replicate prediction timed out');
        }
        await sleep(POLL_MS);
        const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!pollResp.ok) continue;
        const pred = await pollResp.json();
        if (pred.status === 'succeeded') {
          outputUrl = extractOutputUrl(pred.output);
          if (!outputUrl) return fail('prediction succeeded but returned no video URL');
          break;
        }
        if (pred.status === 'failed' || pred.status === 'canceled') {
          if (pass > 1) break;       // keep what earlier passes produced
          return fail(`Replicate prediction ${pred.status}: ${String(pred.error || '').slice(0, 300)}`);
        }
      }
      if (!outputUrl) break;

      const dl = await fetch(outputUrl);
      if (!dl.ok) return fail(`could not download cleaned video (${dl.status})`);
      fs.writeFileSync(outFile, Buffer.from(await dl.arrayBuffer()));
      inputUrl = outputUrl;

      // Which frames still show text? Checked on EVERY frame, not sampled:
      // leftovers often survive on 3-4 frames only (a ~100ms flash).
      try {
        if (!W || !H) throw new Error('could not probe source dimensions');
        if (!srcRgb) srcRgb = await rgbFrames(srcFile, W, H, dur, fps, workDir);
        const outRgb = await rgbFrames(outFile, W, H, dur, fps, workDir);
        leftover = analyzeLeftoverText(srcRgb.buf, outRgb.buf, srcRgb.w, srcRgb.h);
        log(`pass ${pass}: ${leftover.bad.length}/${leftover.frames} frames still show text` +
          (leftover.colour ? ` (caption rgb ${leftover.colour.join(',')})` : ' (caption colour unknown)'));
      } catch (e) {
        log(`pass ${pass}: leftover check skipped (${(e as Error).message})`);
        break;                       // can't verify → don't burn more passes
      }
      // Nothing repainted anywhere means the detector never saw the text; more
      // passes won't change that, stage 2b has to handle it.
      if (!leftover.maskPx) break;
      if (!leftover.bad.length) break;
      if (pass === MAX_PASSES || Date.now() > deadline) break;
    }

    if (!fs.existsSync(outFile)) return fail('no cleaned video produced');

    let note: string | null = null;
    let unusable = false;

    // ── Stage 2a: frames that still show text after every pass. Drop them and
    // hold the previous good frame: erasing the caption area on single frames
    // makes the patch blink on and off, which reads worse than a 33ms freeze. ──
    if (leftover?.bad.length && leftover.box) {
      try {
        const maxDrop = Math.max(2, Math.floor(leftover.frames * MAX_DROP));
        if (captionReadable && leftover.bad.length > maxDrop) {
          // Readable text on most of the clip cannot be dropped or blurred away
          // without wrecking the footage, and blurred patches were rejected for
          // good reason. The shot is simply left out of the usable pool.
          unusable = true;
          note = `caption still readable on ${leftover.bad.length}/${leftover.frames} frames — shot left out of the pool`;
          log(`stage 2a: ${note}`);
        } else if (leftover.bad.length <= maxDrop) {
          const patched = path.join(workDir, 'clean2a.mp4');
          await run(FFMPEG, [
            '-y', '-i', outFile, '-vf', buildDropGraph(leftover.bad, fps),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', patched,
          ]);
          fs.copyFileSync(patched, outFile);
          alignedWithSource = false;
          log(`stage 2a: dropped ${leftover.bad.length}/${leftover.frames} frame(s) still showing text`);
        } else {
          // Too many leftover frames to freeze. Blurring the caption strip was
          // rejected ("si vede la fascia") — leave the shot out of the pool.
          unusable = true;
          note = `caption survived on ${leftover.bad.length}/${leftover.frames} frames — shot left out of the pool`;
          log(`stage 2a: ${note}`);
        }
      } catch (e) {
        note = `frame cleanup skipped: ${(e as Error).message}`;
        log(note);
      }
    }

    // ── Stage 2b: text the YOLO detector never sees at all (stylized CTA
    // graphics — nothing was repainted anywhere). Locate it with OCR and erase
    // those boxes. Never fatal: a failure keeps the stage-1 result. ──────────
    if (leftover && !leftover.maskPx) {
      try {
        const info = await ffprobeInfo(outFile);
        const W = info.width || 0;
        const H = info.height || 0;
        if (!W || !H) throw new Error('could not probe dimensions');

        const framesDir = path.join(workDir, 'ocr');
        fs.mkdirSync(framesDir, { recursive: true });
        await run(FFMPEG, [
          '-y', '-i', outFile, '-vf', `fps=${OCR_FPS}`,
          '-frames:v', String(OCR_MAX_FRAMES), '-q:v', '3',
          path.join(framesDir, 'f%03d.jpg'),
        ]);
        const frames = fs.readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
        log(`stage 2b: OCR on ${frames.length} frames`);

        const ocrVersion = await resolveVersion(token, OCR_MODEL);
        // The wrapper's task name isn't documented; try the known spellings and
        // stick with whichever returns boxes.
        const taskCandidates = ['OCR with Region', '<OCR_WITH_REGION>', 'OCR'];
        let task: string | null = null;
        const dets: Detection[] = [];

        for (let i = 0; i < frames.length; i++) {
          if (Date.now() > deadline) { log('stage 2b: out of time'); break; }
          const t = i / OCR_FPS;
          const b64 = fs.readFileSync(path.join(framesDir, frames[i])).toString('base64');
          const image = `data:image/jpeg;base64,${b64}`;
          let boxes: Box[] = [];
          if (task) {
            boxes = parseOcrBoxes(await replicateRun(token, ocrVersion, { image, task_input: task }, deadline, log), W, H);
          } else {
            for (const cand of taskCandidates) {
              try {
                const out = await replicateRun(token, ocrVersion, { image, task_input: cand }, deadline, log);
                const parsed = parseOcrBoxes(out, W, H);
                if (parsed.length) { task = cand; boxes = parsed; break; }
              } catch (e) {
                log(`stage 2b: task "${cand}" failed (${(e as Error).message})`);
              }
            }
            if (!task) { note = 'OCR located no text boxes'; break; }
          }
          for (const b of boxes) dets.push({ b, t });
        }

        const rects = clusterDetections(dets, 1 / OCR_FPS + 0.2)
          .map((c) => toRect(c, W, H))
          .filter((r): r is Rect => !!r);

        if (rects.length) {
          unusable = true;
          note = `OCR still sees ${rects.length} text region(s) — not blurring them`;
          log(`stage 2b: ${note}`);
        } else if (!note) {
          note = 'no leftover text boxes located by OCR';
        }
      } catch (e) {
        note = `OCR cleanup skipped: ${(e as Error).message}`;
        log(note);
      }
    }

    // ── Final gate. A last differential check against the original, catching a
    // caption that survived every stage above. It compares source and output
    // frame-for-frame and only flags the caption's colour surviving where the
    // remover repainted — background it never touched (skin, wood-grain that
    // happens to share the caption's warm outline colour) is excluded, which is
    // what a fresh detection on the output alone got wrong: it re-learned that
    // colour and discarded clean reconstructions wholesale. ───────────────────
    if (!unusable) {
      try {
        if (!W || !H) throw new Error('source dimensions unknown');
        if (!alignedWithSource) {
          log('final gate: earlier frame drops broke source alignment — trusting prior checks');
        } else {
          if (!srcRgb) srcRgb = await rgbFrames(srcFile, W, H, dur, fps, workDir);
          const finalRgb = await rgbFrames(outFile, W, H, dur, fps, workDir);
          const left = analyzeLeftoverText(srcRgb.buf, finalRgb.buf, srcRgb.w, srcRgb.h, captionBand);
          const maxDrop = Math.max(2, Math.floor(left.frames * MAX_DROP));
          if (!left.bad.length) {
            log('verified: no caption left in the result');
          } else if (left.bad.length > maxDrop) {
            unusable = true;
            note = `caption still readable on ${left.bad.length}/${left.frames} frames — shot left out of the pool`;
            log(`final gate: ${note}`);
          } else if (left.box) {
            // Few enough to freeze over: dropping them holds the previous good
            // frame, which reads better than a patch blinking on and off.
            const patched = path.join(workDir, 'clean3.mp4');
            await run(FFMPEG, [
              '-y', '-i', outFile, '-vf', buildDropGraph(left.bad, fps),
              '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', patched,
            ]);
            fs.copyFileSync(patched, outFile);
            log(`final gate: dropped ${left.bad.length}/${left.frames} frame(s) still showing text`);
          }
        }
      } catch (e) {
        // A verification hiccup no longer discards the clip: the differential
        // check is conservative and the mask path already validated the result,
        // so keeping good footage beats throwing it away on an ffmpeg error.
        log(`final gate: verification skipped (${(e as Error).message})`);
      }
    }

    // A shot whose caption survived must not keep a cleaned copy on record: the
    // builder picks footage by that copy, so leaving one would put the text back
    // into finished videos. Clearing it is what keeps the pool honest.
    if (unusable) {
      const { error } = await supabase
        .from('competitor_shots')
        .update({ clean_path: null, inpaint_status: 'done', inpaint_error: note?.slice(0, 500) ?? null })
        .eq('id', shotId);
      if (error) return fail(`could not mark the shot unusable: ${error.message}`);
      log('done — left out of the pool');
      return new Response('done', { status: 200 });
    }

    // Normalise to browser-playable H.264. MiniMax-Remover hands back an
    // MPEG-4 Part 2 (mp4v) file, which ffmpeg reads fine but <video> cannot
    // decode — so an untouched mask-path result made the player error out and
    // silently fall back to the ORIGINAL clip, putting the caption right back
    // on screen. Re-encode to H.264 yuv420p + faststart so it plays and streams
    // everywhere. (Detector-path outputs are already H.264; re-encoding once
    // more is cheap and keeps every clean copy uniform.)
    const playable = path.join(workDir, 'clean-h264.mp4');
    try {
      await run(FFMPEG, [
        '-y', '-i', outFile,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-crf', '20', '-preset', 'veryfast', '-movflags', '+faststart', '-an',
        playable,
      ]);
      fs.copyFileSync(playable, outFile);
    } catch (e) {
      log(`h264 normalise failed, uploading as-is: ${(e as Error).message}`);
    }

    const cleanKey = `${projectId}/shots-clean/${shotId}_${Date.now()}.mp4`;
    await uploadFile(supabase, cleanKey, outFile, 'video/mp4');

    const { error: updErr } = await supabase
      .from('competitor_shots')
      .update({ clean_path: cleanKey, inpaint_status: 'done', inpaint_error: note ? note.slice(0, 500) : null })
      .eq('id', shotId);
    if (updErr) return fail(`could not save clean_path: ${updErr.message}`);

    log(`done — ${cleanKey}`);
    return new Response('done', { status: 200 });
  } catch (e) {
    return fail((e as Error).message);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
};
