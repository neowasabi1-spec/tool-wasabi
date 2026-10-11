import fs from 'fs';
import path from 'path';
import { FFMPEG, run } from './video';

export type CapStyle = 'card' | 'stroke';
export type FracBox = { left: number; top: number; width: number; height: number };
export type CaptionCue = { start: number; end: number; text: string };
export type CaptionShot = { start: number; end: number; style: CapStyle; box: FracBox };

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function clamp(n: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, n));
}

export async function sceneRanges(file: string, dur: number): Promise<Array<{ start: number; end: number }>> {
  const err = await run(FFMPEG, [
    '-i', file,
    '-filter:v', "select='gt(scene,0.28)',showinfo",
    '-f', 'null', '-',
  ], { capture: 'stderr' }).catch((e: Error) => e.message || '');
  const cuts = [0];
  for (const m of String(err).matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (t > 0.35 && t < dur - 0.25 && t - cuts[cuts.length - 1] > 0.45) cuts.push(t);
  }
  cuts.push(dur);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < cuts.length - 1 && ranges.length < 12; i++) {
    ranges.push({ start: cuts[i], end: cuts[i + 1] });
  }
  if (!ranges.length) ranges.push({ start: 0, end: dur });
  return ranges;
}

async function askStyle(jpeg: string): Promise<{ style: CapStyle | 'none'; box: FracBox }> {
  const key = process.env.ANTHROPIC_API_KEY || '';
  const fallback = { style: 'stroke' as const, box: { left: 0.12, top: 0.62, width: 0.76, height: 0.12 } };
  if (!key) return fallback;
  const b64 = fs.readFileSync(jpeg).toString('base64');
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: 'You locate burned-in captions. Reply with JSON only.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: 'Find the burned-in subtitle. style is "card" for a white filled rectangle with dark text, "stroke" for white letters with a black outline and no filled background, "none" if there is no caption. top, left, width, height are fractions of the frame and must cover the whole caption including its outline. JSON: {"style":"card|stroke|none","left":0,"top":0,"width":0,"height":0}' },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return fallback;
  const data = await res.json() as { content?: Array<{ text?: string }> };
  const text = (data.content || []).map((c) => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return fallback;
  try {
    const j = JSON.parse(m[0]) as { style?: string; left?: number; top?: number; width?: number; height?: number };
    const style = j.style === 'card' || j.style === 'none' ? j.style : 'stroke';
    const box = {
      left: clamp(Number(j.left) || 0.1, 0, 0.8),
      top: clamp(Number(j.top) || 0.6, 0, 0.9),
      width: clamp(Number(j.width) || 0.7, 0.15, 1),
      height: clamp(Number(j.height) || 0.12, 0.04, 0.45),
    };
    return { style, box };
  } catch {
    return fallback;
  }
}

function tightBox(
  hits: Array<{ x: number; y: number }>,
  w: number,
  h: number,
): FracBox | null {
  if (hits.length < 30) return null;
  const xs = hits.map((p) => p.x);
  const ys = hits.map((p) => p.y);
  const left = Math.min(...xs) / w;
  const right = Math.max(...xs) / w;
  const top = Math.min(...ys) / h;
  const bottom = Math.max(...ys) / h;
  return {
    left: clamp(left - 0.02, 0, 0.9),
    top: clamp(top - 0.01, 0, 0.9),
    width: clamp(right - left + 0.04, 0.12, 1),
    height: clamp(bottom - top + 0.02, 0.04, 0.5),
  };
}

function measure(buf: Buffer, w: number, h: number, hint: FracBox, style: CapStyle): FracBox | null {
  const x0 = Math.max(0, Math.floor((hint.left - 0.06) * w));
  const x1 = Math.min(w - 1, Math.ceil((hint.left + hint.width + 0.06) * w));
  const y0 = Math.max(0, Math.floor((hint.top - 0.04) * h));
  const y1 = Math.min(h - 1, Math.ceil((hint.top + hint.height + 0.04) * h));
  const hits: Array<{ x: number; y: number }> = [];
  for (let y = y0; y < y1; y += 2) {
    let run = 0;
    let runStart = x0;
    for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * 3;
      const lum = buf[i] + buf[i + 1] + buf[i + 2];
      const white = lum > 700;
      if (style === 'card') {
        if (white) {
          if (run === 0) runStart = x;
          run++;
        } else if (run > (x1 - x0) / 8) {
          for (let k = 0; k < run; k += 4) hits.push({ x: runStart + k * 2, y });
          run = 0;
        } else run = 0;
      } else if (white && x + 4 < w) {
        const n = (y * w + x + 4) * 3;
        if (buf[n] + buf[n + 1] + buf[n + 2] < 140) hits.push({ x, y });
      }
    }
  }
  return tightBox(hits, w, h);
}

