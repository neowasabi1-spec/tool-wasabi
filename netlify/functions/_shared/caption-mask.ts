import fs from 'fs';
import path from 'path';
import { run, FFMPEG } from './video';

/**
 * Locate a burned-in caption using only the clip itself.
 *
 * The subtitle detector used after a cleanup pass compares the original against
 * the model's output, which is useless before any model has run. Here the signal
 * comes from the caption's own look: it is bright, it sits inside the measured
 * text band, and it is outlined or shadowed, so every glyph pixel has a much
 * darker pixel a couple of pixels away. A white wall does not.
 *
 * The result is a per-frame mask, which is exactly what the video inpainting
 * models on Replicate want as input and the piece that was missing when they
 * were first tried.
 */

const COLOR_TOL = 110;  // L1 distance from the caption colour that still counts
const DILATE = 8;       // px grown around matches (antialiasing, outline, shadow)
// Glyphs are judged after growing them sideways only. A caption is a horizontal
// run of letters with whatever else is on screen sitting above or below it, so
// growing wide joins the letters into one line while growing tall welds the line
// onto its neighbours: at a symmetric DILATE an outlined badge fused with the
// caption underneath it and the mask ended up on the badge, leaving the words
// untouched. Growing evenly but less is not a way out either — the letters then
// stay separate blobs and only one word of the line survives the shape test.
const SHAPE_DILATE_X = 8;
const SHAPE_DILATE_Y = 2;
// Height ceilings for "this is a line of words", as a share of the frame: one
// line on its own, and a whole caption block after the lines have been grown
// together. Measured on these shots a single line runs about 7% and a two-line
// block about 19%, while the badge that hijacked the mask was 39%.
const LINE_TALLEST = 0.18;
const BLOCK_TALLEST = 0.30;

export type CaptionMasks = {
  masks: Uint8Array[];
  colours: [number, number, number][];
  kind: 'saturated' | 'white' | 'both';
  samples: number;
  pxPerFrame: number;
  /** How much of its own bounding box the mask fills: high for text, low for scatter. */
  blockFill: number;
  /** Share of frames where a caption was found. */
  textFrames: number;
};

/**
 * Is this mask safe to hand to a video remover?
 *
 * A caption, even a two-line one, is a small part of the frame. When the match
 * grows past a few percent it is no longer tracking glyphs but something broad
 * and bright in the shot, and handing that to a remover destroys real footage —
 * a light hoodie once came back without its drawstring. Past that ceiling the
 * caller falls back to the older detector instead.
 */
export function maskIsTrustworthy(cm: CaptionMasks, w: number, h: number): { ok: boolean; why: string } {
  const coverage = cm.pxPerFrame / (w * h);
  const pct = (coverage * 100).toFixed(1);
  const what = cm.kind === 'both' ? 'white + highlight caption' : `${cm.kind} caption`;
  const conc = Math.round(cm.blockFill * 100);
  if (cm.samples < 400) return { ok: false, why: `only ${cm.samples} outlined samples` };
  if (!cm.pxPerFrame) return { ok: false, why: 'nothing shaped like a caption line' };
  if (cm.blockFill < 0.55) return { ok: false, why: `match is scattered, fills only ${conc}% of its own box` };
  // Two lines of large caption legitimately reach a tenth of the frame, so the
  // ceiling is generous; the row test is what rejects the wide false matches.
  if (coverage > 0.16) return { ok: false, why: `${what} match covers ${pct}% of the frame` };
  return { ok: true, why: `${what}, ${pct}% of the frame, ${conc}% block fill` };
}

/**
 * Row the caption is expected around, from competitor_shots.text_region
 * ("center 0.40-0.60").
 *
 * The stored band is only a hint: on some shots it frames a single line of a
 * two-line caption, on others it landed on a patterned shirt instead of the text
 * below it. So the frame is searched in full and this row only says which of the
 * candidate lines is most likely the caption.
 */
export function bandCentre(region: string | null | undefined, h: number): number {
  const m = String(region || '').match(/(\d*\.?\d+)\s*-\s*(\d*\.?\d+)/);
  if (!m) return Math.round(h * 0.7);
  return Math.round(((parseFloat(m[1]) + parseFloat(m[2])) / 2) * h);
}

