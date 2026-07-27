import fs from 'fs';
import path from 'path';
import { getSupabase, uploadFile, makeWorkDir, downloadSource, run, FFMPEG, ffprobeInfo, countFrames } from './_shared/video';

/**
 * Background function that removes burned-in subtitles from a shot with a
 * TWO-STAGE AI pipeline on Replicate:
 *
 *  1. hjunior29/video-text-remover with method=black — its YOLO detector finds
 *     the exact text boxes frame by frame and fills them with black. We don't
 *     keep that video; we only use it to derive a per-frame MASK (the diff
 *     between original and blacked frames, computed with ffmpeg).
 *  2. jd7h/propainter — neural temporal inpainting fills ONLY those masked
 *     boxes, reconstructing the background from neighboring frames.
 *
 * Precise detection + neural fill = no smeared bands, no giant hallucinated
 * regions. The cleaned clip is stored and referenced via clean_path.
 *
 * Requires REPLICATE_API_TOKEN. Body: { shotId, projectId }
 */

const BUCKET = 'project-files';
const DETECT_MODEL = 'hjunior29/video-text-remover';
const INPAINT_MODEL = 'jd7h/propainter';
const POLL_MS = 5000;
const MAX_WAIT_MS = 12 * 60 * 1000; // background functions cap at 15 min

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function resolveVersion(token: string, model: string): Promise<string> {
  const resp = await fetch(`https://api.replicate.com/v1/models/${model}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`could not resolve ${model} version (${resp.status})`);
  const j = await resp.json();
  const v = j?.latest_version?.id;
  if (!v) throw new Error(`${model} has no latest version`);
  return v;
}

/** Create a prediction, retrying patiently on 429 (low-credit throttling). */
async function createPrediction(
  token: string,
  version: string,
  input: Record<string, unknown>,
  log: (...a: unknown[]) => void,
): Promise<string> {
  const body = JSON.stringify({ version, input });
  for (let attempt = 0; attempt < 40; attempt++) {
    const resp = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    });
    if (resp.status === 429) {
      const txt = await resp.text();
      let ra = 12;
      try { ra = Number(JSON.parse(txt)?.retry_after) || 12; } catch { /* default */ }
      const wait = ra + 2 + Math.random() * 8;
      log(`rate limited, retrying in ${wait.toFixed(0)}s (attempt ${attempt + 1})`);
      await sleep(wait * 1000);
      continue;
    }
    if (!resp.ok) throw new Error(`Replicate create failed ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const j = await resp.json();
    if (j?.id) return j.id as string;
    throw new Error('Replicate returned no prediction id');
  }
  throw new Error('Replicate kept rate-limiting — add credit at replicate.com/account/billing and retry');
}

/** Poll a prediction until it settles; returns the output file URL. */
async function waitPrediction(token: string, predId: string): Promise<string> {
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > MAX_WAIT_MS) throw new Error('Replicate prediction timed out');
    await sleep(POLL_MS);
    const resp = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) continue;
    const pred = await resp.json();
    if (pred.status === 'succeeded') {
      const url = extractOutputUrl(pred.output);
      if (!url) throw new Error('prediction succeeded but returned no video URL');
      return url;
    }
    if (pred.status === 'failed' || pred.status === 'canceled') {
      throw new Error(`Replicate prediction ${pred.status}: ${String(pred.error || '').slice(0, 300)}`);
    }
  }
}

