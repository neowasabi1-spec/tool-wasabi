/**
 * Shared video-processing helpers for the Netlify background functions.
 *
 * Ported from the standalone `video-segment-worker.js` (which was built for an
 * always-on Node worker). On Netlify there is no persistent worker, so the
 * segmentation/build logic runs inside `-background` functions (15-min budget)
 * using the bundled ffmpeg-static binary.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
// CJS package — default import resolves to module.exports (the binary path).
// We deliberately do NOT use ffprobe-static: it ships binaries for every OS
// (~335 MB) which blows past Netlify's 250 MB function limit. Instead we parse
// duration/size from `ffmpeg -i` stderr, so only the single ffmpeg binary ships.
import ffmpegPathImport from 'ffmpeg-static';

export const FFMPEG = (ffmpegPathImport as unknown as string) || 'ffmpeg';

export const BUCKET = 'project-files';
export const MIN_SEC = parseFloat(process.env.SEGMENT_MIN_SEC || '1.2');
export const MAX_SEC = parseFloat(process.env.SEGMENT_MAX_SEC || '6');
export const MAX_SHOTS = parseInt(process.env.SEGMENT_MAX_SHOTS || '40', 10);
export const SCENE_THRESHOLD = parseFloat(process.env.SCENE_THRESHOLD || '0.35');

export const OPENAI_API_KEY = (
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_KEY ||
  ''
).trim();

export function getSupabase(): SupabaseClient {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    'https://sktpbizpckxldhxzezws.supabase.co';
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    '';
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing (needed for storage upload)');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function run(
  cmd: string,
  args: string[],
  { capture = 'stderr', cwd }: { capture?: 'stdout' | 'stderr'; cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
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

// Probe duration + video dimensions by parsing `ffmpeg -i` stderr (avoids a
// separate ffprobe binary). ffmpeg exits non-zero when given no output, so we
// read stderr from the thrown error too.
function parseFfmpegInfo(stderr: string) {
  let duration = 0;
  const dm = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dm) duration = (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);
  let width: number | null = null;
  let height: number | null = null;
  const vm = stderr.match(/Video:.*?[,\s](\d{2,5})x(\d{2,5})/);
  if (vm) { width = parseInt(vm[1], 10); height = parseInt(vm[2], 10); }
  return { duration, width, height };
}

// `ffmpeg -i` with no output exits non-zero AND prints the "Duration:" line
// near the top, so we can't use run()'s truncated error message — capture the
// full stderr directly regardless of exit code.
function ffmpegStderrForInput(file: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', file]);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', () => resolve(err));
    p.on('close', () => resolve(err));
  });
}

export async function ffprobeInfo(file: string) {
  return parseFfmpegInfo(await ffmpegStderrForInput(file));
}

export async function detectScenes(file: string): Promise<number[]> {
  let stderr = '';
  try {
    stderr = await run(FFMPEG, [
      '-i', file,
      '-filter_complex', `select='gt(scene,${SCENE_THRESHOLD})',metadata=print`,
      '-an', '-f', 'null', '-',
    ]);
  } catch (e) {
    stderr = String((e as Error).message || '');
  }
  const times: number[] = [];
  const re = /pts_time:([0-9]+\.?[0-9]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const t = parseFloat(m[1]);
    if (Number.isFinite(t) && t > 0) times.push(t);
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

export function buildSegments(cuts: number[], duration: number): [number, number][] {
  const bounds = [0, ...cuts.filter((t) => t < duration - 0.05), duration];
  let segs: [number, number][] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    let start = bounds[i];
    const end = bounds[i + 1];
    if (end - start < 0.3) continue;
    while (end - start > MAX_SEC + 0.5) {
      segs.push([start, start + MAX_SEC]);
      start += MAX_SEC;
    }
    segs.push([start, end]);
  }
  segs = segs.filter(([s, e]) => e - s >= MIN_SEC);
  if (segs.length === 0 && duration > MIN_SEC) {
    for (let s = 0; s < duration; s += MAX_SEC) {
      const e = Math.min(s + MAX_SEC, duration);
      if (e - s >= MIN_SEC) segs.push([s, e]);
    }
  }
  return segs.slice(0, MAX_SHOTS);
}

export async function cutClip(src: string, start: number, end: number, outFile: string) {
  await run(FFMPEG, [
    '-y', '-ss', String(start), '-to', String(end), '-i', src,
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    outFile,
  ]);
}

export async function grabThumb(src: string, atSec: number, outFile: string) {
  await run(FFMPEG, ['-y', '-ss', String(atSec), '-i', src, '-frames:v', '1', '-q:v', '3', outFile]);
}

export async function detectBurnedText(thumbPath: string) {
  if (!OPENAI_API_KEY) return { hasText: null as boolean | null, score: null as number | null, region: '' };
  try {
    const b64 = fs.readFileSync(thumbPath).toString('base64');
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 60,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text:
              'Does this video frame contain burned-in subtitle/caption text overlaid on the footage? ' +
              'Reply ONLY compact JSON: {"text":true|false,"conf":0..1,"region":"top|center|bottom|"}. ' +
              'Ignore small logos/watermarks; only large readable caption words count.' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
          ],
        }],
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
  } catch {
    return { hasText: null as boolean | null, score: null as number | null, region: '' };
  }
}

// Single Vision call per shot: detects burned-in subtitles AND produces a short
// name, a caption and content tags (people/objects/setting/action) so the video
// builder can match footage to the scene text. Falls back gracefully.
export async function analyzeShot(thumbPath: string): Promise<{
  hasText: boolean | null;
  score: number | null;
  region: string;
  label: string;
  caption: string;
  tags: string[];
}> {
  const empty = { hasText: null as boolean | null, score: null as number | null, region: '', label: '', caption: '', tags: [] as string[] };
  if (!OPENAI_API_KEY) return empty;
  try {
    const b64 = fs.readFileSync(thumbPath).toString('base64');
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 220,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text:
              'Analyze this single video frame. Reply ONLY compact minified JSON with keys: ' +
              '"text" (true if large readable burned-in subtitle/caption words are overlaid, ignore small logos/watermarks), ' +
              '"conf" (0..1), "region" ("top"|"center"|"bottom"|""), ' +
              '"band" (if text=true: [y0,y1] vertical extent of ALL overlay text as fractions of frame height, 0=top 1=bottom; else []), ' +
              '"label" (2-4 word title of the shot), ' +
              '"caption" (one short sentence describing what is shown), ' +
              '"tags" (array of 3-8 lowercase keywords: named people if recognizable e.g. "trump", plus objects, setting, action, emotion). ' +
              'Example: {"text":true,"conf":0.9,"region":"bottom","band":[0.72,0.94],"label":"Man holding phone","caption":"A bearded man talks to camera holding a smartphone","tags":["man","phone","talking head","indoor"]}' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
          ],
        }],
      }),
    });
    const j = await resp.json();
    const raw = j?.choices?.[0]?.message?.content || '';
    const clean = raw.replace(/```json?/gi, '').replace(/```/g, '').trim();
    const p = JSON.parse(clean);
    const tags = Array.isArray(p.tags)
      ? p.tags.map((t: unknown) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 8)
      : [];
    // Encode the text band inside the region string ("bottom 0.72-0.94") so the
    // builder can crop the exact strip away without a schema change.
    let region = typeof p.region === 'string' ? p.region : '';
    if (p.text && Array.isArray(p.band) && p.band.length === 2) {
      const y0 = Number(p.band[0]);
      const y1 = Number(p.band[1]);
      if (Number.isFinite(y0) && Number.isFinite(y1) && y0 >= 0 && y1 <= 1 && y1 > y0) {
        region = `${region || (y0 > 0.5 ? 'bottom' : y1 < 0.5 ? 'top' : 'center')} ${y0.toFixed(2)}-${y1.toFixed(2)}`;
      }
    }
    return {
      hasText: !!p.text,
      score: typeof p.conf === 'number' ? p.conf : p.text ? 0.8 : 0.1,
      region,
      label: typeof p.label === 'string' ? p.label.slice(0, 80) : '',
      caption: typeof p.caption === 'string' ? p.caption.slice(0, 300) : '',
      tags,
    };
  } catch {
    return empty;
  }
}

export async function downloadSource(
  supabase: SupabaseClient,
  filePath: string,
  tmpFile: string,
) {
  if (/^https?:\/\//i.test(filePath)) {
    const resp = await fetch(filePath);
    if (!resp.ok) throw new Error(`source fetch ${resp.status}`);
    fs.writeFileSync(tmpFile, Buffer.from(await resp.arrayBuffer()));
    return;
  }
  const { data, error } = await supabase.storage.from(BUCKET).download(filePath);
  if (error || !data) throw new Error(`storage download failed: ${error?.message || 'no data'}`);
  fs.writeFileSync(tmpFile, Buffer.from(await data.arrayBuffer()));
}

export async function uploadFile(
  supabase: SupabaseClient,
  objectKey: string,
  localFile: string,
  contentType: string,
): Promise<string> {
  const bytes = fs.readFileSync(localFile);
  const { error } = await supabase.storage.from(BUCKET).upload(objectKey, bytes, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`upload failed: ${error.message}`);
  return objectKey;
}

export function makeWorkDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── Build (recreate video) helpers ──────────────────────────────────────────
export const TARGET_W = 1080;
export const TARGET_H = 1920;

export async function probeDuration(file: string): Promise<number> {
  return parseFfmpegInfo(await ffmpegStderrForInput(file)).duration;
}

export async function ttsScene(text: string, voice: string, outMp3: string) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required for voiceover');
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'tts-1', voice, input: text.slice(0, 900), response_format: 'mp3' }),
  });
  if (!resp.ok) throw new Error(`TTS failed ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  fs.writeFileSync(outMp3, Buffer.from(await resp.arrayBuffer()));
}

export async function normalizeShot(src: string, out: string, preFilter?: string) {
  const chain =
    `${preFilter ? preFilter + ',' : ''}` +
    `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase,crop=${TARGET_W}:${TARGET_H},fps=30`;
  await run(FFMPEG, [
    '-y', '-i', src, '-an',
    '-vf', chain,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    out,
  ]);
}

/**
 * Build an ffmpeg crop that removes a burned-in subtitle band from the TOP or
 * BOTTOM of the frame (the remaining picture is then re-zoomed to 9:16 by
 * normalizeShot). Returns null when the text can't be cropped away cleanly
 * (center text, or a band that would eat too much of the frame).
 *
 * Accepts the region string stored on competitor_shots — either a plain label
 * ("bottom") or label + measured band ("bottom 0.72-0.94").
 */
