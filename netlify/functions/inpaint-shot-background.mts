import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { getSupabase, uploadFile, makeWorkDir } from './_shared/video';

/**
 * Background function that removes burned-in subtitles from a shot with REAL
 * AI video inpainting (Replicate: jd7h/propainter — neural temporal inpainting
 * that reconstructs the masked band using neighboring frames). We generate a
 * mask covering the measured text band ourselves. The cleaned clip is stored
 * next to the original and referenced via competitor_shots.clean_path, which
 * makes the shot usable in video builds.
 *
 * Requires the REPLICATE_API_TOKEN env var on Netlify.
 * Body: { shotId, projectId }
 */

const BUCKET = 'project-files';
const REPLICATE_MODEL = 'jd7h/propainter';
const POLL_MS = 5000;
const MAX_WAIT_MS = 12 * 60 * 1000; // background functions cap at 15 min

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Tiny PNG writer (8-bit grayscale) so we don't need ffmpeg here ──────────
function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Black frame with a WHITE horizontal band from y0..y1 (fractions of height). */
function bandMaskPng(width: number, height: number, y0: number, y1: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const yA = Math.round(height * y0);
  const yB = Math.round(height * y1);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width, y >= yA && y <= yB ? 255 : 0);
    row[0] = 0; // filter: none
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Vertical extent of the subtitle band, with margin. Falls back per region. */
function parseBand(textRegion: string | null | undefined): { y0: number; y1: number } {
  const raw = (textRegion || '').trim().toLowerCase();
  const m = raw.match(/([01]?\.\d+)-([01]?\.\d+)/);
  if (m) {
    const y0 = Math.max(0, parseFloat(m[1]) - 0.04);
    const y1 = Math.min(1, parseFloat(m[2]) + 0.04);
    if (y1 > y0) return { y0, y1 };
  }
  if (raw.startsWith('bottom')) return { y0: 0.62, y1: 0.98 };
  if (raw.startsWith('top')) return { y0: 0.02, y1: 0.32 };
  return { y0: 0.32, y1: 0.68 }; // center / unknown — generous middle band
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
    .select('id, file_path, text_region, width, height')
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

    // Build the inpainting mask: a white band over the measured text region.
    const w = Number(claimed.width) > 0 ? Number(claimed.width) : 1080;
    const h = Number(claimed.height) > 0 ? Number(claimed.height) : 1920;
    const band = parseBand(claimed.text_region as string | null);
    const maskFile = path.join(workDir, 'mask.png');
    fs.writeFileSync(maskFile, bandMaskPng(w, h, band.y0, band.y1));
    const maskKey = `${projectId}/shots-clean/mask_${shotId}.png`;
    await uploadFile(supabase, maskKey, maskFile, 'image/png');
    const { data: maskSigned, error: maskSignErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(maskKey, 3600);
    if (maskSignErr || !maskSigned?.signedUrl) {
      return fail(`could not sign mask URL: ${maskSignErr?.message || 'no url'}`);
    }
    log(`mask band ${band.y0.toFixed(2)}-${band.y1.toFixed(2)} on ${w}x${h}`);

    // Some models 404 on the model-latest predictions endpoint, so resolve the
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

    // Create the prediction. Accounts with <$5 credit are throttled to ~1
    // request every 10s, so retry patiently on 429 instead of failing — the
    // per-shot background functions then serialize themselves naturally.
    let predId: string | null = null;
    const createBody = JSON.stringify({
      version,
      input: {
        video: signed.signedUrl,
        mask: maskSigned.signedUrl,
        mode: 'video_inpainting',
        mask_dilation: 8,   // widen the band a little to catch text outlines
        fp16: true,         // halves GPU memory, negligible quality impact
      },
    });
    // Spread simultaneous shots apart before the first attempt.
    await sleep(Math.random() * 15000);
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
        log(`rate limited, retrying in ${wait.toFixed(0)}s (attempt ${attempt + 1})`);
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
    log(`prediction ${predId} created (version ${String(version).slice(0, 8)})`);

    // Poll until done.
    const started = Date.now();
    let outputUrl: string | null = null;
    for (;;) {
      if (Date.now() - started > MAX_WAIT_MS) return fail('Replicate prediction timed out');
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
        return fail(`Replicate prediction ${pred.status}: ${String(pred.error || '').slice(0, 300)}`);
      }
    }

    // Download the cleaned clip and store it next to the original.
    const outFile = path.join(workDir, 'clean.mp4');
    const dl = await fetch(outputUrl);
    if (!dl.ok) return fail(`could not download cleaned video (${dl.status})`);
    fs.writeFileSync(outFile, Buffer.from(await dl.arrayBuffer()));

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