async function download(url: string, toFile: string) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`download failed (${resp.status})`);
  fs.writeFileSync(toFile, Buffer.from(await resp.arrayBuffer()));
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
    // Spread simultaneous shots apart a little.
    await sleep(Math.random() * 10000);

    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(claimed.file_path as string, 3600);
    if (signErr || !signed?.signedUrl) return fail(`could not sign source URL: ${signErr?.message || 'no url'}`);

    // ── Stage 1: exact per-frame text boxes (filled with black) ─────────────
    let blackedUrl: string;
    try {
      const detectVersion = await resolveVersion(token, DETECT_MODEL);
      const detectId = await createPrediction(token, detectVersion, {
        video: signed.signedUrl,
        method: 'black',           // just mark the boxes; we derive the mask from the diff
        resolution: 'original',
        margin: 10,                // generous box: ProPainter fills it cleanly anyway
      }, log);
      log(`detect prediction ${detectId}`);
      blackedUrl = await waitPrediction(token, detectId);
    } catch (e) {
      return fail(`detect stage: ${(e as Error).message}`);
    }

    const srcFile = path.join(workDir, 'src.mp4');
    const blackedFile = path.join(workDir, 'blacked.mp4');
    await downloadSource(supabase, claimed.file_path as string, srcFile);
    await download(blackedUrl, blackedFile);

    // ── Mask video: white where original and blacked differ (the text boxes),
    // dilated a few pixels for safety. ProPainter indexes mask frames 1:1 with
    // video frames, so the mask MUST have the exact same frame count: we force
    // both inputs to the source fps, clone the last mask frame indefinitely
    // and trim to precisely the source frame count. ──────────────────────────
    const srcInfo = await ffprobeInfo(srcFile);
    const fps = srcInfo.fps && srcInfo.fps > 0 ? srcInfo.fps : 30;
    const nFrames = await countFrames(srcFile);
    if (!nFrames) return fail('could not count source frames');
    log(`source: ${nFrames} frames @ ${fps}fps`);

    const maskFile = path.join(workDir, 'mask.mp4');
    await run(FFMPEG, [
      '-y', '-i', srcFile, '-i', blackedFile,
      '-filter_complex',
      // lutyuv (256-entry lookup table) instead of geq: geq evaluates the
      // expression per pixel and crawled at 0.01x, getting the process killed.
      `[0:v]fps=${fps}[a0];[1:v]fps=${fps}[b0];[b0][a0]scale2ref=iw:ih[b][a];` +
        "[a][b]blend=all_mode=difference,format=gray," +
        "lutyuv=y='if(gt(val,18),255,0)',dilation,dilation,dilation,dilation," +
        `tpad=stop_mode=clone:stop=-1,trim=end_frame=${nFrames},format=yuv420p`,
      '-r', String(fps),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-an',
      maskFile,
    ]);
    const maskFrames = await countFrames(maskFile);
    log(`mask: ${maskFrames} frames (target ${nFrames})`);
    const maskKey = `${projectId}/shots-clean/mask_${shotId}.mp4`;
    await uploadFile(supabase, maskKey, maskFile, 'video/mp4');
    const { data: maskSigned, error: maskSignErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(maskKey, 3600);
    if (maskSignErr || !maskSigned?.signedUrl) {
      return fail(`could not sign mask URL: ${maskSignErr?.message || 'no url'}`);
    }

    // ── Stage 2: neural temporal inpainting of ONLY the text boxes ──────────
    let cleanedUrl: string;
    try {
      const inpaintVersion = await resolveVersion(token, INPAINT_MODEL);
      const inpaintId = await createPrediction(token, inpaintVersion, {
        video: signed.signedUrl,
        mask: maskSigned.signedUrl,
        mode: 'video_inpainting',
        mask_dilation: 6,
        fp16: true,
      }, log);
      log(`inpaint prediction ${inpaintId}`);
      cleanedUrl = await waitPrediction(token, inpaintId);
    } catch (e) {
      return fail(`inpaint stage: ${(e as Error).message}`);
    }

    const outFile = path.join(workDir, 'clean.mp4');
    await download(cleanedUrl, outFile);

    const cleanKey = `${projectId}/shots-clean/${shotId}_${Date.now()}.mp4`;
    await uploadFile(supabase, cleanKey, outFile, 'video/mp4');

    const { error: updErr } = await supabase
      .from('competitor_shots')
      .update({ clean_path: cleanKey, inpaint_status: 'done', inpaint_error: null })
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
