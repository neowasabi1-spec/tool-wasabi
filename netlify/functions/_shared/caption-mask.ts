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

export type CaptionMasks = {
  masks: Uint8Array[];
  colour: [number, number, number];
  kind: 'saturated' | 'white';
  samples: number;
  pxPerFrame: number;
};

/**
 * Is this mask safe to hand to a video remover?
 *
 * Measured on real shots: a yellow caption gave 13k colour samples over 2.4% of
 * the frame and the removal was clean, while a white caption gave 694 samples
 * spread over 13% — light grey clothing matched the caption colour, and the
 * remover dutifully erased a drawstring and the folds around it. Bright white
 * is simply too common in footage to trust on thin evidence, so it needs both
 * far more samples and a much smaller area before the mask is believed.
 */
export function maskIsTrustworthy(cm: CaptionMasks, w: number, h: number): { ok: boolean; why: string } {
  const coverage = cm.pxPerFrame / (w * h);
  const pct = (coverage * 100).toFixed(1);
  if (cm.kind === 'saturated') {
    if (coverage > 0.06) return { ok: false, why: `saturated match covers ${pct}% of the frame` };
    return { ok: true, why: `saturated caption, ${pct}% of the frame` };
  }
  if (cm.samples < 2000) return { ok: false, why: `only ${cm.samples} white samples` };
  if (coverage > 0.03) return { ok: false, why: `white match covers ${pct}% of the frame` };
  return { ok: true, why: `white caption, ${pct}% of the frame` };
}

/** Rows the caption lives in, from competitor_shots.text_region ("center 0.40-0.60"). */
export function bandRows(region: string | null | undefined, h: number): [number, number] {
  const m = String(region || '').match(/(\d*\.?\d+)\s*-\s*(\d*\.?\d+)/);
  const y0 = m ? Math.floor(parseFloat(m[1]) * h) : Math.floor(h * 0.3);
  const y1 = m ? Math.ceil(parseFloat(m[2]) * h) : Math.ceil(h * 0.95);
  // Captions overflow the measured band a little; give it room both ways.
  const pad = Math.round(h * 0.06);
  return [Math.max(0, y0 - pad), Math.min(h, y1 + pad)];
}

/** Caption colour learned from outlined bright pixels; saturated beats white. */
function learnColour(
  buf: Buffer, frames: number, w: number, h: number, y0: number, y1: number,
): { colour: [number, number, number]; kind: 'saturated' | 'white'; samples: number } | null {
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
  const useSat = sat.length >= 200;
  const pool = useSat ? sat : white;
  if (pool.length < 100) return null;
  return {
    colour: [med(pool, 0), med(pool, 1), med(pool, 2)],
    kind: useSat ? 'saturated' : 'white',
    samples: pool.length,
  };
}

/** Per-frame caption mask: colour match inside the band, then grown. */
export function captionMasks(
  buf: Buffer, frames: number, w: number, h: number, region: string | null | undefined,
): CaptionMasks | null {
  const [y0, y1] = bandRows(region, h);
  const learned = learnColour(buf, frames, w, h, y0, y1);
  if (!learned) return null;
  const [cr, cg, cb] = learned.colour;
  const fsz = w * h * 3;
  const masks: Uint8Array[] = [];
  let total = 0;

  for (let f = 0; f < frames; f++) {
    const hit = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const i = f * fsz + p * 3;
        const d = Math.abs(buf[i] - cr) + Math.abs(buf[i + 1] - cg) + Math.abs(buf[i + 2] - cb);
        if (d <= COLOR_TOL) hit[p] = 1;
      }
    }
    const grown = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        if (!hit[y * w + x]) continue;
        for (let dy = -DILATE; dy <= DILATE; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -DILATE; dx <= DILATE; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < w) grown[yy * w + xx] = 1;
          }
        }
      }
    }
    for (let p = 0; p < grown.length; p++) if (grown[p]) total++;
    masks.push(grown);
  }

  return { ...learned, masks, pxPerFrame: Math.round(total / frames) };
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
