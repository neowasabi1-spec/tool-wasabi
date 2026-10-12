import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { FFMPEG, run } from './video';

/**
 * Covers the burned-in captions of a source video with new ones, using the
 * same layout as reel/remotion/compositions/CoverSubs.tsx (approved look):
 *  - stroke captions: one dark rounded plate per original line, as tall as the
 *    text, Archivo Black white letters with a black outline on top;
 *  - card captions: a white rounded card over the original card, Inter
 *    ExtraBold words that go gray → black as they are spoken.
 * Geometry is measured from the pixels of the original every 1/3 s, inside the
 * caption area an LLM points at once per second.
 */

export type Rect = { x0: number; y0: number; x1: number; y1: number };
export type CaptionCue = { start: number; end: number; text: string };
export type CoverBlock = {
  start: number;
  end: number;
  style: 'card' | 'stroke';
  card: Rect | null;
  lines: Rect[];
  /** Plates stay up from the last sample of the previous phrase to the first
   *  of the next, since the change happens somewhere in between. */
  coverStart?: number;
  coverEnd?: number;
  /** No original caption here: only the new text and its own plate. */
  ghost?: boolean;
};
export type CoverPlate = { start: number; end: number; rect: Rect };
export type CoverIssue = { block: number; t: number; rect: Rect | null; why: string };

export type Style = 'card' | 'stroke' | 'none';
export type Hint = { t: number; style: Style; lines: Rect[] };
export type CoverPlan = { blocks: CoverBlock[]; hints: Hint[] };
type Sample = { t: number; style: Style; card: Rect | null; lines: Rect[] };

const STEP = 1 / 3;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Advance widths (em) for ASCII 32..126, from the font files in _assets.
const ARCHIVO_W = [0.333, 0.333, 0.5, 0.66, 0.667, 1.0, 0.889, 0.278, 0.389, 0.389, 0.556, 0.66, 0.333, 0.333, 0.333, 0.278, 0.667, 0.667, 0.667, 0.667, 0.667, 0.667, 0.667, 0.667, 0.667, 0.667, 0.333, 0.333, 0.66, 0.66, 0.66, 0.611, 0.74, 0.778, 0.778, 0.778, 0.778, 0.722, 0.667, 0.833, 0.833, 0.389, 0.667, 0.833, 0.667, 0.944, 0.833, 0.833, 0.722, 0.833, 0.778, 0.722, 0.722, 0.833, 0.778, 1.0, 0.778, 0.778, 0.722, 0.389, 0.278, 0.389, 0.66, 0.5, 0.333, 0.667, 0.667, 0.667, 0.667, 0.667, 0.389, 0.667, 0.667, 0.333, 0.333, 0.667, 0.333, 1.0, 0.667, 0.667, 0.667, 0.667, 0.444, 0.611, 0.444, 0.667, 0.611, 0.944, 0.667, 0.611, 0.556, 0.389, 0.278, 0.389, 0.66];
const INTER_W = [0.219, 0.358, 0.586, 0.655, 0.66, 1.029, 0.683, 0.354, 0.382, 0.382, 0.583, 0.686, 0.353, 0.471, 0.353, 0.4, 0.692, 0.441, 0.638, 0.657, 0.688, 0.652, 0.662, 0.588, 0.664, 0.662, 0.353, 0.36, 0.686, 0.686, 0.686, 0.579, 1.036, 0.77, 0.665, 0.744, 0.723, 0.61, 0.585, 0.752, 0.749, 0.286, 0.59, 0.738, 0.565, 0.943, 0.766, 0.773, 0.652, 0.782, 0.662, 0.66, 0.677, 0.727, 0.77, 1.059, 0.761, 0.752, 0.679, 0.382, 0.4, 0.382, 0.493, 0.484, 0.382, 0.588, 0.638, 0.595, 0.638, 0.601, 0.41, 0.639, 0.635, 0.283, 0.283, 0.593, 0.283, 0.927, 0.635, 0.619, 0.638, 0.638, 0.42, 0.573, 0.382, 0.635, 0.615, 0.863, 0.594, 0.618, 0.581, 0.486, 0.388, 0.486, 0.686];
// libass sizes a font by usWinAscent+usWinDescent; CSS by the em. These turn a
// CSS px size into the ASS \fs that draws the same letters.
const ARCHIVO = { widths: ARCHIVO_W, assScale: 1.347, winAscent: 1.035, cssBaseline: 0.834 };
const INTER = { widths: INTER_W, assScale: 1.21, winAscent: 0.969, cssBaseline: 0.924 };

function clamp(n: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, n));
}

function union(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function pad(r: Rect, px: number, py: number, W: number, H: number): Rect {
  return {
    x0: clamp(Math.round(r.x0 - px), 0, W),
    y0: clamp(Math.round(r.y0 - py), 0, H),
    x1: clamp(Math.round(r.x1 + px), 0, W),
    y1: clamp(Math.round(r.y1 + py), 0, H),
  };
}

function inside(r: Rect, x: number, y: number): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

// ---------------------------------------------------------------- LLM vision

async function vision(jpeg: string, prompt: string, model?: string): Promise<string | null> {
  const b64 = fs.readFileSync(jpeg).toString('base64');
  const orKey = (process.env.OPENROUTER_API_KEY || '').trim();
  const anKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  try {
    if (orKey) {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json', 'X-Title': 'tool-wasabi-captions' },
        body: JSON.stringify({
          model: model || process.env.CAPTION_VISION_MODEL || 'google/gemini-2.5-flash',
          temperature: 0,
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
              { type: 'text', text: prompt },
            ],
          }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return null;
      const j = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      return j.choices?.[0]?.message?.content || null;
    }
    if (anKey) {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
              { type: 'text', text: prompt },
            ],
          }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return null;
      const j = await res.json() as { content?: Array<{ text?: string }> };
      return (j.content || []).map((c) => c.text || '').join('') || null;
    }
  } catch {
    return null;
  }
  return null;
}

