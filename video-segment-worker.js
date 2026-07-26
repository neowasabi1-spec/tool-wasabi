/**
 * Video Segment Worker — Phase 2 "recreate from real footage".
 *
 * Polls Supabase `video_segment_jobs` and, for each competitor video, uses
 * ffmpeg to:
 *   1. detect scene cuts and split the video into individual SHOTS,
 *   2. drop the competitor's audio (we add our own voice later),
 *   3. store each clip + a midpoint thumbnail in the `project-files` bucket,
 *   4. (optional) run a vision OCR pass to flag burned-in subtitles so we can
 *      prefer clean shots and cover residual text with our own captions,
 *   5. insert a `competitor_shots` row per clip.
 *
 * Requirements on the machine that runs this:
 *   - ffmpeg + ffprobe on PATH  (https://ffmpeg.org/download.html)
 *   - `npm install @supabase/supabase-js` (already a repo dependency)
 *
 * Env:
 *   SUPABASE_URL                (defaults to the project URL below)
 *   SUPABASE_SERVICE_KEY        service-role key — REQUIRED for private bucket
 *                               download/upload (falls back to anon, which will
 *                               fail on a private bucket)
 *   OPENAI_API_KEY              optional — enables subtitle OCR on thumbnails
 *   SEGMENT_MIN_SEC=1.2         drop shots shorter than this
 *   SEGMENT_MAX_SEC=6           split shots longer than this
 *   SEGMENT_MAX_SHOTS=40        cap shots per video
 *   SCENE_THRESHOLD=0.35        ffmpeg scene score threshold
 *
 * Usage:
 *   set SUPABASE_SERVICE_KEY=... && node video-segment-worker.js
 * Recommended: run as a service (NSSM on Windows) so it restarts on boot.
 */

const { createClient } = require('@supabase/supabase-js');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  '';
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

const BUCKET = 'project-files';
const MIN_SEC = parseFloat(process.env.SEGMENT_MIN_SEC || '1.2');
const MAX_SEC = parseFloat(process.env.SEGMENT_MAX_SEC || '6');
const MAX_SHOTS = parseInt(process.env.SEGMENT_MAX_SHOTS || '40', 10);
const SCENE_THRESHOLD = parseFloat(process.env.SCENE_THRESHOLD || '0.35');
const POLL_MS = parseInt(process.env.SEGMENT_POLL_MS || '5000', 10);

if (!SUPABASE_KEY) {
  console.error('[segment] No Supabase key. Set SUPABASE_SERVICE_KEY (service role).');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const log = (...a) => console.log(new Date().toISOString(), '[segment]', ...a);
const errlog = (...a) => console.error(new Date().toISOString(), '[segment]', ...a);

// ── ffmpeg helpers ──────────────────────────────────────────────────────────
function run(cmd, args, { capture = 'stderr' } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(capture === 'stdout' ? out : err);
      else reject(new Error(`${cmd} exited ${code}: ${(err || out).slice(-500)}`));
    });
  });
}

async function ffprobeInfo(file) {
  const out = await run(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'format=duration:stream=width,height',
      '-of', 'json',
      file,
    ],
    { capture: 'stdout' },
  );
  const j = JSON.parse(out || '{}');
  const duration = parseFloat(j?.format?.duration || '0') || 0;
  const st = (j.streams && j.streams[0]) || {};
  return { duration, width: st.width || null, height: st.height || null };
}

