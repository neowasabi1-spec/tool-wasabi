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
function run(cmd, args, { capture = 'stderr', cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, cwd });
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

// ── Build jobs: assemble a NEW video from CLEAN shots + our voice/subs ──────
const TARGET_W = 1080;
const TARGET_H = 1920;

async function probeDuration(file) {
  const out = await run(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file],
    { capture: 'stdout' },
  );
  const j = JSON.parse(out || '{}');
  return parseFloat(j?.format?.duration || '0') || 0;
}

// OpenAI text-to-speech → mp3 file.
async function ttsScene(text, voice, outMp3) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required for voiceover');
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'tts-1', voice, input: text.slice(0, 900), response_format: 'mp3' }),
  });
  if (!resp.ok) throw new Error(`TTS failed ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  fs.writeFileSync(outMp3, Buffer.from(await resp.arrayBuffer()));
}

// Normalize a shot to the target canvas (cover+crop), 30fps, silent.
async function normalizeShot(src, out) {
  await run('ffmpeg', [
    '-y', '-i', src,
    '-an',
    '-vf', `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase,crop=${TARGET_W}:${TARGET_H},fps=30`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    out,
  ]);
}

function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = ms % 1000;
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(mm, 3)}`;
}

// Fill `targetDur` seconds by concatenating normalized clips (looping the pool),
// then re-encode to exactly targetDur. Returns the scene visual path.
async function buildSceneVisual(normClips, targetDur, workDir, idx, cursorRef) {
  const listFile = path.join(workDir, `scene_${idx}_list.txt`);
  let acc = 0;
  const lines = [];
  let guard = 0;
  while (acc < targetDur && guard < 200) {
    const clip = normClips[cursorRef.i % normClips.length];
    cursorRef.i++;
    guard++;
    lines.push(`file '${clip.file.replace(/\\/g, '/')}'`);
    acc += clip.dur;
  }
  fs.writeFileSync(listFile, lines.join('\n'));
  const concatFile = path.join(workDir, `scene_${idx}_cat.mp4`);
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', concatFile]);
  const sceneFile = path.join(workDir, `scene_${idx}_v.mp4`);
  await run('ffmpeg', [
    '-y', '-i', concatFile, '-t', String(targetDur),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '30', '-an',
    sceneFile,
  ]);
  return sceneFile;
}

async function loadCleanShots(projectId, workDir) {
  const { data } = await supabase
    .from('competitor_shots')
    .select('id, file_path, has_text')
    .eq('project_id', projectId)
    .not('has_text', 'is', true)
    .limit(60);
  const shots = data || [];
  const norm = [];
  for (let i = 0; i < shots.length; i++) {
    const raw = path.join(workDir, `raw_${i}.mp4`);
    const nrm = path.join(workDir, `norm_${i}.mp4`);
    try {
      await downloadSource(shots[i].file_path, raw);
      await normalizeShot(raw, nrm);
      const dur = await probeDuration(nrm);
      if (dur > 0.2) norm.push({ file: nrm, dur });
    } catch (e) {
      errlog(`shot ${shots[i].id} prep failed: ${e.message}`);
    }
  }
  return norm;
}