export function hasVision(): boolean {
  return Boolean((process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim());
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  const m = text.replace(/```json|```/gi, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}

function box2d(v: unknown, W: number, H: number): Rect | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = v.map((n) => Number(n));
  if (![ymin, xmin, ymax, xmax].every(Number.isFinite) || ymax <= ymin || xmax <= xmin) return null;
  return {
    x0: clamp(Math.round((xmin / 1000) * W), 0, W),
    y0: clamp(Math.round((ymin / 1000) * H), 0, H),
    x1: clamp(Math.round((xmax / 1000) * W), 0, W),
    y1: clamp(Math.round((ymax / 1000) * H), 0, H),
  };
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

const LINES_PROMPT =
  'This is a frame of a vertical video ad. Find the burned-in caption: subtitle text added in editing. ' +
  'Ignore text printed on products, packaging, labels, logos, price tags and letter-grade badges. ' +
  'style "card" = dark text on a white filled rectangle; "stroke" = white letters with a black outline and no filled background; ' +
  '"none" = no caption. List every caption line separately, top to bottom, with its exact text and ' +
  "box_2d = [ymin, xmin, ymax, xmax] tight around that line's letters including their outline, each 0-1000 of the frame. " +
  'Reply with JSON only: {"style":"card|stroke|none","lines":[{"text":"","box_2d":[0,0,0,0]}]}';

type ReadLine = { text: string; box: Rect };
export type Reading = { style: Style; lines: ReadLine[] };

/** Asks the LLM for the caption lines of one frame (text + box per line). */
async function readCaption(jpeg: string, W: number, H: number): Promise<Reading | null> {
  const j = parseJson<{ style?: string; lines?: Array<Record<string, unknown>> }>(await vision(jpeg, LINES_PROMPT));
  if (!j) return null;
  const style: Style = j.style === 'card' || j.style === 'stroke' ? j.style : 'none';
  const lines: ReadLine[] = [];
  for (const l of Array.isArray(j.lines) ? j.lines : []) {
    // Models sometimes misname the key; take whichever value is the 4-number box.
    const arr = Object.values(l).find((v) => Array.isArray(v) && v.length === 4);
    const box = box2d(arr, W, H);
    if (box) lines.push({ text: typeof l.text === 'string' ? l.text : '', box });
  }
  return { style: lines.length ? style : 'none', lines };
}

async function readHints(file: string, dur: number, W: number, H: number, workDir: string): Promise<Hint[]> {
  const dir = path.join(workDir, 'hints');
  fs.mkdirSync(dir, { recursive: true });
  await run(FFMPEG, ['-y', '-ss', '0.5', '-i', file, '-vf', 'fps=1,scale=540:-2', '-q:v', '3', path.join(dir, 'h-%03d.jpg')]);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
  const times = files.map((_, i) => 0.5 + i).filter((t) => t < dur);
  const hints: Hint[] = await pool(times, 8, async (t, i) => {
    const r = await readCaption(path.join(dir, files[i]), W, H);
    return { t, style: r?.style || 'none', lines: (r?.lines || []).map((l) => l.box) };
  });
  return confirmedHints(hints);
}

/**
 * The model now and then places a box on packaging below the caption. Captions
 * stay on the same rows for seconds, so a stroke line no other reading nearby
 * puts on its rows is dropped.
 */
function confirmedHints(hints: Hint[]): Hint[] {
  return hints.map((h) => {
    if (h.style !== 'stroke') return h;
    const lines = h.lines.filter((l) => hints.some((o) => o !== h && o.style === 'stroke' && Math.abs(o.t - h.t) <= 3 &&
      o.lines.some((m) => Math.min(l.y1, m.y1) - Math.max(l.y0, m.y0) >= 0.5 * Math.min(l.y1 - l.y0, m.y1 - m.y0))));
    return lines.length ? { ...h, lines } : { ...h, style: 'none' as const, lines };
  });
}

// --------------------------------------------------------- pixel measurement

function measureCard(g: Buffer, W: number, H: number, reg: Rect): Rect | null {
  const minRun = Math.round(W * 0.22);
  const rows: Array<{ y: number; s: number; e: number }> = [];
  for (let y = reg.y0; y < reg.y1; y++) {
    let best = 0; let bs = 0; let run = 0; let rs = 0;
    for (let x = reg.x0; x < reg.x1; x++) {
      if (g[y * W + x] >= 222) {
        if (!run) rs = x;
        run++;
        if (run > best) { best = run; bs = rs; }
      } else run = 0;
    }
    if (best >= minRun) rows.push({ y, s: bs, e: bs + best });
  }
  if (!rows.length) return null;
  const gap = Math.round(H * 0.035);
  let groups: typeof rows[] = [[rows[0]]];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].y - rows[i - 1].y <= gap) groups[groups.length - 1].push(rows[i]);
    else groups.push([rows[i]]);
  }
  groups = groups.sort((a, b) => b.length - a.length);
  const gr = groups[0];
  if (gr[gr.length - 1].y - gr[0].y < H * 0.05) return null;
  return {
    x0: Math.min(...gr.map((r) => r.s)),
    x1: Math.max(...gr.map((r) => r.e)),
    y0: gr[0].y,
    y1: gr[gr.length - 1].y,
  };
}

/** White letter pixels that have a black outline next to them. */
function strokeHit(g: Buffer, W: number, x: number, y: number, ds: number[]): boolean {
  const i = y * W + x;
  if (g[i] < 222) return false;
  for (const d of ds) {
    if ((x - d >= 0 && g[i - d] <= 70) || (x + d < W && g[i + d] <= 70)) return true;
  }
  return false;
}

/** Groups of consecutive rows with letter pixels between columns c0..c1. */
function rowGroups(g: Buffer, W: number, ds: number[], y0: number, y1: number, c0: number, c1: number, gapRows: number) {
  const groups: Array<{ y0: number; y1: number }> = [];
  let cur: { y0: number; y1: number } | null = null;
  let gap = 0;
  for (let y = y0; y <= y1; y++) {
    let c = 0;
    for (let x = c0; x <= c1 && c < 2; x++) if (strokeHit(g, W, x, y, ds)) c++;
    if (c >= 2) {
      if (cur && gap <= gapRows) cur.y1 = y;
      else { cur = { y0: y, y1: y }; groups.push(cur); }
      gap = 0;
    } else gap++;
  }
  return groups;
}

