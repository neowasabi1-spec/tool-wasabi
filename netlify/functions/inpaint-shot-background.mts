import fs from 'fs';
import path from 'path';
import {
  getSupabase, uploadFile, makeWorkDir, probeDuration, grabThumb, detectBurnedText,
  run, FFMPEG, ffprobeInfo,
} from './_shared/video';

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

export default async (req: Request) => {
  let body: { shotId?: number; projectId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const { shotId, projectId } = body;
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
    let stillHasText = false;

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

      // Is any text left? Sample a few frames across the whole clip: leftovers
      // only survive on a handful of frames, so checking just the middle one
      // would miss them.
      try {
        const dur = await probeDuration(outFile);
        stillHasText = false;
        for (const frac of [0.2, 0.45, 0.7, 0.9]) {
          const thumb = path.join(workDir, `chk_${pass}_${frac}.jpg`);
          await grabThumb(outFile, Math.max(0.05, dur * frac), thumb);
          const check = await detectBurnedText(thumb);
          if (check.hasText === true && (check.score ?? 0) >= 0.5) { stillHasText = true; break; }
        }
      } catch (e) {
        log(`pass ${pass}: leftover check skipped (${(e as Error).message})`);
        break;                       // can't verify → don't burn more passes
      }
      if (!stillHasText) { log(`pass ${pass}: no text left`); break; }
      log(`pass ${pass}: text still visible`);
      if (pass === MAX_PASSES || Date.now() > deadline) break;
    }

    if (!fs.existsSync(outFile)) return fail('no cleaned video produced');

    // ── Stage 2: text the YOLO detector never sees (stylized CTA graphics).
    // Locate it with OCR and erase those exact boxes around the times where it
    // was seen. Never fatal: a failure here still keeps the stage-1 result. ──
    let note: string | null = null;
    if (stillHasText) {
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
        log(`stage 2: OCR on ${frames.length} frames`);

        const ocrVersion = await resolveVersion(token, OCR_MODEL);
        // The wrapper's task name isn't documented; try the known spellings and
        // stick with whichever returns boxes.
        const taskCandidates = ['OCR with Region', '<OCR_WITH_REGION>', 'OCR'];
        let task: string | null = null;
        const dets: Detection[] = [];

        for (let i = 0; i < frames.length; i++) {
          if (Date.now() > deadline) { log('stage 2: out of time'); break; }
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
                log(`stage 2: task "${cand}" failed (${(e as Error).message})`);
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
          log(`stage 2: erased ${rects.length} text region(s)`);
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
