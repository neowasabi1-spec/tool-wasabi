import fs from 'fs';
import path from 'path';
import { getSupabase, uploadFile, makeWorkDir } from './_shared/video';

/**
 * Background function that removes burned-in subtitles from a shot with REAL
 * AI video inpainting (Replicate: hjunior29/video-text-remover — YOLO text
 * detection + context-aware inpainting). The cleaned clip is stored next to
 * the original and referenced via competitor_shots.clean_path, which makes the
 * shot usable in video builds.
 *
 * Requires the REPLICATE_API_TOKEN env var on Netlify.
 * Body: { shotId, projectId }
 */

const BUCKET = 'project-files';
const REPLICATE_MODEL = 'hjunior29/video-text-remover';
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

    // Create the prediction. Accounts with <$5 credit are throttled to ~1
    // request every 10s, so retry patiently on 429 instead of failing — the
    // per-shot background functions then serialize themselves naturally.
    let predId: string | null = null;
    const createBody = JSON.stringify({
      version,
      input: {
        video: signed.signedUrl,
        method: 'hybrid',          // context-aware inpainting (best for complex backgrounds)
        resolution: 'original',
        conf_threshold: 0.15,      // default 0.25 misses line-end words (left "OUR"/"NUTES)" behind)
        margin: 15,                // wider box so whole caption lines get erased
        detection_interval: 1,     // detect on every frame — clips are short
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