/**
 * Measures one caption line around the box the LLM read. Rows: only the row
 * groups that sit mostly inside the box (so the line above/below or packaging
 * is not pulled in). Columns: the box, then outward through neighbouring
 * letters that are as tall as the line and on the same rows.
 */
export function measureLine(g: Buffer, W: number, H: number, band: Rect): Rect | null {
  const k = W / 720;
  const ds = [3, 5, 7].map((d) => Math.max(2, Math.round(d * k)));
  const y0 = clamp(Math.round(band.y0 - 0.015 * H), 0, H - 1);
  const y1 = clamp(Math.round(band.y1 + 0.015 * H), 0, H - 1);
  const gapRows = Math.max(2, Math.round(0.003 * H));
  const cols = new Array<number>(W).fill(0);
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < W; x++) if (strokeHit(g, W, x, y, ds)) cols[x]++;
  }
  let x0 = clamp(Math.round(band.x0 - 0.03 * W), 0, W - 1);
  let x1 = clamp(Math.round(band.x1 + 0.03 * W), 0, W - 1);
  let n = 0;
  for (let x = x0; x <= x1; x++) n += cols[x];
  if (n < 30 * k) return null;
  while (x0 < x1 && cols[x0] < 2) x0++;
  while (x1 > x0 && cols[x1] < 2) x1--;

  const pickRows = (c0: number, c1: number) => {
    const inBand = rowGroups(g, W, ds, y0, y1, c0, c1, gapRows).filter((gr) => {
      const ov = Math.min(gr.y1, band.y1) - Math.max(gr.y0, band.y0);
      return ov >= 0.5 * (gr.y1 - gr.y0 + 1);
    });
    if (!inBand.length) return null;
    let top = Math.min(...inBand.map((r) => r.y0));
    let bottom = Math.max(...inBand.map((r) => r.y1));
    // Text printed right under the caption joins its row group; keep the
    // densest stretch as tall as the box.
    const bh = band.y1 - band.y0;
    if (bottom - top > 1.2 * bh) {
      const rowHits = (y: number) => { let c = 0; for (let x = c0; x <= c1; x++) if (strokeHit(g, W, x, y, ds)) c++; return c; };
      const hits: number[] = [];
      for (let y = top; y <= bottom; y++) hits.push(rowHits(y));
      let sum = 0;
      for (let i = 0; i < bh; i++) sum += hits[i];
      let best = sum;
      let at = 0;
      for (let i = bh; i < hits.length; i++) {
        sum += hits[i] - hits[i - bh];
        if (sum > best) { best = sum; at = i - bh + 1; }
      }
      let a = at;
      let b = at + bh - 1;
      while (a < b && hits[a] < 2) a++;
      while (b > a && hits[b] < 2) b--;
      bottom = top + b;
      top = top + a;
    }
    return { top, bottom };
  };
  let rows = pickRows(x0, x1);
  if (!rows || rows.bottom - rows.top < 0.015 * H) return null;

  // Extend sideways word by word: a word belongs to the line when its letters
  // span the same rows.
  const lineH = rows.bottom - rows.top;
  const gapCols = Math.round(0.03 * W);
  const word = (from: number, dir: 1 | -1) => {
    let x = from;
    let miss = 0;
    let end = from;
    while (x >= 0 && x < W && miss <= Math.round(6 * k)) {
      if (cols[x] >= 2) { end = x; miss = 0; } else miss++;
      x += dir;
    }
    return end;
  };
  for (const dir of [-1, 1] as const) {
    for (;;) {
      const edge = dir < 0 ? x0 : x1;
      let next = -1;
      for (let d = 1; d <= gapCols; d++) {
        const x = edge + dir * d;
        if (x < 0 || x >= W) break;
        if (cols[x] >= 2) { next = x; break; }
      }
      if (next < 0) break;
      const far = word(next, dir);
      const c0 = Math.min(next, far);
      const c1 = Math.max(next, far);
      const gr = rowGroups(g, W, ds, y0, y1, c0, c1, gapRows);
      const top = gr.length ? Math.min(...gr.map((r) => r.y0)) : 0;
      const bottom = gr.length ? Math.max(...gr.map((r) => r.y1)) : 0;
      const ov = Math.min(bottom, rows.bottom) - Math.max(top, rows.top);
      if (!gr.length || bottom - top < 0.5 * lineH || ov < 0.6 * (bottom - top)) break;
      if (dir < 0) x0 = c0; else x1 = c1;
    }
  }
  rows = pickRows(x0, x1) || rows;
  return pad({ x0, x1, y0: rows.top, y1: rows.bottom }, 0.014 * W, 0.006 * H, W, H);
}

/** Each LLM line, widened to every box read on the same rows within a second. */
function bandsAround(hints: Hint[], t: number): Rect[] {
  const lines = hints.filter((h) => h.style === 'stroke' && Math.abs(h.t - t) <= 1.6).flatMap((h) => h.lines);
  return lines.map((l) => {
    let x0 = l.x0;
    let x1 = l.x1;
    for (const m of lines) {
      const ov = Math.min(l.y1, m.y1) - Math.max(l.y0, m.y0);
      if (ov >= 0.6 * Math.min(l.y1 - l.y0, m.y1 - m.y0)) { x0 = Math.min(x0, m.x0); x1 = Math.max(x1, m.x1); }
    }
    return { x0, x1, y0: l.y0, y1: l.y1 };
  });
}

function centerY(r: Rect): number {
  return (r.y0 + r.y1) / 2;
}

function measureSample(g: Buffer, W: number, H: number, t: number, hints: Hint[]): Sample {
  // Dark text on a white card also looks like outlined letters, so a card seen
  // nearby wins; the wider window catches cards fading out in a dissolve.
  const cards = hints
    .filter((h) => h.style === 'card' && Math.abs(h.t - t) <= 1.6)
    .sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t));
  for (const h of cards) {
    const area = h.lines.reduce<Rect | null>((a, r) => union(a, r), null) as Rect;
    const card = measureCard(g, W, H, { ...pad(area, 0, 0.06 * H, W, H), x0: 0, x1: W });
    if (card) return { t, style: 'card', card, lines: [] };
  }
  // Rows of the caption lines seen by the LLM within a second of this frame.
  const lines = bandsAround(hints, t)
    .map((b) => measureLine(g, W, H, b))
    .filter((r): r is Rect => !!r);
  if (lines.length) return { t, style: 'stroke', card: null, lines: clusterLines(lines) };
  return { t, style: 'none', card: null, lines: [] };
}

