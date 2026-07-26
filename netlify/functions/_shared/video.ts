/**
 * Shared video-processing helpers for the Netlify background functions.
 *
 * Ported from the standalone `video-segment-worker.js` (which was built for an
 * always-on Node worker). On Netlify there is no persistent worker, so the
 * segmentation/build logic runs inside `-background` functions (15-min budget)
 * using the bundled ffmpeg-static / ffprobe-static binaries.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
// CJS packages — default import resolves to module.exports.
import ffmpegPathImport from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export const FFMPEG = (ffmpegPathImport as unknown as string) || 'ffmpeg';
export const FFPROBE = (ffprobeStatic as unknown as { path: string }).path || 'ffprobe';

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

export async function ffprobeInfo(file: string) {
  const out = await run(
    FFPROBE,
    ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'format=duration:stream=width,height',
      '-of', 'json', file],
    { capture: 'stdout' },
  );
  const j = JSON.parse(out || '{}');
  const duration = parseFloat(j?.format?.duration || '0') || 0;
  const st = (j.streams && j.streams[0]) || {};
  return { duration, width: st.width || null, height: st.height || null };
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
  const out = await run(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file],
    { capture: 'stdout' },
  );
  const j = JSON.parse(out || '{}');
  return parseFloat(j?.format?.duration || '0') || 0;
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

export async function normalizeShot(src: string, out: string) {
  await run(FFMPEG, [
    '-y', '-i', src, '-an',
    '-vf', `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase,crop=${TARGET_W}:${TARGET_H},fps=30`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    out,
  ]);
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

export async function buildSceneVisual(
  normClips: { file: string; dur: number }[],
  targetDur: number,
  workDir: string,
  idx: number,
  cursorRef: { i: number },
): Promise<string> {
  const listFile = path.join(workDir, `scene_${idx}_list.txt`);
  let acc = 0;
  const lines: string[] = [];
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
): Promise<{ file: string; dur: number }[]> {
  const { data } = await supabase
    .from('competitor_shots')
    .select('id, file_path, has_text')
    .eq('project_id', projectId)
    .not('has_text', 'is', true)
    .limit(60);
  const shots = data || [];
  const norm: { file: string; dur: number }[] = [];
  for (let i = 0; i < shots.length; i++) {
    const raw = path.join(workDir, `raw_${i}.mp4`);
    const nrm = path.join(workDir, `norm_${i}.mp4`);
    try {
      await downloadSource(supabase, shots[i].file_path, raw);
      await normalizeShot(raw, nrm);
      const dur = await probeDuration(nrm);
      if (dur > 0.2) norm.push({ file: nrm, dur });
    } catch { /* skip bad shot */ }
  }
  return norm;
}