// Return sorted scene-cut times (seconds), excluding 0 and duration.
async function detectScenes(file) {
  let stderr = '';
  try {
    stderr = await run('ffmpeg', [
      '-i', file,
      '-filter_complex', `select='gt(scene,${SCENE_THRESHOLD})',metadata=print`,
      '-an', '-f', 'null', '-',
    ]);
  } catch (e) {
    // ffmpeg returns non-zero sometimes on -f null; still capture stderr.
    stderr = String(e.message || '');
  }
  const times = [];
  const re = /pts_time:([0-9]+\.?[0-9]*)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) {
    const t = parseFloat(m[1]);
    if (Number.isFinite(t) && t > 0) times.push(t);
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

// Turn scene cuts into [start,end] segments, honoring MIN/MAX/MAX_SHOTS.
function buildSegments(cuts, duration) {
  const bounds = [0, ...cuts.filter((t) => t < duration - 0.05), duration];
  let segs = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    let start = bounds[i];
    let end = bounds[i + 1];
    if (end - start < 0.3) continue;
    // Split overly long shots into MAX_SEC chunks.
    while (end - start > MAX_SEC + 0.5) {
      segs.push([start, start + MAX_SEC]);
      start += MAX_SEC;
    }
    segs.push([start, end]);
  }
  // Drop too-short shots (likely transitions).
  segs = segs.filter(([s, e]) => e - s >= MIN_SEC);
  // If scene detection found nothing useful, fall back to fixed chunks.
  if (segs.length === 0 && duration > MIN_SEC) {
    for (let s = 0; s < duration; s += MAX_SEC) {
      const e = Math.min(s + MAX_SEC, duration);
      if (e - s >= MIN_SEC) segs.push([s, e]);
    }
  }
  return segs.slice(0, MAX_SHOTS);
}

async function cutClip(src, start, end, outFile) {
  await run('ffmpeg', [
    '-y',
    '-ss', String(start),
    '-to', String(end),
    '-i', src,
    '-an', // drop competitor audio — we add our own voice later
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outFile,
  ]);
}

async function grabThumb(src, atSec, outFile) {
  await run('ffmpeg', [
    '-y',
    '-ss', String(atSec),
    '-i', src,
    '-frames:v', '1',
    '-q:v', '3',
    outFile,
  ]);
}

// ── Optional subtitle OCR via OpenAI vision ─────────────────────────────────
async function detectBurnedText(thumbPath) {
  if (!OPENAI_API_KEY) return { hasText: null, score: null, region: '' };
  try {
    const b64 = fs.readFileSync(thumbPath).toString('base64');
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 60,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Does this video frame contain burned-in subtitle/caption text overlaid on the footage? ' +
                  'Reply ONLY compact JSON: {"text":true|false,"conf":0..1,"region":"top|center|bottom|"}. ' +
                  'Ignore small logos/watermarks; only large readable caption words count.',
              },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
            ],
          },
        ],
      }),
    });
    const j = await resp.json();
    const raw = j?.choices?.[0]?.message?.content || '';
    const clean = raw.replace(/```json?/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      hasText: !!parsed.text,
      score: typeof parsed.conf === 'number' ? parsed.conf : parsed.text ? 0.8 : 0.1,
      region: typeof parsed.region === 'string' ? parsed.region : '',
    };
  } catch (e) {
    errlog('OCR failed (non-fatal):', e.message);
    return { hasText: null, score: null, region: '' };
  }
}

// ── Source download ─────────────────────────────────────────────────────────
async function downloadSource(filePath, tmpFile) {
  if (/^https?:\/\//i.test(filePath)) {
    const resp = await fetch(filePath);
    if (!resp.ok) throw new Error(`source fetch ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(tmpFile, buf);
    return;
  }
  const { data, error } = await supabase.storage.from(BUCKET).download(filePath);
  if (error || !data) throw new Error(`storage download failed: ${error?.message || 'no data'}`);
  const buf = Buffer.from(await data.arrayBuffer());
  fs.writeFileSync(tmpFile, buf);
}

async function uploadFile(objectKey, localFile, contentType) {
  const bytes = fs.readFileSync(localFile);
  const { error } = await supabase.storage.from(BUCKET).upload(objectKey, bytes, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`upload failed: ${error.message}`);
  return objectKey;
}