/** Streams gray frames at 3 fps and measures the original caption in each. */
async function measureAll(file: string, W: number, H: number, hints: Hint[]): Promise<Sample[]> {
  const size = W * H;
  const samples: Sample[] = [];
  await new Promise<void>((resolve, reject) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', file, '-vf', 'fps=3,format=gray', '-f', 'rawvideo', 'pipe:1']);
    let buf: Buffer = Buffer.alloc(0);
    let idx = 0;
    let err = '';
    p.stdout.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) {
        samples.push(measureSample(buf.subarray(0, size), W, H, idx * STEP, hints));
        buf = buf.subarray(size);
        idx++;
      }
    });
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`frame scan failed: ${err.slice(-300)}`))));
  });
  return samples;
}

function clusterLines(rects: Rect[], minSeen = 1): Rect[] {
  const sorted = [...rects].sort((a, b) => centerY(a) - centerY(b));
  const out: Array<{ r: Rect; n: number }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    const overlap = last ? Math.min(last.r.y1, r.y1) - Math.max(last.r.y0, r.y0) : -1;
    if (last && overlap >= 0.4 * Math.min(last.r.y1 - last.r.y0, r.y1 - r.y0)) {
      last.r = union(last.r, r);
      last.n++;
    } else out.push({ r: { ...r }, n: 1 });
  }
  return out.filter((c) => c.n >= minSeen).map((c) => c.r);
}

/** Phrases that move a little merge into one tall cluster; cut it back into one slot per text line. */
function splitTall(lines: Rect[], lineH: number): Rect[] {
  const out: Rect[] = [];
  for (const r of lines) {
    const n = Math.max(1, Math.round((r.y1 - r.y0) / Math.max(1, lineH)));
    const h = (r.y1 - r.y0) / n;
    for (let i = 0; i < n; i++) out.push({ x0: r.x0, x1: r.x1, y0: Math.round(r.y0 + i * h), y1: Math.round(r.y0 + (i + 1) * h) });
  }
  return out;
}

function buildBlocks(samplesIn: Sample[], dur: number, W: number, H: number): CoverBlock[] {
  // A misread line (packaging the LLM took for a caption) has smaller letters
  // than the video's real caption lines.
  const hs = samplesIn.flatMap((s) => s.lines.map((l) => l.y1 - l.y0)).sort((a, b) => a - b);
  const med = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
  const samples = samplesIn.map((s) => {
    if (s.style !== 'stroke') return s;
    const lines = s.lines.filter((l) => l.y1 - l.y0 >= 0.6 * med);
    return lines.length ? { ...s, lines } : { ...s, style: 'none' as const, lines };
  });
  type Raw = { style: 'card' | 'stroke'; items: Sample[] };
  const raws: Raw[] = [];
  // One block per original phrase: a new block starts when the style, the
  // number of lines or the size of a line changes.
  const samePhrase = (a: Sample, b: Sample): boolean => {
    if (a.style !== b.style) return false;
    if (a.style === 'card') return true;
    if (a.lines.length !== b.lines.length) return false;
    return a.lines.every((l, i) => {
      const m = b.lines[i];
      return Math.abs(l.x0 - m.x0) <= 0.04 * W && Math.abs(l.x1 - m.x1) <= 0.04 * W &&
        Math.abs(centerY(l) - centerY(m)) <= 0.015 * H;
    });
  };
  for (const s of samples) {
    if (s.style === 'none') continue;
    const cur = raws[raws.length - 1];
    const last = cur?.items[cur.items.length - 1];
    if (cur && last && s.t - last.t <= 0.7 && samePhrase(last, s)) cur.items.push(s);
    else raws.push({ style: s.style, items: [s] });
  }
  const blocks: CoverBlock[] = raws.map((r, i) => {
    const first = r.items[0].t;
    const last = r.items[r.items.length - 1].t;
    const prevLast = i > 0 ? raws[i - 1].items[raws[i - 1].items.length - 1].t : -Infinity;
    const nextFirst = i < raws.length - 1 ? raws[i + 1].items[0].t : Infinity;
    const start = Math.max(0, first - STEP, (prevLast + first) / 2);
    const end = Math.min(dur, last + STEP, (last + nextFirst) / 2);
    const coverStart = Math.max(0, first - STEP, Math.min(start, prevLast));
    const coverEnd = Math.min(dur, last + STEP, Math.max(end, nextFirst));
    if (r.style === 'card') {
      let card: Rect | null = null;
      for (const s of r.items) card = union(card, s.card as Rect);
      return { start, end, coverStart, coverEnd, style: 'card' as const, card: pad(card as Rect, 0.015 * W, 0.01 * H, W, H), lines: [] };
    }
    const all = r.items.flatMap((s) => s.lines);
    const seen = clusterLines(all, r.items.length >= 3 ? 2 : 1);
    const heights = all.map((l) => l.y1 - l.y0).sort((a, b) => a - b);
    const lineH = heights[Math.floor(heights.length / 2)];
    return { start, end, coverStart, coverEnd, style: 'stroke' as const, card: null, lines: splitTall(seen.length ? seen : clusterLines(all), lineH) };
  });
  // Dark plates must not show next to a white card that is still on screen.
  blocks.forEach((b, i) => {
    if (b.style !== 'stroke') return;
    const prev = blocks[i - 1];
    const next = blocks[i + 1];
    if (prev?.style === 'card') b.coverStart = Math.max(b.coverStart ?? b.start, prev.end);
    if (next?.style === 'card') b.coverEnd = Math.min(b.coverEnd ?? b.end, next.start);
  });
  return blocks;
}

