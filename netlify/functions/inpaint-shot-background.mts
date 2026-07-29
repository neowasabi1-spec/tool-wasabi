import fs from 'fs';
import path from 'path';
import {
  getSupabase, uploadFile, makeWorkDir, downloadSource, probeDuration,
  run, FFMPEG, ffprobeInfo,
} from './_shared/video';
import { captionMasks, writeMaskVideo } from './_shared/caption-mask';

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
export function analyzeLeftoverText(orig: Buffer, clean: Buffer, w: number, h: number): Leftover {
  const px = w * h;
  const fsz = px * 3;
  const frames = Math.min(Math.floor(orig.length / fsz), Math.floor(clean.length / fsz));
  const empty: Leftover = { bad: [], counts: [], frames, maskPx: 0, colour: null, box: null };
  if (!frames) return empty;

  const mask = new Uint8Array(px);
  let maskPx = 0;
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let f = 0; f < frames; f++) {
    for (let p = 0; p < px; p++) {
      if (mask[p]) continue;
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
async function compareRemover(
  supabase: ReturnType<typeof getSupabase>,
  token: string,
  shotId: number,
  projectId: string,
  model: string,
  log: (...a: unknown[]) => void,
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

    const rgb = await rgbFrames(srcFile, W, H, dur, fps, workDir);
    const frames = Math.floor(rgb.buf.length / (rgb.w * rgb.h * 3));
    const cm = captionMasks(rgb.buf, frames, rgb.w, rgb.h, shot.text_region as string | null);
    if (!cm) { report.error = 'no caption colour found on the original'; await save(); return new Response('no mask', { status: 200 }); }
    report.mask = {
      colour: cm.colour, kind: cm.kind, samples: cm.samples,
      pxPerFrame: cm.pxPerFrame, coverage: +(cm.pxPerFrame / (rgb.w * rgb.h)).toFixed(4),
      frames, analysedAt: `${rgb.w}x${rgb.h}`,
    };
    log(`mask: rgb(${cm.colour.join(',')}) ${cm.kind}, ${cm.pxPerFrame}px/frame over ${frames} frames`);

    const maskFile = await writeMaskVideo(cm.masks, rgb.w, rgb.h, fps, W, H, workDir);
    const maskKey = `${base}_mask.mp4`;
    await uploadFile(supabase, maskKey, maskFile, 'video/mp4');

    const sign = async (key: string) => {
      const { data } = await supabase.storage.from(BUCKET).createSignedUrl(key, 3600);
      return data?.signedUrl || null;
    };
    const videoUrl = await sign(shot.file_path as string);
    const maskUrl = await sign(maskKey);
    if (!videoUrl || !maskUrl) { report.error = 'could not sign input urls'; await save(); return new Response('no urls', { status: 200 }); }

    // The wrapper's field names aren't documented, so read them off the schema.
    const modelResp = await fetch(`https://api.replicate.com/v1/models/${model}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!modelResp.ok) {
      report.error = `model lookup ${modelResp.status}: ${(await modelResp.text()).slice(0, 200)}`;
      await save();
      return new Response('model error', { status: 200 });
    }
    const meta = await modelResp.json();
    const version = meta?.latest_version?.id;
    const props = meta?.latest_version?.openapi_schema?.components?.schemas?.Input?.properties || {};
    const keys = Object.keys(props);
    const maskKeyName = keys.find((k) => /mask/i.test(k));
    const videoKeyName = keys.find((k) => /^(video|input_video|source_video)$/i.test(k)) ||
      keys.find((k) => /video/i.test(k) && !/mask/i.test(k));
    report.inputs = keys;
    if (!version || !videoKeyName || !maskKeyName) {
      report.error = `could not map inputs (video=${videoKeyName}, mask=${maskKeyName})`;
      await save();
      return new Response('schema error', { status: 200 });
    }

    const input: Record<string, unknown> = { [videoKeyName]: videoUrl, [maskKeyName]: maskUrl };
    // These removers work on a fixed-length block of frames, so a clip longer
    // than the default comes back truncated. Ask for the clip's real length and
    // size when the wrapper exposes those inputs, and record the schema limits
    // so a cap can be worked around by processing the clip in parts.
    const limits: Record<string, unknown> = {};
    const wanted: Record<string, number> = {
      fps: Math.round(fps),
      num_frames: frames,
      width: W,
      height: H,
    };
    for (const [name, value] of Object.entries(wanted)) {
      const spec = props[name];
      if (!spec) continue;
      limits[name] = { default: spec.default, min: spec.minimum, max: spec.maximum };
      const max = typeof spec.maximum === 'number' ? spec.maximum : Infinity;
      const min = typeof spec.minimum === 'number' ? spec.minimum : 0;
      input[name] = Math.max(min, Math.min(max, value));
    }
    report.limits = limits;
    report.sent = { video: videoKeyName, mask: maskKeyName, ...Object.fromEntries(
      Object.keys(wanted).filter((k) => k in input).map((k) => [k, input[k]]),
    ) };
    log(`running ${model} (${videoKeyName} + ${maskKeyName}, ${frames} frames @ ${Math.round(fps)}fps)`);

    const started = Date.now();
    const output = await replicateRun(token, version, input, Date.now() + MAX_WAIT_MS, log);
    const url = extractOutputUrl(output);
    report.seconds = Math.round((Date.now() - started) / 1000);
    if (!url) { report.error = 'prediction returned no video'; await save(); return new Response('no output', { status: 200 }); }

    const dl = await fetch(url);
    if (!dl.ok) { report.error = `download failed ${dl.status}`; await save(); return new Response('dl error', { status: 200 }); }
    const outFile = path.join(workDir, 'out.mp4');
    fs.writeFileSync(outFile, Buffer.from(await dl.arrayBuffer()));
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

export default async (req: Request) => {
  let body: { shotId?: number; projectId?: string; compareModel?: string };
  try {
    body = await req.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const { shotId, projectId, compareModel } = body;
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
    return compareRemover(supabase, token, shotId, projectId, compareModel, log);
  }

  if (!token) return fail('REPLICATE_API_TOKEN is not set in Netlify env vars');

  // Claim: pending -> processing (avoids double-run when triggered twice).
  const { data: claimed, error: claimErr } = await supabase
    .from('competitor_shots')
    .update({ inpaint_status: 'processing', inpaint_error: null })
    .eq('id', shotId)
    .eq('project_id', projectId)
    .eq('inpaint_status', 'pending')
    .select('id, file_path')
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
    let leftover: Leftover | null = null;

    for (let pass = 1; pass <= MAX_PASSES; pass++) {
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

    // ── Stage 2a: frames that still show text after every pass. Drop them and
    // hold the previous good frame: erasing the caption area on single frames
    // makes the patch blink on and off, which reads worse than a 33ms freeze. ──
    if (leftover?.bad.length && leftover.box) {
      try {
        const maxDrop = Math.max(2, Math.floor(leftover.frames * MAX_DROP));
        if (leftover.bad.length <= maxDrop) {
          const patched = path.join(workDir, 'clean2a.mp4');
          await run(FFMPEG, [
            '-y', '-i', outFile, '-vf', buildDropGraph(leftover.bad, fps),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', patched,
          ]);
          fs.copyFileSync(patched, outFile);
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
