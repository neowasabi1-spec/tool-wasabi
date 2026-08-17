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
 *     with ffmpeg delogo, active only around the times where text was seen.
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
const COLOR_MIN = 30;     // caption-coloured pixels left -> text still on screen
const MAX_DROP = 0.25;    // beyond this, freezing frames would be noticeable
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
      if (!near(clean, i)) continue;  // repainted away
      if (isWhite && !sharp(clean, p, f)) continue;
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

function toRect(c: Cluster, W: number, H: number): Rect | null {
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
  // Dilation and steps matter more than they look: with the model's defaults the
  // caption came back as a smear that still read as letters, because the repaint
  // stopped right at the glyph edges and the fill had too few steps to invent
  // plausible background. Growing the mask inside the model and giving it more
  // steps is what turns the smear into clean footage.
  const wanted: Record<string, number> = {
    fps: Math.round(fps), num_frames: frames, width: W, height: H,
    mask_dilation_iterations: 10, num_inference_steps: 12,
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
  const file = path.join(workDir, `mask-clean_${path.basename(maskKey)}.mp4`);
  fs.writeFileSync(file, Buffer.from(await dl.arrayBuffer()));

  // A shorter result means frames were dropped somewhere; that is worse than a
  // visible caption, so it goes back to the fallback.
  const outDur = await probeDuration(file);
  if (outDur < dur - 0.2) {
    note(`result is ${outDur.toFixed(2)}s of ${dur.toFixed(2)}s — kept the fallback instead`);
    return null;
  }
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
  const { supabase, token, model, srcKey, maskKey, band, W, H, fps, dur, workDir, deadline, tag, log } = opts;
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
    mask_dilation_iterations: 10, num_inference_steps: 12,
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
  const file = path.join(workDir, `bandclean_${tag}.mp4`);
  fs.writeFileSync(file, Buffer.from(await dl.arrayBuffer()));

  const outDur = await probeDuration(file);
  if (outDur < dur - 0.3) { log(`${tag}: band inpaint truncated to ${outDur.toFixed(2)}s of ${dur.toFixed(2)}s`); return null; }
  return file;
}

/** Cut [t0, t0+len) out of a clip, frame-accurate, re-encoded to H.264. */
async function cutWindow(src: string, t0: number, len: number, out: string): Promise<void> {
  await run(FFMPEG, [
    '-y', '-i', src, '-ss', t0.toFixed(3), '-t', len.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-an', out,
  ]);
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
  // When the caption can't be reconstructed, ERASE its band (soft blur) instead
  // of giving up. Shots leave a clip out of the pool (default); a whole video
  // wants the text gone even if the patch is visible, so it sets this true.
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
        margin: 15,
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
        // Whole-video mode: NEVER drop frames — that shortens the clip and, once
        // the windows are stitched and the audio muxed with -shortest, cuts the
        // whole video (15s → 8s). Erase the caption band instead: same frame
        // count, same length, audio stays in sync.
        const rect = leftover.box ? toRect({ b: leftover.box, t0: 0, t1: dur + 1 }, W, H) : null;
        if (rect) {
          const patched = path.join(workDir, 'clean2a-erase.mp4');
          await run(FFMPEG, [
            '-y', '-i', outFile, '-filter_complex', buildEraseGraph([rect]),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', patched,
          ]);
          fs.copyFileSync(patched, outFile);
          note = `caption band erased on ${leftover.bad.length}/${leftover.frames} frames (length preserved)`;
          log(`stage 2a: ${note}`);
        }
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
        const rect = toRect({ b: leftover.box, t0: 0, t1: dur + 1 }, W, H);
        if (rect) {
          const patched = path.join(workDir, 'clean2a.mp4');
          await run(FFMPEG, [
            '-y', '-i', outFile, '-filter_complex', buildEraseGraph([rect]),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', patched,
          ]);
          fs.copyFileSync(patched, outFile);
          note = `text on ${leftover.bad.length}/${leftover.frames} frames — area erased for the whole clip`;
          log(`stage 2a: ${note}`);
        }
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
        const finalFile = path.join(workDir, 'clean2.mp4');
        await run(FFMPEG, [
          '-y', '-i', outFile, '-filter_complex', buildEraseGraph(rects),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', finalFile,
        ]);
        fs.copyFileSync(finalFile, outFile);
        log(`stage 2b: erased ${rects.length} text region(s)`);
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
          // Whole-video: erase the band, NEVER drop frames (dropping shortens the
          // clip and, after stitch + -shortest audio mux, cuts the whole video).
          const rect = left.box ? toRect({ b: left.box, t0: 0, t1: dur + 1 }, W, H) : null;
          if (rect) {
            const patched = path.join(workDir, 'clean3-erase.mp4');
            await run(FFMPEG, [
              '-y', '-i', outFile, '-filter_complex', buildEraseGraph([rect]),
              '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', patched,
            ]);
            fs.copyFileSync(patched, outFile);
            note = `caption band erased on ${left.bad.length}/${left.frames} frames (length preserved)`;
            log(`final gate: ${note}`);
          }
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
): Promise<Response> {
  const fail = async (msg: string) => {
    log('error:', msg);
    await supabase.from('competitor_ads')
      .update({ clean_status: 'error', clean_error: msg.slice(0, 500) })
      .eq('id', adId);
    return new Response('error', { status: 200 });
  };

  // Claim: pending -> processing.
  const { data: claimed, error: claimErr } = await supabase
    .from('competitor_ads')
    .update({ clean_status: 'processing', clean_error: null })
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

    // Clean in SHORT windows — the granularity the remover is proven at — and
    // BEST-EFFORT: a window that can't be cleaned keeps its original footage
    // instead of failing the whole video. The shots pipeline discards unclean
    // clips, but a whole video must always come back with a result, so here we
    // never bail: worst case a window keeps its captions, most windows come out
    // clean. Windows are concatenated and the original audio muxed back on top.
    const deadline = Date.now() + MAX_WAIT_MS;
    const SEG_SEC = 2.6;
    const nseg = Math.max(1, Math.ceil(dur / SEG_SEC));
    const segDur = dur / nseg;
    log(`cleaning ${dur.toFixed(1)}s in ${nseg} window(s) of ~${segDur.toFixed(1)}s`);

    type Piece = { file: string; segFile: string; len: number; cleaned: boolean };
    const pieces: Piece[] = [];
    // The caption sits in the same vertical band for the whole video, so learn
    // that band from the windows the mask path DID clean, then reuse it to erase
    // the band on windows that couldn't be cleaned — no window keeps its text.
    let learnedBand: { y0: number; y1: number } | null = null;
    const mergeBand = (b: { y0: number; y1: number } | null | undefined) => {
      if (!b) return;
      learnedBand = learnedBand
        ? { y0: Math.min(learnedBand.y0, b.y0), y1: Math.max(learnedBand.y1, b.y1) }
        : { y0: b.y0, y1: b.y1 };
    };

    for (let i = 0; i < nseg; i++) {
      const t0 = i * segDur;
      const len = i === nseg - 1 ? Math.max(0.1, dur - t0) : segDur;
      const segFile = path.join(workDir, `seg_${i}.mp4`);
      await cutClip(srcFile, t0, t0 + len, segFile);
      // Leave enough budget to still stitch + upload; keep the rest as-is.
      if (Date.now() > deadline - 45000) { pieces.push({ file: segFile, segFile, len, cleaned: false }); log(`window ${i}: out of time — kept original`); continue; }
      const segKey = `${projectId}/ads-clean/${adId}_seg${i}_${Date.now()}.mp4`;
      let out = segFile;
      let cleaned = false;
      try {
        await uploadFile(supabase, segKey, segFile, 'video/mp4');
        const r = await cleanClipFile({
          supabase, token, srcKey: segKey, srcFile: segFile, textRegion: null,
          W, H, fps, dur: len, workDir, deadline,
          keyBase: `${projectId}/ads-clean/${adId}_s${i}`, log, jitterMs: 0,
          eraseIfUnreadable: true, // whole video: erase the caption band rather than keep the text
        });
        mergeBand(r.band);
        if (r.ok) { out = r.outFile; cleaned = true; }
        else log(`window ${i}: ${r.note || 'not cleanable'} — will retry with the learned band`);
      } catch (e) {
        log(`window ${i} failed (${(e as Error).message}) — will retry with the learned band`);
      }
      pieces.push({ file: out, segFile, len, cleaned });
    }

    // Second pass: windows that still carry their original footage get the caption
    // band (learned above) rebuilt. First choice is neural RECONSTRUCTION — the
    // remover repaints the band from temporal context, no blur. Only if that
    // can't run do we blur-erase the band, so a window never keeps its text.
    let cleanedCount = pieces.filter((p) => p.cleaned).length;
    const band = learnedBand as { y0: number; y1: number } | null;
    if (band && cleanedCount < nseg) {
      const padded = { y0: Math.max(0, band.y0 - 0.02), y1: Math.min(1, band.y1 + 0.02) };
      const box: Box = { x0: 0.01, x1: 0.99, y0: padded.y0, y1: padded.y1 };
      const fbModel = await resolveMaskModel(token, log);
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        if (p.cleaned) continue;
        // Only bail if there isn't even time to blur + stitch + upload. The blur
        // step below is a couple of seconds, so it still runs when the slower
        // neural pass can't — that's what stops "5/7" leaving raw captions.
        if (Date.now() > deadline - 15000) { log(`window ${i}: out of time for the fallback — kept original`); continue; }
        let done = false;

        // 1) Neural reconstruction of the learned band (rebuilds pixels) — only
        //    when there's ample time left for a Replicate round-trip.
        if (fbModel && Date.now() < deadline - 90000) {
          try {
            const segKey = `${projectId}/ads-clean/${adId}_fb${i}_${Date.now()}.mp4`;
            await uploadFile(supabase, segKey, p.segFile, 'video/mp4');
            const rebuilt = await bandInpaintClip({
              supabase, token, model: fbModel, srcKey: segKey, srcFile: p.segFile,
              maskKey: `${projectId}/ads-clean/${adId}_fbmask${i}_${Date.now()}.mp4`,
              band: padded, W, H, fps, dur: p.len, workDir, deadline, tag: `w${i}`, log,
            });
            if (rebuilt) {
              p.file = rebuilt; p.cleaned = true; cleanedCount++; done = true;
              log(`window ${i}: reconstructed the caption band neurally`);
            }
          } catch (e) {
            log(`window ${i}: neural band reconstruct failed (${(e as Error).message})`);
          }
        }

        // 2) Last resort: blur-erase the band so no text remains.
        if (!done) {
          const rect = toRect({ b: box, t0: 0, t1: p.len + 1 }, W, H);
          if (!rect) continue;
          try {
            const erased = path.join(workDir, `erase_${i}.mp4`);
            await run(FFMPEG, [
              '-y', '-i', p.segFile, '-filter_complex', buildEraseGraph([rect]),
              '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', erased,
            ]);
            p.file = erased; p.cleaned = true; cleanedCount++;
            log(`window ${i}: blur-erased the caption band (neural reconstruct unavailable)`);
          } catch (e) {
            log(`window ${i}: band-erase fallback failed (${(e as Error).message}) — kept original`);
          }
        }
      }
    }

    // Concatenate the (mixed clean / original) windows, re-encoding to a uniform
    // H.264 so the demuxer never chokes on parameter mismatches between windows.
    const listFile = path.join(workDir, 'concat.txt');
    fs.writeFileSync(listFile, pieces.map((p) => `file '${p.file.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
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
    const note = cleanedCount === nseg
      ? null
      : `${cleanedCount}/${nseg} windows cleared of captions — the rest kept original footage (no caption band could be located)`;
    await supabase.from('competitor_ads')
      .update({ clean_status: 'done', clean_full_path: cleanKey, clean_error: note })
      .eq('id', adId);
    log(`done — ${cleanKey} (${cleanedCount}/${nseg} windows cleaned)`);
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
  };
  try {
    body = await req.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const { shotId, projectId, compareModel, tuning, adId } = body;

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
    return cleanWholeAd(supabase, token, adId, projectId, log);
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
          margin: 15,                // wider box so whole caption lines get erased
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
          // Too many to freeze over — erase the caption area for the whole clip
          // instead, constantly, so nothing flickers.
          const rect = toRect({ b: leftover.box, t0: 0, t1: dur + 1 }, W, H);
          if (rect) {
            const patched = path.join(workDir, 'clean2a.mp4');
            await run(FFMPEG, [
              '-y', '-i', outFile, '-filter_complex', buildEraseGraph([rect]),
              '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', patched,
            ]);
            fs.copyFileSync(patched, outFile);
            note = `text on ${leftover.bad.length}/${leftover.frames} frames — area erased for the whole clip`;
            log(`stage 2a: ${note}`);
          }
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
          const finalFile = path.join(workDir, 'clean2.mp4');
          await run(FFMPEG, [
            '-y', '-i', outFile, '-filter_complex', buildEraseGraph(rects),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', finalFile,
          ]);
          fs.copyFileSync(finalFile, outFile);
          log(`stage 2b: erased ${rects.length} text region(s)`);
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