export async function planCover(
  file: string, dur: number, W: number, H: number, workDir: string,
  log: (...a: unknown[]) => void = () => {},
  knownHints?: Hint[],
): Promise<CoverPlan> {
  const hints = knownHints || await readHints(file, dur, W, H, workDir);
  log(`caption hints: ${hints.map((h) => `${h.t.toFixed(1)}:${h.style[0]}${h.lines.length}`).join(' ')}`);
  const samples = await measureAll(file, W, H, hints);
  const blocks = buildBlocks(samples, dur, W, H);
  log(`caption blocks: ${blocks.map((b) => `${b.style}[${b.start.toFixed(2)}-${b.end.toFixed(2)}]x${b.lines.length}`).join(' ')}`);
  return { blocks, hints };
}

// -------------------------------------------------------------------- layout

function textWidth(text: string, font: typeof ARCHIVO, px: number): number {
  let em = 0;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    em += c >= 32 && c <= 126 ? font.widths[c - 32] : 0.65;
  }
  return (em - 0.02 * Math.max(0, text.length - 1)) * px;
}

function splitLines(words: string[], n: number, width: (s: string) => number): string[] {
  if (n <= 1 || words.length <= 1) return [words.join(' ')];
  if (n === 2 || words.length === 2) {
    let best = [words.join(' ')];
    let bestW = Infinity;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      const w = Math.max(width(a), width(b));
      if (w < bestW) { bestW = w; best = [a, b]; }
    }
    return best;
  }
  let best = [words.join(' ')];
  let bestW = Infinity;
  for (let i = 1; i < words.length - 1; i++) {
    for (let j = i + 1; j < words.length; j++) {
      const parts = [words.slice(0, i), words.slice(i, j), words.slice(j)].map((p) => p.join(' '));
      const w = Math.max(...parts.map(width));
      if (w < bestW) { bestW = w; best = parts; }
    }
  }
  return best;
}