async function frameRaw(file: string, t: number, dest: string): Promise<void> {
  await run(FFMPEG, ['-y', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', dest]);
}

export async function readShots(
  file: string,
  dur: number,
  w: number,
  h: number,
  workDir: string,
): Promise<CaptionShot[]> {
  const ranges = await sceneRanges(file, dur);
  const shots: CaptionShot[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const mid = (ranges[i].start + ranges[i].end) / 2;
    const jpg = path.join(workDir, `scene-${i}.jpg`);
    const raw = path.join(workDir, `scene-${i}.raw`);
    await run(FFMPEG, ['-y', '-ss', mid.toFixed(3), '-i', file, '-frames:v', '1', '-q:v', '3', jpg]);
    const seen = await askStyle(jpg);
    if (seen.style === 'none') continue;
    await frameRaw(file, mid, raw);
    const buf = fs.readFileSync(raw);
    const measured = buf.length >= w * h * 3 ? measure(buf, w, h, seen.box, seen.style) : null;
    shots.push({ start: ranges[i].start, end: ranges[i].end, style: seen.style, box: measured || seen.box });
  }
  return shots;
}

function shotFor(shots: CaptionShot[], t: number): CaptionShot | null {
  return shots.find((s) => t >= s.start && t < s.end) || shots[shots.length - 1] || null;
}

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${h}:${p(m)}:${p(s)}.${p(c)}`;
}

export function buildSceneAss(cues: CaptionCue[], shots: CaptionShot[], W: number, H: number): string {
  const header = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`,
    'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Stroke,Anton,44,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,5,1,5,40,40,40,1',
    'Style: Card,Anton,40,&H00000000,&H000000FF,&H00FFFFFF,&H00FFFFFF,1,0,0,0,100,100,0,0,3,10,0,5,30,30,30,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events: string[] = [];
  for (const cue of cues) {
    const shot = shotFor(shots, (cue.start + cue.end) / 2);
    if (!shot) continue;
    const cx = Math.round((shot.box.left + shot.box.width / 2) * W);
    const cy = Math.round((shot.box.top + shot.box.height / 2) * H);
    const size = Math.max(28, Math.round(shot.box.height * H * (shot.style === 'card' ? 0.42 : 0.72)));
    const text = cue.text.replace(/[{}\\]/g, ' ').trim();
    const style = shot.style === 'card' ? 'Card' : 'Stroke';
    events.push(
      `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},${style},,0,0,0,,{\\an5\\pos(${cx},${cy})\\fs${size}}${text}`,
    );
  }
  return [...header, ...events].join('\n') + '\n';
}

export function originalStillVisible(
  before: Buffer, after: Buffer, w: number, h: number, box: FracBox,
): boolean {
  const x0 = Math.max(0, Math.floor(box.left * w));
  const x1 = Math.min(w - 5, Math.ceil((box.left + box.width) * w));
  const y0 = Math.max(0, Math.floor(box.top * h));
  const y1 = Math.min(h - 1, Math.ceil((box.top + box.height) * h));
  let ink = 0;
  let still = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * 3;
      if (before[i] + before[i + 1] + before[i + 2] < 700) continue;
      const n = (y * w + Math.min(w - 1, x + 4)) * 3;
      if (before[n] + before[n + 1] + before[n + 2] > 150) continue;
      ink++;
      const diff = Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) + Math.abs(before[i + 2] - after[i + 2]);
      if (diff < 45) still++;
    }
  }
  return ink > 25 && still / ink > 0.5;
}
