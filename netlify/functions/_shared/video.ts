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
/** Hard cap only as a last-resort safety net — shots follow the action, not a clock. */
export const MAX_SEC = parseFloat(process.env.SEGMENT_MAX_SEC || '45');
export const MAX_SHOTS = parseInt(process.env.SEGMENT_MAX_SHOTS || '40', 10);
export const SCENE_THRESHOLD = parseFloat(process.env.SCENE_THRESHOLD || '0.42');

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
  // Keep real camera cuts. Do NOT slice on a clock (old 2s/6s chunks produced
  // meaningless fragments the builder then matched to copy by tag overlap).
  const merged: number[] = [];
  for (const t of cuts.filter((x) => x > 0.45 && x < duration - 0.45).sort((a, b) => a - b)) {
    if (merged.length && t - merged[merged.length - 1] < 0.85) continue;
    merged.push(t);
  }
  const bounds = [0, ...merged, duration];
  const segs: [number, number][] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (end - start < MIN_SEC) {
      if (segs.length) segs[segs.length - 1][1] = end;
      continue;
    }
    segs.push([start, end]);
  }
  if (segs.length === 0 && duration >= Math.min(MIN_SEC, duration)) {
    return duration > 0.4 ? [[0, duration]] : [];
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

export async function grabThumb(src: string, atSec: number, outFile: string, width = 0) {
  const args = ['-y', '-ss', String(Math.max(0, atSec)), '-i', src, '-frames:v', '1', '-q:v', '2'];
  if (width > 0) args.push('-vf', `scale=${width}:-2`);
  args.push(outFile);
  await run(FFMPEG, args);
}

function fileOk(p: string): boolean {
  try { return fs.existsSync(p) && fs.statSync(p).size > 80; } catch { return false; }
}

/** Lower ~half of the frame, where CapCut/TikTok captions almost always sit. */
export async function grabBottomCrop(src: string, atSec: number, outFile: string) {
  await run(FFMPEG, [
    '-y', '-ss', String(Math.max(0, atSec)), '-i', src,
    '-frames:v', '1', '-q:v', '2',
    '-vf', 'crop=iw:ih*0.48:0:ih*0.52,scale=720:-2',
    outFile,
  ]);
}

/**
 * Mid thumb (stored) plus extra frames + a bottom crop so overlay captions
 * are actually readable by vision. Old 360px / midpoint-only sampling missed
 * word-by-word TikTok captions.
 */
export async function grabDetectionFrames(
  src: string,
  start: number,
  end: number,
  workDir: string,
  prefix: string,
): Promise<{ thumb: string; extras: string[] }> {
  const span = Math.max(0.2, end - start);
  const mid = start + span / 2;
  const thumb = path.join(workDir, `${prefix}.jpg`);
  await grabThumb(src, mid, thumb, 720);
  const extras: string[] = [];
  const extraTimes = [...new Set([
    start + Math.min(0.35, span * 0.12),
    end - Math.min(0.35, span * 0.12),
  ].map((t) => +t.toFixed(2)))].filter((t) => Math.abs(t - mid) > 0.18);
  for (let i = 0; i < extraTimes.length; i++) {
    const f = path.join(workDir, `${prefix}_e${i}.jpg`);
    try {
      await grabThumb(src, extraTimes[i], f, 720);
      if (fileOk(f)) extras.push(f);
    } catch { /* optional */ }
  }
  const crop = path.join(workDir, `${prefix}_bot.jpg`);
  try {
    await grabBottomCrop(src, mid, crop);
    if (fileOk(crop)) extras.push(crop);
  } catch { /* optional */ }
  return { thumb, extras };
}

/** True when vision transcribed overlay words that are captions, not a logo. */
export function overlayLooksLikeCaption(raw: unknown): boolean {
  const s = String(raw || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@[\w.]+/g, ' ')
    .replace(/\b(tiktok|instagram|facebook|meta|capcut|watermark|logo)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < 3) return false;
  const words = s.split(' ').filter((w) => w.length >= 2);
  return words.length >= 1 && /[\p{L}]{3,}/u.test(s);
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
              'Read ANY words painted onto this video frame (TikTok/CapCut captions, karaoke word-by-word, outlined yellow/white text, lower-thirds, CTA stickers). ' +
              'A tiny corner logo or @handle alone does not count. If you can read a phrase, text=true. ' +
              'Reply ONLY JSON: {"text":true|false,"conf":0..1,"region":"top|center|bottom|","overlayText":"words or empty"}.' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' } },
          ],
        }],
      }),
    });
    const j = await resp.json();
    const raw = j?.choices?.[0]?.message?.content || '';
    const clean = raw.replace(/```json?/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    const overlay = typeof parsed.overlayText === 'string' ? parsed.overlayText : '';
    const hasText = !!(parsed.text || overlayLooksLikeCaption(overlay));
    return {
      hasText,
      score: typeof parsed.conf === 'number' ? parsed.conf : hasText ? 0.9 : 0.95,
      region: typeof parsed.region === 'string' && parsed.region
        ? parsed.region
        : (hasText ? 'bottom' : ''),
    };
  } catch {
    return { hasText: null as boolean | null, score: null as number | null, region: '' };
  }
}

// Single Vision call per shot: detects burned-in subtitles AND produces a short
// name, a caption and content tags (people/objects/setting/action) so the video
// builder can match footage to the scene text. Falls back gracefully.
export type ShotScene = {
  action: string;
  peopleCount: number;
  people: string;
  context: string;
  label: string;
  caption: string;
  tags: string[];
};

export async function analyzeShot(thumbPath: string, extraThumbs: string[] = []): Promise<{
  hasText: boolean | null;
  score: number | null;
  region: string;
} & ShotScene> {
  const empty = {
    hasText: null as boolean | null, score: null as number | null, region: '',
    action: '', peopleCount: 0, people: '', context: '', label: '', caption: '', tags: [] as string[],
  };
  if (!OPENAI_API_KEY) return empty;
  const paths = [thumbPath, ...extraThumbs].filter((p) => {
    try { return fs.existsSync(p) && fs.statSync(p).size > 80; } catch { return false; }
  });
  if (paths.length === 0) return empty;
  try {
    const images = paths.map((p) => ({
      type: 'image_url' as const,
      image_url: {
        url: `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}`,
        detail: 'high' as const,
      },
    }));
    const frameHint = paths.length > 1
      ? `You are seeing ${paths.length} images from the SAME shot. Early ones are chronological frames; the last may be a crop of the LOWER HALF (where TikTok/CapCut captions sit). Describe the action across the full frames.`
      : 'Analyze this single video frame as one shot.';
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 480,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text:
              `${frameHint} Reply ONLY JSON with keys:\n` +
              '"overlayText" (quote EVERY burned-in overlay phrase you can read: captions, karaoke/word-by-word, outlined yellow/white text, lower-thirds, CTA stickers. Empty only if none),\n' +
              '"text" (true if overlayText is non-empty. Tiny corner logos/@handles alone = false. Do NOT ignore captions because they look "part of the ad" — they MUST be reported),\n' +
              '"conf" (0..1), "region" ("top"|"center"|"bottom"|""),\n' +
              '"band" (if text: [y0,y1] 0=top 1=bottom else []),\n' +
              '"action" (what is happening, verb phrase, e.g. "holds a lemon up to the camera and smiles"),\n' +
              '"peopleCount" (integer, 0 if none),\n' +
              '"people" (who: age/gender vibe, count, roles — empty if none),\n' +
              '"context" (setting + genre: kitchen UGC, clinic demo, news desk, product packshot…),\n' +
              '"label" (2-5 word title),\n' +
              '"caption" (one sentence: who + action + where),\n' +
              '"tags" (3-8 lowercase keywords).\n' +
              'Do not invent a second scene. If people talk to camera, say so.' },
            ...images,
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
    const overlay = typeof p.overlayText === 'string' ? p.overlayText : '';
    const hasText = !!(p.text || overlayLooksLikeCaption(overlay));
    let region = typeof p.region === 'string' ? p.region : '';
    if (hasText && Array.isArray(p.band) && p.band.length === 2) {
      const y0 = Number(p.band[0]);
      const y1 = Number(p.band[1]);
      if (Number.isFinite(y0) && Number.isFinite(y1) && y0 >= 0 && y1 <= 1 && y1 > y0) {
        region = `${region || (y0 > 0.5 ? 'bottom' : y1 < 0.5 ? 'top' : 'center')} ${y0.toFixed(2)}-${y1.toFixed(2)}`;
      }
    }
    if (hasText && !region) region = 'bottom 0.62-0.92';
    const peopleCount = Math.max(0, Math.min(12, Number(p.peopleCount) || 0));
    // Confident "no overlay" must score high so we don't re-scan forever;
    // old false-negatives used ~0.1 and will be re-checked once.
    const conf = typeof p.conf === 'number' ? p.conf : hasText ? 0.9 : 0.95;
    return {
      hasText,
      score: hasText ? conf : Math.max(conf, 0.95),
      region,
      action: typeof p.action === 'string' ? p.action.slice(0, 240) : '',
      peopleCount,
      people: typeof p.people === 'string' ? p.people.slice(0, 180) : '',
      context: typeof p.context === 'string' ? p.context.slice(0, 180) : '',
      label: typeof p.label === 'string' ? p.label.slice(0, 80) : '',
      caption: typeof p.caption === 'string' ? p.caption.slice(0, 400) : '',
      tags,
    };
  } catch {
    return empty;
  }
}

export type PlannedShot = ShotScene & { start: number; end: number };

/**
 * Sample frames across the video and ask vision to cut on ACTION changes,
 * not on a clock. ffmpeg scene cuts are hints (hard camera cuts) only.
 */
export async function planShotsFromVideo(
  srcFile: string,
  duration: number,
  hintCuts: number[],
  workDir: string,
): Promise<PlannedShot[] | null> {
  if (!OPENAI_API_KEY || duration < 0.6) return null;
  const n = Math.min(16, Math.max(4, Math.round(duration / 2.8)));
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = Math.min(duration - 0.05, Math.max(0.04, (duration * (i + 0.5)) / n));
    times.push(+t.toFixed(2));
  }
  for (const c of hintCuts) {
    if (c > 0.3 && c < duration - 0.3) times.push(+(c + 0.12).toFixed(2));
  }
  const sampleAt = [...new Set(times)].sort((a, b) => a - b).slice(0, 18);

  const frames: { t: number; file: string }[] = [];
  for (let i = 0; i < sampleAt.length; i++) {
    const file = path.join(workDir, `plan_${i}.jpg`);
    try {
      await grabThumb(srcFile, sampleAt[i], file, 360);
      if (fs.existsSync(file) && fs.statSync(file).size > 80) frames.push({ t: sampleAt[i], file });
    } catch { /* skip a bad frame */ }
  }
  if (frames.length < 3) return null;

  try {
    const content: Array<Record<string, unknown>> = [{
      type: 'text',
      text:
        `This is a competitor ad video ${duration.toFixed(1)}s long. Frames are chronological, each labeled with its timestamp.\n` +
        (hintCuts.length
          ? `ffmpeg guessed camera cuts at: ${hintCuts.map((t) => t.toFixed(1)).join(', ')}s — treat as HINTS only.\n`
          : '') +
        'Split into SHOTS by ACTION, not by the clock.\n' +
        'Rules:\n' +
        '- One shot = one continuous action / same people / same setting.\n' +
        '- Do NOT cut every 2 seconds. If she holds a product and talks for 7s, that is ONE shot.\n' +
        '- Cut when people, setting, or the action clearly change (new beat).\n' +
        '- Ignore a camera cut if the same action continues. Cut without a camera cut if the action changes.\n' +
        `- Minimum shot ${MIN_SEC}s. Cover 0.00 through ${duration.toFixed(2)} with no gaps.\n` +
        '- Prefer fewer meaningful shots over fragments.\n' +
        'Reply ONLY JSON: {"shots":[{"start":0,"end":4.2,"action":"...","peopleCount":1,"people":"...","context":"...","label":"...","caption":"...","tags":["a","b"]}]}',
    }];
    for (const f of frames) {
      content.push({ type: 'text', text: `t=${f.t.toFixed(2)}s` });
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(f.file).toString('base64')}` },
      });
    }
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 1800,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content }],
      }),
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    const raw = j?.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(raw.replace(/```json?/gi, '').replace(/```/g, '').trim());
    const rows = Array.isArray(parsed?.shots) ? parsed.shots : [];
    const out: PlannedShot[] = [];
    for (const r of rows) {
      let start = Number(r?.start);
      let end = Number(r?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      start = Math.max(0, Math.min(duration, start));
      end = Math.max(0, Math.min(duration, end));
      if (end - start < MIN_SEC * 0.7) continue;
      const tags = Array.isArray(r.tags)
        ? r.tags.map((t: unknown) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 8)
        : [];
      out.push({
        start: +start.toFixed(2),
        end: +end.toFixed(2),
        action: String(r.action || '').slice(0, 240),
        peopleCount: Math.max(0, Math.min(12, Number(r.peopleCount) || 0)),
        people: String(r.people || '').slice(0, 180),
        context: String(r.context || '').slice(0, 180),
        label: String(r.label || '').slice(0, 80),
        caption: String(r.caption || '').slice(0, 400),
        tags,
      });
    }
    out.sort((a, b) => a.start - b.start);
    if (out.length === 0) return null;
    // Close gaps so the whole video is covered without clock-slicing leftovers.
    out[0].start = 0;
    out[out.length - 1].end = +duration.toFixed(2);
    for (let i = 1; i < out.length; i++) {
      const gap = out[i].start - out[i - 1].end;
      if (Math.abs(gap) < 0.45 || gap > 0) {
        const mid = +((out[i - 1].end + out[i].start) / 2).toFixed(2);
        out[i - 1].end = mid;
        out[i].start = mid;
      }
    }
    return out.filter((s) => s.end - s.start >= MIN_SEC).slice(0, MAX_SHOTS);
  } catch {
    return null;
  } finally {
    for (const f of frames) {
      try { fs.rmSync(f.file, { force: true }); } catch { /* ignore */ }
    }
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

/**
 * Keep the source aspect ratio (landscape stays landscape). Caps the long side
 * at 1920 so a 4K file does not explode encode time, never crops to 9:16.
 */
export async function keepSourceFrame(src: string, out: string): Promise<{ w: number; h: number }> {
  const info = await ffprobeInfo(src);
  let w = info.width || TARGET_W;
  let h = info.height || TARGET_H;
  w = Math.max(2, w & ~1);
  h = Math.max(2, h & ~1);
  const long = Math.max(w, h);
  if (long > 1920) {
    const s = 1920 / long;
    w = Math.max(2, Math.round(w * s) & ~1);
    h = Math.max(2, Math.round(h * s) & ~1);
  }
  await run(FFMPEG, [
    '-y', '-i', src, '-an',
    '-vf', `scale=${w}:${h}:flags=lanczos,setsar=1,fps=30`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    out,
  ]);
  return { w, h };
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
  action?: string;
  peopleCount?: number;
  people?: string;
  context?: string;
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
    .map((s, i) => {
      const who = s.peopleCount
        ? `${s.peopleCount} people${s.people ? ` (${s.people})` : ''}`
        : (s.people || 'no people');
      return `${i}\t${s.section}\taction:${(s.action || '').slice(0, 80)}\t${who}\tctx:${(s.context || '').slice(0, 70)}\t${(s.caption || s.label || '').slice(0, 90)}`;
    })
    .join('\n');
  const scenes = sceneTexts.map((t, i) => `${i}\t${t}`).join('\n');
  const prompt =
    'You assign B-roll shots to the lines of a short video script.\n' +
    'Each SHOT is a real scene (who is on screen, what they are doing, where) — not a tag list.\n' +
    'SHOTS (index, section, action, people, context, caption):\n' + catalog + '\n\n' +
    'SCRIPT LINES (index, text):\n' + scenes + '\n\n' +
    'For each script line pick the 1-2 shots whose SCENE (action + people + setting) fits ' +
    'what the line is talking about. Match meaning: a line about a wife/family → a family scene, ' +
    'a line about using the product → someone handling the product. Do not match on shared keywords alone.\n' +
    'Prefer section "hook" for the first lines and "cta" for the last. Never reuse a shot index.\n' +
    'Reply ONLY minified JSON: {"map":[{"s":0,"shots":[12,4]},{"s":1,"shots":[7]}]} with one entry per line.';
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
// (hook / body / cta), then by how well the stored SCENE (action + people +
// context) matches the spoken line. Tags are a weak extra signal only.
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
      const blob = [s.action, s.people, s.context, s.caption, s.label, ...(s.tags || [])].join(' ');
      const sceneHits = [...tokenize(blob)].filter((w) => words.has(w));
      const matched = (s.tags || []).filter((t) => words.has(t.toLowerCase()));
      return {
        idx, s,
        score: sceneHits.length * 2 + matched.length,
        rank: sectionRank(s.section, wantSection),
        primary: matched[0]?.toLowerCase() || tokenize(s.action).values().next().value || '',
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

  // No unused matching shot for this scene: fall back to the best UNUSED shot
  // of the wanted section (so nothing repeats), and only reuse one as a true
  // last resort if literally every shot is spent — better than failing the
  // whole build, since there is no AI filler.
  if (clips.length === 0 && pool.length > 0) {
    const idxs = pool.map((_, idx) => idx);
    const unused = idxs.filter((idx) => !used.has(idx));
    const searchable = unused.length ? unused : idxs;
    const best = searchable
      .map((idx) => {
        const s = pool[idx];
        const blob = [s.action, s.people, s.context, s.caption, s.label, ...(s.tags || [])].join(' ');
        const sceneHits = [...tokenize(blob)].filter((w) => words.has(w));
        return { idx, s, score: sceneHits.length, rank: sectionRank(s.section, wantSection) };
      })
      .sort((a, b) => a.rank - b.rank || b.score - a.score)[0];
    used.add(best.idx);
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
  const full =
    'file_path, clean_path, has_text, tags, caption, label, section, duration_sec, text_region, action, people_count, people, context';
  const base =
    'file_path, clean_path, has_text, tags, caption, label, section, duration_sec, text_region';
  let { data, error } = await supabase
    .from('competitor_shots')
    .select(full)
    .eq('project_id', projectId)
    .limit(300);
  if (error && /action|people_count|people|context/i.test(error.message || '')) {
    ({ data } = await supabase
      .from('competitor_shots')
      .select(base)
      .eq('project_id', projectId)
      .limit(300));
  }
  const shots = (data || []) as Array<{
    file_path: string; clean_path?: string | null; has_text?: boolean | null;
    tags?: string[]; caption?: string; label?: string; section?: string | null;
    duration_sec?: number | null; text_region?: string | null;
    action?: string | null; people_count?: number | null; people?: string | null; context?: string | null;
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
      action: typeof s.action === 'string' ? s.action : '',
      peopleCount: Number(s.people_count) || 0,
      people: typeof s.people === 'string' ? s.people : '',
      context: typeof s.context === 'string' ? s.context : '',
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