function wrapWords(words: string[], maxW: number, width: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && width(next) > maxW) { lines.push(line); line = w; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
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

function roundRect(r: Rect, radius: number, color: string, layer: number, start: number, end: number): string {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const rr = Math.max(0, Math.min(radius, w / 2, h / 2));
  const k = rr * 0.5523;
  const f = (n: number) => String(Math.round(n * 10) / 10);
  const d = [
    'm', f(rr), '0', 'l', f(w - rr), '0',
    'b', f(w - rr + k), '0', f(w), f(rr - k), f(w), f(rr),
    'l', f(w), f(h - rr),
    'b', f(w), f(h - rr + k), f(w - rr + k), f(h), f(w - rr), f(h),
    'l', f(rr), f(h),
    'b', f(rr - k), f(h), '0', f(h - rr + k), '0', f(h - rr),
    'l', '0', f(rr),
    'b', '0', f(rr - k), f(rr - k), '0', f(rr), '0',
  ].join(' ');
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},Plate,,0,0,0,,` +
    `{\\an7\\pos(${r.x0},${r.y0})\\bord0\\shad0\\1c&H${color}&\\p1}${d}{\\p0}`;
}

function clean(text: string): string {
  return text.replace(/[{}\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Fills the time no block covers with ghost blocks so every cue gets placed. */
function withGhosts(blocks: CoverBlock[], dur: number, W: number, H: number): CoverBlock[] {
  const strokes = blocks.filter((b) => b.style === 'stroke' && b.lines.length);
  const ghostLines = (t: number): Rect[] => {
    const src = strokes.slice().sort((a, b) =>
      Math.abs((a.start + a.end) / 2 - t) - Math.abs((b.start + b.end) / 2 - t))[0];
    const base = src ? src.lines : [
      { x0: 0, x1: 0, y0: Math.round(H * 0.646), y1: Math.round(H * 0.688) },
      { x0: 0, x1: 0, y0: Math.round(H * 0.697), y1: Math.round(H * 0.727) },
    ];
    return base.map((r) => ({ x0: Math.round(W / 2), x1: Math.round(W / 2), y0: r.y0, y1: r.y1 }));
  };
  const out: CoverBlock[] = [];
  let t = 0;
  for (const b of [...blocks].sort((a, c) => a.start - c.start)) {
    if (b.start - t > 0.05) out.push({ start: t, end: b.start, style: 'stroke', card: null, lines: ghostLines((t + b.start) / 2), ghost: true });
    out.push(b);
    t = Math.max(t, b.end);
  }
  if (dur - t > 0.05) out.push({ start: t, end: dur, style: 'stroke', card: null, lines: ghostLines((t + dur) / 2), ghost: true });
  return out;
}

export function buildCoverAss(
  cues: CaptionCue[], blocksIn: CoverBlock[], W: number, H: number, dur: number,
): { ass: string; plates: CoverPlate[]; blocks: CoverBlock[] } {
  const blocks = withGhosts(blocksIn, dur, W, H);
  const events: string[] = [];
  const plates: CoverPlate[] = [];
  const plate = (r: Rect, radius: number, color: string, layer: number, s: number, e: number) => {
    events.push(roundRect(r, radius, color, layer, s, e));
    plates.push({ start: s, end: e, rect: r });
  };

  for (const b of blocks) {
    const segs = cues
      .map((c) => ({ start: Math.max(c.start, b.start), end: Math.min(c.end, b.end), text: clean(c.text), cue: c }))
      .filter((s) => s.end - s.start > 0.04 && s.text);

    if (b.style === 'card' && b.card) {
      const card = b.card;
      const cardH = card.y1 - card.y0;
      plate(card, cardH * 0.12, 'FFFFFF', 0, b.coverStart ?? b.start, b.coverEnd ?? b.end);
      for (const s of segs) {
        const words = s.text.split(' ');
        const padX = 0.05 * W;
        const padY = 0.03 * W;
        let fs = Math.round(cardH * 0.16);
        let lines: string[] = [];
        for (; fs >= 18; fs -= 2) {
          const width = (t: string) => textWidth(t, INTER, fs);
          lines = wrapWords(words, card.x1 - card.x0 - 2 * padX, width);
          if (lines.length * 1.12 * fs <= cardH - 2 * padY && lines.every((l) => width(l) <= card.x1 - card.x0 - 2 * padX)) break;
        }
        // Word timing across the segment, by length, so words darken as they are said.
        const segLen = s.end - s.start;
        const weights = words.map((w) => Math.max(2, w.length));
        const total = weights.reduce((a, c) => a + c, 0);
        const wordStart: number[] = [];
        let acc = 0;
        for (const wt of weights) { wordStart.push(acc); acc += (wt / total) * segLen; }
        const blockH = lines.length * 1.12 * fs;
        let wi = 0;
        lines.forEach((line, li) => {
          const lineTop = card.y0 + (cardH - blockH) / 2 + li * 1.12 * fs;
          const y = Math.round(lineTop + (INTER.cssBaseline - INTER.winAscent) * fs);
          const x = Math.round((card.x0 + card.x1) / 2);
          const lw = line.split(' ');
          let k = `{\\k${Math.round(wordStart[wi] * 100)}}`;
          for (let n = 0; n < lw.length; n++) {
            const cur = wordStart[wi + n];
            const nxt = wi + n + 1 < words.length ? wordStart[wi + n + 1] : segLen;
            k += `{\\k${Math.max(1, Math.round((nxt - cur) * 100))}}${lw[n]}${n < lw.length - 1 ? ' ' : ''}`;
          }
          wi += lw.length;
          events.push(`Dialogue: 2,${assTime(s.start)},${assTime(s.end)},Card,,0,0,0,,` +
            `{\\an8\\pos(${x},${y})\\fs${Math.round(fs * INTER.assScale)}\\fsp${(-0.02 * fs).toFixed(1)}}${k}`);
        });
      }
      continue;
    }

    // Stroke: CoverSubs geometry — fontSize = H*0.034, plate padding 0.42/0.35 em.
    const baseFs = Math.round(H * 0.034);
    const bord = Math.max(3, Math.round(Math.max(6, Math.round(H * 0.005)) / 2));
    const lines = (b.lines.length ? b.lines : [{ x0: W / 2, x1: W / 2, y0: Math.round(H * 0.646), y1: Math.round(H * 0.688) }])
      .slice().sort((p, q) => p.y0 - q.y0);
    if (!b.ghost) for (const r of lines) plate(r, baseFs * 0.18, '111111', 0, b.coverStart ?? b.start, b.coverEnd ?? b.end);
    const step = Math.round(H * 0.054);
    for (const s of segs) {
      const words = s.text.split(' ');
      let fs = baseFs;
      // One new line on each original line (so each plate covers one line),
      // plus one more below if the text does not fit.
      const need = words.length > 1 && textWidth(s.text, ARCHIVO, fs) + 0.7 * fs > 0.8 * W ? 2 : 1;
      const n = Math.max(1, Math.min(3, words.length, Math.max(lines.length, need)));
      const slots = lines.slice(0, n);
      while (slots.length < n) {
        const last = slots[slots.length - 1];
        slots.push({ x0: Math.round(W / 2), x1: Math.round(W / 2), y0: last.y0 + step, y1: last.y1 + step });
      }
      const parts = splitLines(words, n, (t) => textWidth(t, ARCHIVO, fs));
      while (parts.some((p) => textWidth(p, ARCHIVO, fs) + 0.7 * fs > 0.94 * W) && fs > baseFs * 0.7) fs -= 1;
      const padY = Math.round(fs * 0.42);
      const padX = Math.round(fs * 0.35);
      parts.forEach((p, i) => {
        const slot = slots[i];
        const tw = textWidth(p, ARCHIVO, fs);
        const ph = Math.max(fs + 2 * padY, slot.y1 - slot.y0);
        const cy = centerY(slot);
        const r: Rect = {
          x0: Math.round(Math.max(0, Math.min(slot.x0, W / 2 - tw / 2 - padX))),
          x1: Math.round(Math.min(W, Math.max(slot.x1, W / 2 + tw / 2 + padX))),
          y0: Math.round(cy - ph / 2),
          y1: Math.round(cy + ph / 2),
        };
        plate(r, fs * 0.18, '111111', 1, s.start, s.end);
        const lineTop = cy - fs / 2;
        const y = Math.round(lineTop + (ARCHIVO.cssBaseline - ARCHIVO.winAscent) * fs);
        events.push(`Dialogue: 2,${assTime(s.start)},${assTime(s.end)},Stroke,,0,0,0,,` +
          `{\\an8\\pos(${Math.round(W / 2)},${y})\\fs${Math.round(fs * ARCHIVO.assScale)}\\fsp${(-0.02 * fs).toFixed(1)}\\bord${bord}}${p}`);
      });
    }
  }

  const header = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`,
    'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Plate,Archivo Black,20,&H00111111,&H00111111,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    'Style: Stroke,Archivo Black,59,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,8,0,0,0,1',
    'Style: Card,Inter ExtraBold,53,&H001C1C1C,&H00C5C5C5,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,1,0,0,8,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  return { ass: [...header, ...events].join('\n') + '\n', plates, blocks };
}

/** Copies the caption fonts next to the .ass; returns the ffmpeg fontsdir value. */
export function coverFontsDir(workDir: string): string | null {
  const names = ['ArchivoBlack-Regular.ttf', 'Inter-ExtraBold.ttf'];
  const dirs = [
    path.join(process.cwd(), 'netlify/functions/_assets'),
    path.join(process.cwd(), '_assets'),
  ];
  try { dirs.push(fileURLToPath(new URL('./_assets', import.meta.url))); } catch { /* not ESM */ }
  try { dirs.push(fileURLToPath(new URL('../_assets', import.meta.url))); } catch { /* not ESM */ }
  const src = dirs.find((d) => names.every((n) => fs.existsSync(path.join(d, n))));
  if (!src) return null;
  const dest = path.join(workDir, 'fonts');
  fs.mkdirSync(dest, { recursive: true });
  for (const n of names) fs.copyFileSync(path.join(src, n), path.join(dest, n));
  return 'fonts';
}

// -------------------------------------------------------------- verification

/**
 * One decode of the video for all check times (seeking once per frame costs
 * seconds each on a function): a gray frame for the pixels and a small JPEG
 * for the LLM, keyed by frame index at 30 fps.
 */