/**
 * Caption colours learned from outlined bright pixels.
 *
 * Captions in these ads are usually white with one word highlighted in a
 * saturated colour. Learning a single colour left the other half of the line on
 * screen — the yellow word vanished and the white words stayed perfectly
 * readable — so both families are kept and the mask matches either.
 */
function learnColour(
  buf: Buffer, frames: number, w: number, h: number, y0: number, y1: number,
): {
  colours: [number, number, number][];
  kind: 'saturated' | 'white' | 'both';
  samples: number;
} | null {
  const sat: number[][] = [];
  const white: number[][] = [];
  const fsz = w * h * 3;
  const step = Math.max(1, Math.floor(frames / 12));
  for (let f = 0; f < frames; f += step) {
    for (let y = y0 + 2; y < y1 - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = f * fsz + (y * w + x) * 3;
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        const mx = Math.max(r, g, b);
        if (mx < 190) continue;
        let outlined = false;
        for (let dy = -2; dy <= 2 && !outlined; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const j = f * fsz + ((y + dy) * w + (x + dx)) * 3;
            if (Math.max(buf[j], buf[j + 1], buf[j + 2]) < mx - 70) { outlined = true; break; }
          }
        }
        if (!outlined) continue;
        if (mx - Math.min(r, g, b) > 100) sat.push([r, g, b]);
        else if (Math.min(r, g, b) > 200) white.push([r, g, b]);
      }
    }
  }
  const med = (arr: number[][], k: number) => {
    const v = arr.map((p) => p[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)] || 0;
  };
  const colours: [number, number, number][] = [];
  const hasSat = sat.length >= 200;
  // Caption white is printed white: near 255 on every channel and neutral. A
  // washed-out [226,212,212] is a car highlight or a bright wall, and letting it
  // in scattered the mask across half the shot.
  const wMed: [number, number, number] = [med(white, 0), med(white, 1), med(white, 2)];
  const hasWhite =
    white.length >= 200 && Math.min(...wMed) >= 235 && Math.max(...wMed) - Math.min(...wMed) <= 14;
  if (hasSat) colours.push([med(sat, 0), med(sat, 1), med(sat, 2)]);
  if (hasWhite) colours.push(wMed);
  if (!colours.length) return null;
  return {
    colours,
    kind: hasSat && hasWhite ? 'both' : hasSat ? 'saturated' : 'white',
    samples: (hasSat ? sat.length : 0) + (hasWhite ? white.length : 0),
  };
}