export function desubPreFilter(textRegion: string | null | undefined): string | null {
  const raw = (textRegion || '').trim().toLowerCase();
  if (!raw) return null;
  const m = raw.match(/^(top|bottom|center)(?:\s+([01]?\.\d+)-([01]?\.\d+))?/);
  if (!m) return null;
  const region = m[1];
  const y0 = m[2] !== undefined ? parseFloat(m[2]) : NaN;
  const y1 = m[3] !== undefined ? parseFloat(m[3]) : NaN;

  if (region === 'bottom') {
    // Keep everything above the band. Default cut at 68% when unmeasured.
    let keep = Number.isFinite(y0) ? y0 - 0.02 : 0.68;
    keep = Math.min(keep, 0.95);
    if (keep < 0.55) return null; // band reaches too high — crop would ruin the shot
    return `crop=iw:floor(ih*${keep.toFixed(2)}/2)*2:0:0`;
  }
  if (region === 'top') {
    // Keep everything below the band. Default cut at 25% when unmeasured.
    let cut = Number.isFinite(y1) ? y1 + 0.02 : 0.25;
    cut = Math.max(cut, 0.05);
    if (cut > 0.4) return null;
    return `crop=iw:floor(ih*${(1 - cut).toFixed(2)}/2)*2:0:floor(ih*${cut.toFixed(2)}/2)*2`;
  }
  return null; // center text: no clean crop possible
}