// ── Job processing ──────────────────────────────────────────────────────────
async function claimJob() {
  const { data: pending } = await supabase
    .from('video_segment_jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;
  // Atomic-ish claim: only take it if still pending.
  const { data: claimed } = await supabase
    .from('video_segment_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  return claimed || null;
}

async function processJob(job) {
  log(`job #${job.id} — ad ${job.ad_id} (project ${job.project_id})`);

  const { data: ad, error: adErr } = await supabase
    .from('competitor_ads')
    .select('id, file_path, media_type')
    .eq('id', job.ad_id)
    .maybeSingle();
  if (adErr || !ad) throw new Error(`ad not found: ${adErr?.message || job.ad_id}`);
  if (ad.media_type !== 'video') throw new Error('ad is not a video');
  if (!ad.file_path) throw new Error('ad has no file_path');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wshots-'));
  const srcFile = path.join(workDir, 'src.mp4');
  let shotsCount = 0;
  try {
    await downloadSource(ad.file_path, srcFile);
    const info = await ffprobeInfo(srcFile);
    if (!info.duration) throw new Error('could not read video duration');
    log(`duration ${info.duration.toFixed(1)}s, ${info.width}x${info.height}`);

    const cuts = await detectScenes(srcFile);
    const segments = buildSegments(cuts, info.duration);
    log(`scene cuts: ${cuts.length}, shots: ${segments.length}`);

    for (let i = 0; i < segments.length; i++) {
      const [start, end] = segments[i];
      const clipFile = path.join(workDir, `shot_${i}.mp4`);
      const thumbFile = path.join(workDir, `shot_${i}.jpg`);
      try {
        await cutClip(srcFile, start, end, clipFile);
        await grabThumb(srcFile, (start + end) / 2, thumbFile);
      } catch (e) {
        errlog(`shot ${i} cut failed: ${e.message}`);
        continue;
      }

      const base = `${job.project_id}/shots/${job.brand_id}/${job.ad_id}_${i}_${Date.now()}`;
      const clipKey = `${base}.mp4`;
      const thumbKey = `${base}.jpg`;
      await uploadFile(clipKey, clipFile, 'video/mp4');
      let storedThumb = '';
      try {
        storedThumb = await uploadFile(thumbKey, thumbFile, 'image/jpeg');
      } catch (e) {
        errlog(`thumb upload failed: ${e.message}`);
      }

      const ocr = await detectBurnedText(thumbFile);

      const { error: insErr } = await supabase.from('competitor_shots').insert({
        project_id: job.project_id,
        brand_id: job.brand_id,
        ad_id: job.ad_id,
        file_path: clipKey,
        thumb_path: storedThumb || null,
        start_sec: start,
        end_sec: end,
        duration_sec: +(end - start).toFixed(2),
        width: info.width,
        height: info.height,
        has_text: ocr.hasText,
        text_score: ocr.score,
        text_region: ocr.region || '',
      });
      if (insErr) errlog(`insert shot ${i} failed: ${insErr.message}`);
      else shotsCount++;
    }
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  await supabase
    .from('video_segment_jobs')
    .update({ status: 'done', shots_count: shotsCount, finished_at: new Date().toISOString() })
    .eq('id', job.id);
  log(`job #${job.id} done — ${shotsCount} shots`);
}

async function loop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let job = null;
    try {
      job = await claimJob();
    } catch (e) {
      errlog('claim failed:', e.message);
    }
    if (!job) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    try {
      await processJob(job);
    } catch (e) {
      errlog(`job #${job.id} error:`, e.message);
      await supabase
        .from('video_segment_jobs')
        .update({ status: 'error', error: String(e.message).slice(0, 1000), finished_at: new Date().toISOString() })
        .eq('id', job.id)
        .then(() => {}, () => {});
    }
  }
}

// Fail fast if ffmpeg/ffprobe are missing.
(async () => {
  try {
    await run('ffmpeg', ['-version'], { capture: 'stdout' });
    await run('ffprobe', ['-version'], { capture: 'stdout' });
  } catch {
    errlog('ffmpeg/ffprobe not found on PATH. Install ffmpeg first.');
    process.exit(1);
  }
  log(`ready — polling every ${POLL_MS}ms. OCR ${OPENAI_API_KEY ? 'ON' : 'OFF'}.`);
  loop();
})();