/** Dilation by `rx` px sideways and `ry` px vertically, within the given rows. */
function dilate(
  src: Uint8Array, w: number, h: number, y0: number, y1: number, rx: number, ry: number,
): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      if (!src[y * w + x]) continue;
      for (let dy = -ry; dy <= ry; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -rx; dx <= rx; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * Keep only blobs shaped like a line of text, in place.
 *
 * Judging the whole mask at once punished two-line captions, because the gap
 * between the lines counts against them, and let a shirt in the caption's colour
 * ride along with the real text. Each blob is judged instead: a caption line is
 * wider than it is tall and, after growing, nearly solid. Returns how full the
 * kept blobs are, and how many pixels survived.
 */
function keepTextBlobs(
  mask: Uint8Array, w: number, y0: number, y1: number, centre: number,
  tallestRatio: number,
): { fill: number; px: number } {
  const label = new Int32Array(mask.length);
  const blobs: { size: number; x0: number; x1: number; y0: number; y1: number }[] = [
    { size: 0, x0: 0, x1: 0, y0: 0, y1: 0 },
  ];
  const stack: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!mask[start] || label[start]) continue;
      const id = blobs.length;
      const b = { size: 0, x0: x, x1: x, y0: y, y1: y };
      label[start] = id;
      stack.push(start);
      while (stack.length) {
        const p = stack.pop() as number;
        b.size++;
        const py = Math.floor(p / w), px = p % w;
        if (px < b.x0) b.x0 = px;
        if (px > b.x1) b.x1 = px;
        if (py < b.y0) b.y0 = py;
        if (py > b.y1) b.y1 = py;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || nx >= w || ny < y0 || ny >= y1) continue;
          const n = ny * w + nx;
          if (mask[n] && !label[n]) { label[n] = id; stack.push(n); }
        }
      }
      blobs.push(b);
    }
  }
  if (blobs.length < 2) return { fill: 0, px: 0 };
  // A blob taller than this is a graphic rather than a line of words: an outlined
  // badge sitting above the caption used to end up in the mask while the words
  // underneath were never touched. The caller passes a tight ratio while lines
  // are still separate and a loose one afterwards, because a two-line caption
  // becomes a single blob once grown and would otherwise be thrown out with it.
  const tallest = Math.max(8, Math.round((y1 - y0) * tallestRatio));
  const lines: number[] = [];
  for (let id = 1; id < blobs.length; id++) {
    const b = blobs[id];
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    if (b.size / (bw * bh) < 0.5 || bw < bh || bh > tallest) continue;
    lines.push(id);
  }
  // Scale "big enough to be a word" to the line-shaped candidates rather than to
  // every blob: a bright shape elsewhere in the frame would otherwise set the bar
  // so high that the caption itself counts as noise.
  const biggest = lines.reduce((m, id) => Math.max(m, blobs[id].size), 0);
  const shaped = lines.filter((id) => blobs[id].size >= biggest * 0.2);
  // Every line-shaped match is kept, wherever it sits. Grouping them around the
  // biggest one looked safer but threw away real overlays: a shot with a caption
  // mid-frame and a call-to-action button above it had the button masked and the
  // words left on screen, because the two were too far apart to be treated as one
  // caption. Both are burned in, and both have to go.
  const keep = new Set<number>(shaped);
  let px = 0, fillSum = 0;
  for (const id of shaped) {
    const b = blobs[id];
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    px += b.size;
    fillSum += (b.size / (bw * bh)) * b.size;
  }
  for (let p = 0; p < mask.length; p++) if (mask[p] && !keep.has(label[p])) mask[p] = 0;
  return { fill: px ? fillSum / px : 0, px };
}

/**
 * Per-frame caption mask: a pixel counts when it matches one of the caption
 * colours *and* has a much darker pixel within a couple of pixels, the outline
 * or drop shadow every one of these captions carries. Colour alone let a light
 * grey hoodie into the mask and the remover erased the drawstring; the outline
 * test is what separates a glyph from flat bright cloth.
 */
export function captionMasks(
  buf: Buffer, frames: number, w: number, h: number, region: string | null | undefined,
): CaptionMasks | null {
  const centre = bandCentre(region, h);
  const y0 = 0, y1 = h;
  const learned = learnColour(buf, frames, w, h, y0, y1);
  if (!learned) return null;

  // Each colour family is masked and judged on its own. A red plaid shirt has
  // bright squares with dark borders, so it passes the per-pixel tests and used
  // to hijack the mask while the real white caption below went untouched. Only
  // families that come out as text lines are kept, and if none does there is no
  // caption here worth handing to a remover.
  const judged = learned.colours
    .map((colour) => ({ colour, ...familyMask(buf, frames, w, h, centre, colour) }));
  if (process.env.CAPTION_MASK_DEBUG) {
    for (const f of judged) {
      console.log(`  family rgb(${f.colour.join(',')}): fill ${f.blockFill.toFixed(2)}, ` +
        `on ${Math.round(f.textFrames * 100)}% of frames`);
    }
  }
  // Grown glyphs merge into a nearly solid bar. Measured across shots, patterned
  // clothing and stray highlights land around 0.5 to 0.67 while caption lines run
  // 0.7 to 0.99, so the bar sits just under seven tenths.
  const good = judged.filter((f) => f.textFrames >= 0.15 && f.blockFill >= 0.68);
  if (!good.length) return null;

  // Group once, over every kept colour together. Grouping per family let a gold
  // badge through on frames where the yellow caption was absent, because with no
  // caption in that family the badge became its own main line.
  const masks: Uint8Array[] = [];
  let total = 0, fillSum = 0, withText = 0;
  for (let f = 0; f < frames; f++) {
    const union = new Uint8Array(w * h);
    for (const fam of good) {
      const m = fam.masks[f];
      for (let p = 0; p < union.length; p++) if (m[p]) union[p] = 1;
    }
    const kept = keepTextBlobs(union, w, 0, h, centre, BLOCK_TALLEST);
    if (kept.px) { fillSum += kept.fill; withText++; }
    total += kept.px;
    masks.push(union);
  }

  return {
    colours: good.map((f) => f.colour),
    kind: good.length > 1 ? 'both' : learned.kind === 'both'
      ? (Math.max(...good[0].colour) - Math.min(...good[0].colour) > 100 ? 'saturated' : 'white')
      : learned.kind,
    samples: learned.samples,
    masks,
    pxPerFrame: withText ? Math.round(total / withText) : 0,
    blockFill: withText ? fillSum / withText : 0,
    textFrames: withText / frames,
  };
}