export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = ms % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(mm, 3)}`;
}

// Generate a single AI still image (portrait) related to the scene text.
// Used only as a fallback when the real-footage pool is exhausted.
export async function genAiImage(prompt: string, outPng: string): Promise<void> {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required for AI b-roll fallback');
  const clean = (prompt || 'lifestyle b-roll').replace(/\s+/g, ' ').trim().slice(0, 700);
  const fullPrompt =
    'Photorealistic cinematic vertical b-roll photograph, natural lighting, ' +
    `shallow depth of field, no text, no captions, no watermark. Scene: ${clean}`;

  // Try gpt-image-1 first (returns b64), then fall back to dall-e-3 (URL) so a
  // single unavailable model doesn't fail the whole build.
  const attempts: Array<{ model: string; size: string; wantsFormat: boolean }> = [
    { model: 'gpt-image-1', size: '1024x1536', wantsFormat: false },
    { model: 'dall-e-3', size: '1024x1792', wantsFormat: true },
  ];
  let lastErr = 'unknown';
  for (const a of attempts) {
    try {
      const payload: Record<string, unknown> = { model: a.model, prompt: fullPrompt, size: a.size, n: 1 };
      if (a.wantsFormat) payload.response_format = 'b64_json';
      const resp = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) { lastErr = `${a.model} ${resp.status}: ${(await resp.text()).slice(0, 160)}`; continue; }
      const j = await resp.json();
      const item = j?.data?.[0];
      if (item?.b64_json) {
        fs.writeFileSync(outPng, Buffer.from(item.b64_json, 'base64'));
        return;
      }
      if (item?.url) {
        const img = await fetch(item.url);
        if (img.ok) { fs.writeFileSync(outPng, Buffer.from(await img.arrayBuffer())); return; }
      }
      lastErr = `${a.model}: no image data`;
    } catch (e) {
      lastErr = `${a.model}: ${(e as Error).message}`;
    }
  }
  throw new Error(`image gen failed — ${lastErr}`);
}

// Turn an AI image into a normalized clip (same codec/params as real shots) with
// a subtle slow zoom so it isn't a dead still. Returns { file, dur }.
export async function aiClip(
  prompt: string,
  dur: number,
  workDir: string,
  tag: string,
): Promise<{ file: string; dur: number }> {
  const png = path.join(workDir, `${tag}.png`);
  await genAiImage(prompt, png);
  const d = Math.max(0.6, dur);
  const frames = Math.max(1, Math.round(d * 30));
  const raw = path.join(workDir, `${tag}_raw.mp4`);
  // Ken-Burns style slow zoom on the still, output at TARGET size / 30fps.
  await run(FFMPEG, [
    '-y', '-loop', '1', '-i', png, '-t', String(d),
    '-vf',
    `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase,` +
      `crop=${TARGET_W}:${TARGET_H},` +
      `zoompan=z='min(zoom+0.0007,1.12)':d=${frames}:s=${TARGET_W}x${TARGET_H}:fps=30,` +
      `format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '30', '-an',
    raw,
  ]);
  // Run through normalizeShot so params are byte-identical to real clips
  // (required for the concat -c copy step to succeed).
  const nrm = path.join(workDir, `${tag}.mp4`);
  await normalizeShot(raw, nrm);
  return { file: nrm, dur: d };
}