async function claimBuildJob() {
  const { data: pending } = await supabase
    .from('video_build_jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;
  const { data: claimed } = await supabase
    .from('video_build_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  return claimed || null;
}

async function processBuildJob(job) {
  log(`build #${job.id} — ad ${job.ad_id} (project ${job.project_id})`);
  const scenes = (Array.isArray(job.scenes) ? job.scenes : [])
    .map((s) => (s && typeof s.text === 'string' ? s.text.trim() : ''))
    .filter(Boolean);
  if (scenes.length === 0) throw new Error('no scenes in job');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbuild-'));
  try {
    const normClips = await loadCleanShots(job.project_id, workDir);
    if (normClips.length === 0) throw new Error('no usable clean shots');

    const cursor = { i: 0 };
    const sceneVisuals = [];
    const sceneAudios = [];
    const srt = [];
    let t = 0;
    for (let i = 0; i < scenes.length; i++) {
      const mp3 = path.join(workDir, `vo_${i}.mp3`);
      await ttsScene(scenes[i], job.voice || 'alloy', mp3);
      const d = Math.max(0.8, await probeDuration(mp3));
      const vis = await buildSceneVisual(normClips, d, workDir, i, cursor);
      sceneVisuals.push(vis);
      sceneAudios.push(mp3);
      srt.push(`${i + 1}\n${srtTime(t)} --> ${srtTime(t + d)}\n${scenes[i]}\n`);
      t += d;
    }

    // Concat visuals (identical params → stream copy).
    const vList = path.join(workDir, 'v_list.txt');
    fs.writeFileSync(vList, sceneVisuals.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
    const visual = path.join(workDir, 'visual.mp4');
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', vList, '-c', 'copy', visual]);

    // Concat voice mp3s.
    const aList = path.join(workDir, 'a_list.txt');
    fs.writeFileSync(aList, sceneAudios.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
    const voice = path.join(workDir, 'voice.mp3');
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', aList, '-c', 'copy', voice]);

    // Mux visual + voice.
    const base = path.join(workDir, 'base.mp4');
    await run('ffmpeg', [
      '-y', '-i', visual, '-i', voice,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', base,
    ]);

    // Burn OUR subtitles (bottom band also masks any residual competitor subs).
    fs.writeFileSync(path.join(workDir, 'subs.srt'), srt.join('\n'));
    const finalFile = path.join(workDir, 'final.mp4');
    const style =
      "FontSize=16,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000," +
      'BorderStyle=3,Outline=6,Shadow=0,Alignment=2,MarginV=90';
    try {
      await run(
        'ffmpeg',
        ['-y', '-i', base, '-vf', `subtitles=subs.srt:force_style='${style}'`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'copy', finalFile],
        { cwd: workDir },
      );
    } catch (e) {
      // libass missing? fall back to the un-subtitled cut rather than failing.
      errlog(`subtitle burn failed, using base: ${e.message}`);
      fs.copyFileSync(base, finalFile);
    }

    const thumb = path.join(workDir, 'thumb.jpg');
    try { await grabThumb(finalFile, 1, thumb); } catch { /* ignore */ }

    const stamp = Date.now();
    const clipKey = `${job.project_id}/generated/${job.ad_id}_${stamp}.mp4`;
    const thumbKey = `${job.project_id}/generated/${job.ad_id}_${stamp}.jpg`;
    await uploadFile(clipKey, finalFile, 'video/mp4');
    let storedThumb = '';
    try { storedThumb = await uploadFile(thumbKey, thumb, 'image/jpeg'); } catch { /* ignore */ }
    const totalDur = await probeDuration(finalFile);

    const { data: gv } = await supabase
      .from('generated_videos')
      .insert({
        project_id: job.project_id,
        brand_id: job.brand_id,
        ad_id: job.ad_id,
        file_path: clipKey,
        thumb_path: storedThumb || null,
        duration_sec: +totalDur.toFixed(2),
        script: scenes.join('\n'),
        voice: job.voice || 'alloy',
      })
      .select('id')
      .maybeSingle();

    await supabase
      .from('video_build_jobs')
      .update({ status: 'done', result_id: gv?.id || null, finished_at: new Date().toISOString() })
      .eq('id', job.id);
    log(`build #${job.id} done — ${totalDur.toFixed(1)}s`);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function loop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 1) Segmentation jobs.
    let segJob = null;
    try { segJob = await claimJob(); } catch (e) { errlog('seg claim failed:', e.message); }
    if (segJob) {
      try {
        await processJob(segJob);
      } catch (e) {
        errlog(`seg #${segJob.id} error:`, e.message);
        await supabase
          .from('video_segment_jobs')
          .update({ status: 'error', error: String(e.message).slice(0, 1000), finished_at: new Date().toISOString() })
          .eq('id', segJob.id)
          .then(() => {}, () => {});
      }
      continue;
    }

    // 2) Build jobs.
    let buildJob = null;
    try { buildJob = await claimBuildJob(); } catch (e) { errlog('build claim failed:', e.message); }
    if (buildJob) {
      try {
        await processBuildJob(buildJob);
      } catch (e) {
        errlog(`build #${buildJob.id} error:`, e.message);
        await supabase
          .from('video_build_jobs')
          .update({ status: 'error', error: String(e.message).slice(0, 1000), finished_at: new Date().toISOString() })
          .eq('id', buildJob.id)
          .then(() => {}, () => {});
      }
      continue;
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
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