const baseFrames = new Map<string, { gray: Map<number, Buffer>; jpg: Map<number, string> }>();

async function grabFrames(
  file: string, frames: number[], W: number, H: number, workDir: string, tag: string,
): Promise<{ gray: Map<number, Buffer>; jpg: Map<number, string> }> {
  const list = [...new Set(frames)].sort((a, b) => a - b);
  const gray = new Map<number, Buffer>();
  const jpg = new Map<number, string>();
  if (!list.length) return { gray, jpg };
  const dir = path.join(workDir, `frames-${tag}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const sel = list.map((n) => `eq(n\\,${n})`).join('+');
  fs.writeFileSync(path.join(dir, 'graph.txt'),
    `[0:v]fps=30,select='${sel}',split=2[g][j];[g]format=gray[go];[j]scale=540:-2[jo]`);
  await run(FFMPEG, ['-y', '-v', 'error', '-i', file, '-filter_complex_script', path.join(dir, 'graph.txt'),
    '-map', '[go]', '-vsync', '0', '-f', 'rawvideo', path.join(dir, 'gray.raw'),
    '-map', '[jo]', '-vsync', '0', '-q:v', '3', path.join(dir, 'f-%04d.jpg')]);
  const raw = fs.readFileSync(path.join(dir, 'gray.raw'));
  const size = W * H;
  list.forEach((n, i) => {
    if ((i + 1) * size <= raw.length) gray.set(n, raw.subarray(i * size, (i + 1) * size));
    const f = path.join(dir, `f-${String(i + 1).padStart(4, '0')}.jpg`);
    if (fs.existsSync(f)) jpg.set(n, f);
  });
  return { gray, jpg };
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f' ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
}

/**
 * Walks both videos side by side: every frame within 0.4 s of a phrase change
 * (cuts can flash the old caption for a single frame), 6 fps elsewhere. On each frame the original lines
 * (in the rows the LLM read around that time) are measured again; letters
 * left unchanged and outside every plate are leaks.
 */
/** A box the model drew over two lines (or a line and the packaging under it) is cut into line-high bands. */
function lineBands(bands: Rect[], lineH: number): Rect[] {
  if (!lineH) return bands;
  return bands.flatMap((r) => {
    const n = Math.max(1, Math.round((r.y1 - r.y0) / lineH));
    const h = (r.y1 - r.y0) / n;
    return Array.from({ length: n }, (_, i) => ({ ...r, y0: Math.round(r.y0 + i * h), y1: Math.round(r.y0 + (i + 1) * h) }));
  });
}

function medianLineH(blocks: CoverBlock[]): number {
  const hs = blocks.flatMap((b) => b.ghost ? [] : b.lines.map((l) => l.y1 - l.y0)).sort((a, b) => a - b);
  return hs.length ? hs[Math.floor(hs.length / 2)] : 0;
}

async function scanLeaks(
  base: string, final: string, blocks: CoverBlock[], plates: CoverPlate[], hints: Hint[], W: number, H: number,
): Promise<CoverIssue[]> {
  const k = W / 720;
  const ds = [3, 5, 7].map((d) => Math.max(2, Math.round(d * k)));
  const lineH = medianLineH(blocks);
  const minH = 0.6 * lineH;
  const issues: CoverIssue[] = [];
  const a = Buffer.alloc(W * H);
  const b = Buffer.alloc(W * H);
  const edges = blocks.flatMap((bl) => [bl.start, bl.end, bl.coverStart ?? bl.start, bl.coverEnd ?? bl.end]);
  const onFrame = (f: Buffer, idx: number) => {
    const t = idx / 30;
    if (idx % 5 !== 0 && !edges.some((e) => Math.abs(e - t) <= 0.4)) return;
    for (let y = 0; y < H; y++) {
      f.copy(a, y * W, y * 2 * W, y * 2 * W + W);
      f.copy(b, y * W, y * 2 * W + W, y * 2 * W + 2 * W);
    }
    const bands = lineBands(bandsAround(hints, t), lineH);
    const live = plates.filter((p) => t >= p.start && t < p.end).map((p) => p.rect);
    for (const band of bands) {
      const area = measureLine(a, W, H, band);
      if (!area || area.y1 - area.y0 < minH) continue;
      let count = 0;
      for (let y = area.y0; y <= area.y1; y++) {
        for (let x = area.x0; x <= area.x1; x++) {
          if (!strokeHit(a, W, x, y, ds) || live.some((r) => inside(r, x, y))) continue;
          if (Math.abs(a[y * W + x] - b[y * W + x]) <= 25) count++;
        }
      }
      if (count < 20 * k) continue;
      let idx = blocks.findIndex((bl) => !bl.ghost && t >= (bl.coverStart ?? bl.start) && t < (bl.coverEnd ?? bl.end));
      if (idx < 0) idx = blocks.findIndex((bl) => t >= bl.start && t < bl.end);
      if (idx >= 0) issues.push({ block: idx, t, rect: area, why: `${count} pixels of the original line still visible` });
    }
  };
  await new Promise<void>((resolve, reject) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', base, '-i', final, '-filter_complex',
      '[0:v]fps=30,format=gray[a];[1:v]fps=30,format=gray[b];[a][b]hstack', '-f', 'rawvideo', 'pipe:1']);
    const size = 2 * W * H;
    let buf: Buffer = Buffer.alloc(0);
    let idx = 0;
    let err = '';
    p.stdout.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) {
        onFrame(buf.subarray(0, size), idx);
        buf = buf.subarray(size);
        idx++;
      }
    });
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`leak scan failed: ${err.slice(-300)}`))));
  });
  return issues;
}

/**
 * Checks every phrase of the finished video on its own frames:
 *  - pixels: the original line, measured again on that exact frame, must sit
 *    under a plate (or be changed by the burn);
 *  - LLM: it reads the caption before and after; any word of the old caption
 *    that is still readable after, and is not in the new text, is a leftover.
 */
export async function checkCover(
  base: string, final: string, blocks: CoverBlock[], plates: CoverPlate[], cues: CaptionCue[], hints: Hint[],
  W: number, H: number, workDir: string, cache: Map<string, Reading | null> = new Map(),
  log: (...a: unknown[]) => void = () => {},
): Promise<CoverIssue[]> {
  const t0 = Date.now();
  const took = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
  const k = W / 720;
  const ds = [3, 5, 7].map((d) => Math.max(2, Math.round(d * k)));
  const jobs: Array<{ block: number; t: number }> = [];
  blocks.forEach((b, i) => {
    if (b.ghost) return;
    const len = b.end - b.start;
    const ts = len > 1.2 ? [b.start + 0.25, (b.start + b.end) / 2, b.end - 0.25] : [(b.start + b.end) / 2];
    for (const t of ts) jobs.push({ block: i, t: Math.round(t * 100) / 100 });
  });
  const issues: CoverIssue[] = await scanLeaks(base, final, blocks, plates, hints, W, H);
  log(`check: frame scan ${took()}, ${issues.length} leak(s)`);
  const frameOf = (t: number) => Math.round(t * 30);
  const frames = jobs.map((j) => frameOf(j.t));
  // The source does not change between rounds; decode its frames once.
  const baseKey = `${base}|${[...new Set(frames)].sort((a, b) => a - b).join(',')}`;
  const [bf, af] = await Promise.all([
    baseFrames.get(baseKey) || grabFrames(base, frames, W, H, workDir, 'b').then((r) => { baseFrames.clear(); baseFrames.set(baseKey, r); return r; }),
    grabFrames(final, frames, W, H, workDir, 'a'),
  ]);
  log(`check: frames ${took()}`);
  const vis = hasVision();
  const read = async (t: number, tag: 'b' | 'a'): Promise<Reading | null> => {
    const key = `${tag}:${t}`;
    if (tag === 'b' && cache.has(key)) return cache.get(key) || null;
    const jpg = (tag === 'b' ? bf : af).jpg.get(frameOf(t));
    const r = jpg ? await readCaption(jpg, W, H) : null;
    if (tag === 'b') cache.set(key, r);
    return r;
  };
  const readings = vis
    ? await pool(jobs, 16, async (j) => Promise.all([read(j.t, 'b'), read(j.t, 'a')]))
    : jobs.map(() => [null, null] as Array<Reading | null>);
  log(`check: ${jobs.length} phrase reads ${took()}`);
  const lineH = medianLineH(blocks);

  for (let n = 0; n < jobs.length; n++) {
    const j = jobs[n];
    const b = blocks[j.block];
    const [wasRaw, now] = readings[n];
    // Captions do not jump within one phrase: lines read far from it are misreads.
    const near = (r: Rect) => !b.lines.length || b.ghost ||
      (centerY(r) >= Math.min(...b.lines.map((l) => l.y0)) - 0.05 * H && centerY(r) <= Math.max(...b.lines.map((l) => l.y1)) + 0.05 * H);
    const was = wasRaw && b.style === 'stroke' ? { ...wasRaw, lines: wasRaw.lines.filter((l) => near(l.box)) } : wasRaw;
    const before = bf.gray.get(frameOf(j.t));
    const after = af.gray.get(frameOf(j.t));
    if (!before || !after) continue;
    const live = plates.filter((p) => j.t >= p.start && j.t < p.end).map((p) => p.rect);

    // Pixels: re-measure the original lines on this exact frame (where the LLM
    // read them, else where the plan put them) and look for uncovered letters.
    const isCard = b.style === 'card' && !!b.card;
    const bands = lineBands(was && was.lines.length ? was.lines.map((l) => l.box) : (isCard ? [] : b.lines), lineH);
    const areas = isCard
      ? [measureCard(before, W, H, { ...pad(b.card as Rect, 0, 0.03 * H, W, H), x0: 0, x1: W })].filter((r): r is Rect => !!r)
      : bands.map((r) => measureLine(before, W, H, r)).filter((r): r is Rect => !!r);
    for (const area of areas) {
      let count = 0;
      for (let y = area.y0; y <= area.y1; y++) {
        for (let x = area.x0; x <= area.x1; x++) {
          const hit = isCard ? before[y * W + x] >= 222 : strokeHit(before, W, x, y, ds);
          if (!hit || live.some((r) => inside(r, x, y))) continue;
          if (Math.abs(before[y * W + x] - after[y * W + x]) > 25) continue;
          count++;
        }
      }
      if (count >= 20 * k) {
        issues.push({ block: j.block, t: j.t, rect: area, why: `${count} pixels of the original line still visible` });
      }
    }

    // LLM: words of the old caption that can still be read after the burn.
    if (!was || !now) continue;
    const oldW = new Set(was.lines.flatMap((l) => words(l.text)));
    const newW = new Set(cues.filter((c) => c.end > j.t - 0.4 && c.start < j.t + 0.4).flatMap((c) => words(c.text)));
    for (const line of now.lines.filter((l) => b.style === 'card' || near(l.box))) {
      const left = words(line.text).filter((w) => oldW.has(w) && !newW.has(w));
      if (!left.length) continue;
      const rect = measureLine(before, W, H, line.box) || pad(line.box, 0.02 * W, 0.008 * H, W, H);
      issues.push({ block: j.block, t: j.t, rect, why: `old words still readable: ${left.join(' ')}` });
    }
  }
  return issues;
}

/** Grows the plates of the blocks that leaked so they cover what was seen. */
export function applyFixes(blocks: CoverBlock[], issues: CoverIssue[], W: number, H: number): CoverBlock[] {
  return blocks.map((b, i) => {
    const mine = issues.filter((x) => x.block === i);
    if (!mine.length) return b;
    if (b.style === 'card' && b.card) {
      let card = b.card;
      for (const m of mine) card = m.rect ? union(card, m.rect) : pad(card, 0.02 * W, 0.012 * H, W, H);
      return { ...b, card };
    }
    let lines = b.lines.filter((r) => r.x1 > r.x0).map((r) => ({ ...r }));
    for (const m of mine) {
      if (m.rect) lines = clusterLines([...lines, m.rect]);
      else lines = lines.map((r) => pad(r, 0.025 * W, 0.008 * H, W, H));
    }
    return { ...b, lines, ghost: false };
  });
}