export type ShotClip = { file: string; dur: number; tags: string[]; caption: string };

function tokenize(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

// Choose UNIQUE shots for one scene, preferring those whose tags/caption match
// the scene text (so a "trump" scene pulls trump footage). Marks chosen shots in
// `used` so no shot repeats across the video, and takes at most ONE shot per
// matched tag within a scene (avoids stacking 3-4 near-identical clips).
export function pickShotsForScene(
  pool: ShotClip[],
  used: Set<number>,
  sceneText: string,
  targetDur: number,
): { files: string[]; dur: number } {
  const words = tokenize(sceneText);
  const scored = pool
    .map((s, idx) => {
      const matched = (s.tags || []).filter((t) => words.has(t.toLowerCase()));
      const capHits = [...tokenize(s.caption)].filter((w) => words.has(w));
      return { idx, s, score: matched.length * 3 + capHits.length, primary: matched[0]?.toLowerCase() || '' };
    })
    .filter((c) => !used.has(c.idx))
    // relevant first; stable order otherwise so generic scenes stay sequential
    .sort((a, b) => b.score - a.score);

  const files: string[] = [];
  let acc = 0;
  const usedTags = new Set<string>();
  for (const c of scored) {
    if (acc >= targetDur - 0.05) break;
    // Don't stack multiple shots that matched the same tag in one scene.
    if (c.primary && usedTags.has(c.primary) && files.length > 0) continue;
    used.add(c.idx);
    files.push(c.s.file);
    acc += c.s.dur;
    if (c.primary) usedTags.add(c.primary);
  }
  return { files, dur: acc };
}

// Assemble one scene's visual track from a pre-chosen list of clip files. If the
// chosen real footage doesn't cover the scene duration, fill the rest with AI
// b-roll generated from the scene text.
export async function buildSceneVisual(
  chosenFiles: string[],
  chosenDur: number,
  targetDur: number,
  workDir: string,
  idx: number,
  aiPrompt = '',
): Promise<string> {
  const parts = [...chosenFiles];
  let acc = chosenDur;
  if (acc < targetDur - 0.05) {
    const ai = await aiClip(aiPrompt, targetDur - acc, workDir, `ai_${idx}`);
    parts.push(ai.file);
    acc += ai.dur;
  }
  if (parts.length === 0) {
    const ai = await aiClip(aiPrompt, targetDur, workDir, `ai_${idx}`);
    parts.push(ai.file);
  }

  const listFile = path.join(workDir, `scene_${idx}_list.txt`);
  fs.writeFileSync(listFile, parts.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
  const concatFile = path.join(workDir, `scene_${idx}_cat.mp4`);
  await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', concatFile]);
  const sceneFile = path.join(workDir, `scene_${idx}_v.mp4`);
  await run(FFMPEG, [
    '-y', '-i', concatFile, '-t', String(targetDur),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '30', '-an',
    sceneFile,
  ]);
  return sceneFile;
}

export async function loadCleanShots(
  supabase: SupabaseClient,
  projectId: string,
  workDir: string,
): Promise<ShotClip[]> {
  // Fetch ALL shots: clean ones are used as-is; subtitled ones with the text at
  // the top/bottom get the band cropped away (de-sub) and re-zoomed to 9:16.
  // Center-text shots are skipped (no clean crop possible).
  const { data } = await supabase
    .from('competitor_shots')
    .select('*')
    .eq('project_id', projectId)
    .limit(90);
  const shots = (data || []) as Array<{
    file_path: string; has_text?: boolean | null; text_region?: string | null;
    tags?: string[]; caption?: string;
  }>;
  const cleanPool: ShotClip[] = [];
  const desubbedPool: ShotClip[] = [];
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const subbed = s.has_text === true;
    let pre: string | undefined;
    if (subbed) {
      const filter = desubPreFilter(s.text_region);
      if (!filter) continue; // center text or band too big — unusable
      pre = filter;
    }
    const raw = path.join(workDir, `raw_${i}.mp4`);
    const nrm = path.join(workDir, `norm_${i}.mp4`);
    try {
      await downloadSource(supabase, s.file_path, raw);
      await normalizeShot(raw, nrm, pre);
      const dur = await probeDuration(nrm);
      if (dur > 0.2) {
        (subbed ? desubbedPool : cleanPool).push({
          file: nrm,
          dur,
          tags: Array.isArray(s.tags) ? (s.tags as string[]) : [],
          caption: typeof s.caption === 'string' ? (s.caption as string) : '',
        });
      }
    } catch { /* skip bad shot */ }
  }
  // Truly clean footage first; de-subbed (zoomed) shots as backup.
  return [...cleanPool, ...desubbedPool];
}
