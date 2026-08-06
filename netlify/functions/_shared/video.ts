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
      else {
        // Drop \r-progress spam (frame=/size= lines) so the real error —
        // usually the very last lines — survives the length cap.
        const clean = (err || out)
          .split(/\r|\n/)
          .filter((l) => l.trim() && !/^(frame=|size=|\[out#)/.test(l.trim()))
          .join('\n');
        reject(new Error(`${cmd} exited ${code}: ${clean.slice(-600)}`));
      }
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
  let fps: number | null = null;
  const fm = stderr.match(/(\d+(?:\.\d+)?)\s+fps/);
  if (fm) fps = parseFloat(fm[1]);
  return { duration, width, height, fps };
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

// Exact video frame count: decode pass to /dev/null and read the final
// "frame= N" progress line (stream-copy wouldn't print frame counters).
export async function countFrames(file: string): Promise<number> {
  let stderr = '';
  try {
    stderr = await run(FFMPEG, ['-i', file, '-map', '0:v', '-f', 'null', '-']);
  } catch (e) {
    stderr = String((e as Error).message || '');
  }
  const matches = [...stderr.matchAll(/frame=\s*(\d+)/g)];
  return matches.length ? parseInt(matches[matches.length - 1][1], 10) : 0;
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

export async function normalizeShot(src: string, out: string, postFilter?: string) {
  const chain =
    `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase,crop=${TARGET_W}:${TARGET_H},fps=30` +
    `${postFilter ? ',' + postFilter : ''}`;
  await run(FFMPEG, [
    '-y', '-i', src, '-an',
    '-vf', chain,
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

export type ShotClip = {
  /** Storage key of the clip to use: the cleaned copy when one exists. */
  key: string;
  /** Duration from the database, so choosing footage needs no download. */
  dur: number;
  tags: string[]; caption: string;
  /** Short human label of the shot, e.g. "Man in gun store". */
  label?: string;
  /** Where the shot sat in its source video: 'hook' | 'body' | 'cta'. */
  section: string;
  /**
   * Vertical centre of the shot's original caption band as a fraction of frame
   * height (0 = top, 1 = bottom), if it was measured during subtitle removal.
   * The builder puts the new subtitle back on this exact spot.
   */
  band?: number | null;
  /** Local normalized copy, once this clip was actually chosen. */
  file?: string;
};

/**
 * Vertical centre (0..1) of a stored `text_region` string, or null when it
 * carries no usable position. Accepts either an explicit "0.72-0.94" range or a
 * bare "top|center|bottom" keyword.
 */
export function parseBandCenter(region: string | null | undefined): number | null {
  const s = (region || '').trim();
  if (!s) return null;
  const range = s.match(/(\d*\.?\d+)\s*-\s*(\d*\.?\d+)/);
  if (range) return (parseFloat(range[1]) + parseFloat(range[2])) / 2;
  const kind = s.split(/\s+/)[0].toLowerCase();
  if (kind === 'top') return 0.15;
  if (kind === 'center' || kind === 'centre' || kind === 'middle') return 0.5;
  if (kind === 'bottom') return 0.82;
  return null;
}

function tokenize(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

// Which part of the story a scene belongs to, from its position in the script:
// the opening scenes are the hook, the closing ones the call to action, and
// everything between is body. Footage is then drawn from the matching part of
// the competitor videos, so hooks open the video and CTAs close it.
export function sectionForScene(idx: number, total: number): 'hook' | 'body' | 'cta' {
  if (total <= 1) return 'hook';
  if (total === 2) return idx === 0 ? 'hook' : 'cta';
  const edge = Math.max(1, Math.round(total * 0.15));
  if (idx < edge) return 'hook';
  if (idx >= total - edge) return 'cta';
  return 'body';
}

// Shots from the wanted section come first; body footage is neutral enough to
// stand in anywhere, so it is the first fallback, and only then the rest —
// running out of hook clips must not fail the scene.
function sectionRank(shotSection: string, want: string): number {
  const sec = shotSection || 'body';
  if (sec === want) return 0;
  if (sec === 'body') return 1;
  return 2;
}

/**
 * Ask an LLM to match footage to each line of the script.
 *
 * Literal tag/caption word-overlap barely works here: ad copy ("carry permit",
 * "official link", "stay safe") rarely shares words with visual tags ("veteran",
 * "gun store", "soldier"), so most scenes scored zero and fell back to plain
 * order — footage felt unrelated to what was being said. The model reads every
 * shot's label/caption/tags once and picks the visually fitting ones per line
 * (a "wife and kids" line → a family shot, "war escalating" → combat), keeping
 * hooks up front and CTAs at the end and never repeating a shot.
 *
 * Returns, for each scene, an ordered list of pool indices — or null on any
 * failure, so the caller falls back to the heuristic picker with no regression.
 */
export async function assignShotsToScenes(
  sceneTexts: string[],
  pool: ShotClip[],
): Promise<number[][] | null> {
  if (!OPENAI_API_KEY || pool.length === 0 || sceneTexts.length === 0) return null;
  const catalog = pool
    .map((s, i) => `${i}\t${s.section}\t${(s.label || '').slice(0, 40)}\t${(s.caption || '').slice(0, 90)}\t${(s.tags || []).slice(0, 6).join(',')}`)
    .join('\n');
  const scenes = sceneTexts.map((t, i) => `${i}\t${t}`).join('\n');
  const prompt =
    'You assign B-roll shots to the lines of a short video script.\n' +
    'SHOTS (index, section, label, caption, tags):\n' + catalog + '\n\n' +
    'SCRIPT LINES (index, text):\n' + scenes + '\n\n' +
    'For each script line pick the 1-3 shots whose caption/label/tags best fit ' +
    'what the line is about (meaning, not shared words). Prefer section "hook" ' +
    'for the first lines and "cta" for the last. Never use the same shot index ' +
    'for two different lines. Reply ONLY minified JSON: ' +
    '{"map":[{"s":0,"shots":[12,4]},{"s":1,"shots":[7]}, ...]} with one entry per line.';
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 1500,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    const raw = j?.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(raw.replace(/```json?/gi, '').replace(/```/g, '').trim());
    const entries = Array.isArray(parsed?.map) ? parsed.map : [];
    const out: number[][] = sceneTexts.map(() => []);
    const seen = new Set<number>();
    for (const e of entries) {
      const s = Number(e?.s);
      if (!Number.isInteger(s) || s < 0 || s >= out.length) continue;
      const ids = Array.isArray(e?.shots) ? e.shots : [];
      for (const idRaw of ids) {
        const idx = Number(idRaw);
        if (!Number.isInteger(idx) || idx < 0 || idx >= pool.length) continue;
        if (seen.has(idx)) continue; // no shot reused across scenes
        seen.add(idx);
        out[s].push(idx);
      }
    }
    // Useful only if it actually mapped a decent share of the lines.
    const covered = out.filter((a) => a.length > 0).length;
    if (covered < Math.ceil(sceneTexts.length * 0.5)) return null;
    return out;
  } catch {
    return null;
  }
}

// Choose UNIQUE shots for one scene: first from the scene's narrative section
// (hook / body / cta), then by how well tags/caption match the scene text (so a
// "trump" scene pulls trump footage). Marks chosen shots in `used` so no shot
// repeats across the video, and takes at most ONE shot per matched tag within a
// scene (avoids stacking 3-4 near-identical clips).
export function pickShotsForScene(
  pool: ShotClip[],
  used: Set<number>,
  sceneText: string,
  targetDur: number,
  wantSection: 'hook' | 'body' | 'cta' = 'body',
): { clips: ShotClip[]; dur: number; sections: string[] } {
  const words = tokenize(sceneText);
  const scored = pool
    .map((s, idx) => {
      const matched = (s.tags || []).filter((t) => words.has(t.toLowerCase()));
      const capHits = [...tokenize(s.caption)].filter((w) => words.has(w));
      return {
        idx, s,
        score: matched.length * 3 + capHits.length,
        rank: sectionRank(s.section, wantSection),
        primary: matched[0]?.toLowerCase() || '',
      };
    })
    .filter((c) => !used.has(c.idx))
    // Right section first, then relevance; stable order otherwise so generic
    // scenes stay in the order the shots appeared in the source.
    .sort((a, b) => a.rank - b.rank || b.score - a.score);

  const clips: ShotClip[] = [];
  const sections: string[] = [];
  let acc = 0;
  const usedTags = new Set<string>();
  for (const c of scored) {
    if (acc >= targetDur - 0.05) break;
    // Don't stack multiple shots that matched the same tag in one scene.
    if (c.primary && usedTags.has(c.primary) && clips.length > 0) continue;
    used.add(c.idx);
    clips.push(c.s);
    sections.push(c.s.section || 'body');
    acc += c.s.dur;
    if (c.primary) usedTags.add(c.primary);
  }

  // Pool exhausted for this scene: reuse the best shot of the wanted section as
  // an emergency (better than failing the whole build — there is no AI filler).
  if (clips.length === 0 && pool.length > 0) {
    const best = pool
      .map((s) => {
        const matched = (s.tags || []).filter((t) => words.has(t.toLowerCase()));
        return { s, score: matched.length, rank: sectionRank(s.section, wantSection) };
      })
      .sort((a, b) => a.rank - b.rank || b.score - a.score)[0];
    clips.push(best.s);
    sections.push(best.s.section || 'body');
    acc = best.s.dur;
  }
  return { clips, dur: acc, sections };
}

// Assemble one scene's visual track from a pre-chosen list of clip files. Real
// footage only — no AI-generated filler. When the clips don't fully cover the
// voiceover we keep the picture MOVING rather than freezing the last frame
// (which looked like the video stalled between shots): a small shortfall is
// filled by a gentle slow-motion stretch, a large one by looping the footage.
export async function buildSceneVisual(
  chosenFiles: string[],
  chosenDur: number,
  targetDur: number,
  workDir: string,
  idx: number,
): Promise<string> {
  if (chosenFiles.length === 0) {
    throw new Error('no shots available for scene — split more videos or upload clips in My Footage');
  }
  const listFile = path.join(workDir, `scene_${idx}_list.txt`);
  fs.writeFileSync(listFile, chosenFiles.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
  const concatFile = path.join(workDir, `scene_${idx}_cat.mp4`);
  await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', concatFile]);

  const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '30', '-an'];
  const sceneFile = path.join(workDir, `scene_${idx}_v.mp4`);
  const EPS = 0.05;
  // How much slow-motion is acceptable before it reads as unnatural. Beyond this
  // we loop the footage instead so motion stays lifelike.
  const MAX_STRETCH = 1.5;

  const input: string[] = [];
  const filter: string[] = [];
  if (chosenDur >= targetDur - EPS) {
    // Enough real footage: just trim to length. No freeze, no repeat.
  } else if (targetDur / chosenDur <= MAX_STRETCH) {
    // A little short: retime so the real footage lasts exactly the voiceover.
    filter.push('-vf', `setpts=${((targetDur + EPS) / chosenDur).toFixed(4)}*PTS`);
  } else {
    // Far too short: loop the footage to cover the gap (moving, not frozen).
    input.push('-stream_loop', '-1');
  }

  await run(FFMPEG, [
    '-y', ...input, '-i', concatFile,
    ...filter,
    '-t', String(targetDur),
    ...ENC,
    sceneFile,
  ]);
  return sceneFile;
}

/** Base URL to reach our own background functions from inside a function. */
export function selfOrigin(reqUrl?: string): string {
  let fromReq = '';
  try { fromReq = reqUrl ? new URL(reqUrl).origin : ''; } catch { /* not a URL */ }
  const raw =
    fromReq ||
    process.env.URL ||
    process.env.DEPLOY_URL ||
    process.env.DEPLOY_PRIME_URL ||
    'http://localhost:8888';
  return raw.replace(/\/$/, '');
}

/**
 * How many cleanups a single video may fire immediately. A long video yields
 * dozens of subtitled shots and Replicate rate-limits a burst that size, so the
 * rest stay queued and the scheduled drain picks them up a few at a time.
 */
const CLEAN_BURST = 4;

/**
 * Queue AI subtitle removal for shots that came out with burned-in text, so a
 * video is usable in builds without anyone pressing a button. Every shot is
 * marked pending; only the first few are fired now.
 * Returns how many were queued (0 when Replicate isn't configured or the
 * inpaint columns aren't migrated yet — the shots simply stay flagged).
 */
export async function autoCleanShots(
  supabase: SupabaseClient,
  origin: string,
  projectId: string,
  shotIds: number[],
): Promise<number> {
  if (shotIds.length === 0) return 0;
  if (!process.env.REPLICATE_API_TOKEN) return 0;

  const { error } = await supabase
    .from('competitor_shots')
    .update({ inpaint_status: 'pending', inpaint_error: null })
    .in('id', shotIds);
  if (error) return 0;

  await Promise.allSettled(
    shotIds.slice(0, CLEAN_BURST).map((shotId) =>
      fetch(`${origin}/.netlify/functions/inpaint-shot-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotId, projectId }),
      }),
    ),
  );
  return shotIds.length;
}

export async function loadShotPool(
  supabase: SupabaseClient,
  projectId: string,
): Promise<ShotClip[]> {
  // CLEAN footage only. No crop/zoom/delogo tricks: every ffmpeg-level attempt
  // at hiding burned-in subtitles produced ugly artifacts. Subtitled shots are
  // usable ONLY once AI inpainting produced a cleaned copy (clean_path) via
  // the inpaint-shot-background function.
  //
  // Metadata only: tags, caption, section and the stored duration are enough to
  // choose footage. Downloading and re-encoding the whole pool up front used to
  // take longer than the whole build and pushed a growing library past the
  // 15-minute function limit, which left builds stuck with nothing to show.
  const { data } = await supabase
    .from('competitor_shots')
    .select('file_path, clean_path, has_text, tags, caption, label, section, duration_sec, text_region')
    .eq('project_id', projectId)
    .limit(300);
  const shots = (data || []) as Array<{
    file_path: string; clean_path?: string | null; has_text?: boolean | null;
    tags?: string[]; caption?: string; label?: string; section?: string | null;
    duration_sec?: number | null; text_region?: string | null;
  }>;
  const pool: ShotClip[] = [];
  for (const s of shots) {
    // Prefer the AI-cleaned copy; fall back to the original only if it never
    // had subtitles. Subtitled shots without a cleaned copy are excluded.
    const key = s.clean_path || (s.has_text !== true ? s.file_path : null);
    if (!key) continue;
    const dur = Number(s.duration_sec);
    pool.push({
      key,
      dur: Number.isFinite(dur) && dur > 0.2 ? dur : 1.5,
      tags: Array.isArray(s.tags) ? (s.tags as string[]) : [],
      caption: typeof s.caption === 'string' ? (s.caption as string) : '',
      label: typeof s.label === 'string' ? (s.label as string) : '',
      // Rows from before sections existed can stand in anywhere.
      section: typeof s.section === 'string' && s.section ? s.section : 'body',
      band: parseBandCenter(s.text_region),
    });
  }
  return pool;
}

/**
 * Fetch and normalize one chosen clip, once. The stored duration is replaced by
 * the real one so a scene's freeze padding is computed off the actual footage.
 */
export async function materializeShot(
  supabase: SupabaseClient,
  clip: ShotClip,
  workDir: string,
  idx: number,
): Promise<string> {
  if (clip.file) return clip.file;
  const raw = path.join(workDir, `raw_${idx}.mp4`);
  const nrm = path.join(workDir, `norm_${idx}.mp4`);
  await downloadSource(supabase, clip.key, raw);
  await normalizeShot(raw, nrm);
  const dur = await probeDuration(nrm);
  if (!(dur > 0.2)) throw new Error('clip is empty after normalizing');
  clip.dur = dur;
  clip.file = nrm;
  try { fs.rmSync(raw, { force: true }); } catch { /* ignore */ }
  return nrm;
}