/**
 * Mask, per frame, for one caption colour.
 *
 * The masks come back ungrouped, so the caller can group every kept colour
 * together, while the returned scores are measured on grouped copies — that is
 * what says whether this colour behaves like caption text at all.
 */
function familyMask(
  buf: Buffer, frames: number, w: number, h: number, centre: number,
  colour: [number, number, number],
): { masks: Uint8Array[]; perFrame: number[]; blockFill: number; textFrames: number } {
  const [cr, cg, cb] = colour;
  const y0 = 0, y1 = h;
  const fsz = w * h * 3;
  const masks: Uint8Array[] = [];
  const perFrame: number[] = [];
  let rowConc = 0;
  let withText = 0;

  for (let f = 0; f < frames; f++) {
    const hit = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const i = f * fsz + p * 3;
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        if (Math.abs(r - cr) + Math.abs(g - cg) + Math.abs(b - cb) > COLOR_TOL) continue;
        const mx = Math.max(r, g, b);
        let outlined = false;
        for (let dy = -2; dy <= 2 && !outlined; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = f * fsz + (yy * w + xx) * 3;
            if (Math.max(buf[j], buf[j + 1], buf[j + 2]) < mx - 70) { outlined = true; break; }
          }
        }
        if (outlined) hit[p] = 1;
      }
    }
    // Judge the lightly grown glyphs, then grow only what was kept: the shape
    // test sees separate text lines, and the mask handed to the remover still
    // carries the margin it needs for outlines and antialiasing.
    const shape = dilate(hit, w, h, y0, y1, SHAPE_DILATE_X, SHAPE_DILATE_Y);
    keepTextBlobs(shape, w, y0, y1, centre, LINE_TALLEST);
    // Only what the shape test kept is grown into the mask the remover gets, so
    // the extra margin never reaches back to the graphics that were excluded.
    const grown = dilate(shape, w, h, y0, y1, DILATE, DILATE);
    const kept = keepTextBlobs(grown, w, y0, y1, centre, BLOCK_TALLEST);
    // Captions often cover only part of a clip. Empty frames are fine — the mask
    // is simply blank there — so they must not drag the shape score down.
    if (kept.px) { rowConc += kept.fill; withText++; }
    perFrame.push(kept.px);
    masks.push(grown);
  }

  return {
    masks,
    perFrame,
    blockFill: withText ? rowConc / withText : 0,
    textFrames: withText / frames,
  };
}

/**
 * Encode the masks as a white-on-black video at the source resolution, which is
 * the shape the removers expect. Scaling up from the analysis resolution softens
 * edges, so the mask is grown again afterwards.
 */
export async function writeMaskVideo(
  masks: Uint8Array[], w: number, h: number, fps: number,
  outW: number, outH: number, workDir: string,
): Promise<string> {
  const raw = path.join(workDir, 'mask.raw');
  const buf = Buffer.alloc(masks.length * w * h);
  for (let f = 0; f < masks.length; f++) {
    const off = f * w * h;
    for (let p = 0; p < w * h; p++) buf[off + p] = masks[f][p] ? 255 : 0;
  }
  fs.writeFileSync(raw, buf);
  const out = path.join(workDir, 'mask.mp4');
  await run(FFMPEG, [
    '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', String(fps),
    '-i', raw,
    '-vf', `scale=${outW}:${outH}:flags=neighbor,dilation,dilation,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '8', out,
  ]);
  try { fs.rmSync(raw, { force: true }); } catch { /* ignore */ }
  return out;
}
