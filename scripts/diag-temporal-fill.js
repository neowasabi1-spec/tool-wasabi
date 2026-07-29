/* Can the pixels under a burned-in caption be rebuilt from the clip itself?
 *
 * A caption covers the same spot for a while, but words change and the scene
 * moves, so the true background at a covered pixel is usually visible in some
 * other frame of the same shot. This uses the remover's output only as a
 * detector (where it repainted = where the text was), finds the caption colour,
 * builds a per-frame text mask, and fills those pixels with the median of the
 * frames where that pixel is NOT text — real pixels from the same shot, no
 * blur, no generative guess.
 *
 * Prints how much is recoverable and how stable the background is, writes the
 * rebuilt clip and a before/after contact sheet.
 *
 *   node scripts/diag-temporal-fill.js <orig.mp4> <clean.mp4> [out.mp4]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FFMPEG = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const [orig, clean, outArg] = process.argv.slice(2);
if (!orig || !clean) {
  console.log('usage: node scripts/diag-temporal-fill.js <orig.mp4> <clean.mp4> [out.mp4]');
  process.exit(1);
}
const out = outArg || 'C:/Users/Neo/tmp-rebuilt.mp4';
const sheet = out.replace(/\.mp4$/, '-sheet.png');

const DIFF = 90;      // sum |orig-clean| above this = the remover touched it
const COL = 110;      // sum |pixel-caption| below this = carries caption colour
// Captions are drawn with a dark outline and a soft shadow, both wider than the
// coloured core, so the mask has to grow well past it or the outline survives as
// a readable shadow. Over-masking is cheap here: the fill comes from real frames.
const DILATE = Number(process.env.DILATE || 8);
const MIN_OBS = 3;    // clean views needed before trusting a median

function ff(args) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => resolve({ code, err }));
  });
}
async function must(args, what) {
  const { code, err } = await ff(args);
  if (code !== 0) throw new Error(`${what}: ${err.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' | ')}`);
  return err;
}
async function probe(file) {
  const { err } = await ff(['-hide_banner', '-i', file]);
  const dim = err.match(/Video:.*?[,\s](\d{2,5})x(\d{2,5})/);
  const fps = err.match(/(\d+(?:\.\d+)?)\s+fps/);
  return { W: +dim[1], H: +dim[2], fps: fps ? parseFloat(fps[1]) : 30 };
}
async function rgb(file, W, H, raw) {
  await must(['-y', '-i', file, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], 'rgb');
  return fs.readFileSync(raw);
}

(async () => {
  const { W, H, fps } = await probe(clean);
  const a = await rgb(orig, W, H, 'C:/Users/Neo/tmp-tf-a.raw');
  const b = await rgb(clean, W, H, 'C:/Users/Neo/tmp-tf-b.raw');
  const px = W * H;
  const fsz = px * 3;
  const N = Math.min(Math.floor(a.length / fsz), Math.floor(b.length / fsz));
  console.log(`${W}x${H} @ ${fps}fps, ${N} frames`);

  // Where the remover repainted at some point: candidate caption pixels.
  const touched = new Uint8Array(px);
  for (let f = 0; f < N; f++) {
    for (let p = 0; p < px; p++) {
      const i = f * fsz + p * 3;
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > DIFF) touched[p] = 1;
    }
  }
  const touchedPx = touched.reduce((s, v) => s + v, 0);
  if (!touchedPx) return console.log('the remover changed nothing — no caption located');

  // Caption colour: saturated population if there is one, else plain white.
  const sat = [], white = [];
  for (let f = 0; f < N; f += 2) {
    for (let p = 0; p < px; p++) {
      if (!touched[p]) continue;
      const i = f * fsz + p * 3;
      const r = a[i], g = a[i + 1], bl = a[i + 2];
      if (Math.max(r, g, bl) < 190) continue;
      if (Math.max(r, g, bl) - Math.min(r, g, bl) > 100) sat.push([r, g, bl]);
      else if (Math.min(r, g, bl) > 200) white.push([r, g, bl]);
    }
  }
  const med = (arr, k) => {
    const v = arr.map((q) => q[k]).sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)] || 0;
  };
  const pool = sat.length >= 200 ? sat : white;
  if (!pool.length) return console.log('could not learn a caption colour');
  const cap = [med(pool, 0), med(pool, 1), med(pool, 2)];
  console.log(`caption colour rgb(${cap.join(',')}) (${sat.length >= 200 ? 'saturated' : 'white'}), ` +
    `repainted area ${touchedPx} px (${(100 * touchedPx / px).toFixed(1)}% of frame)`);

  // Search domain: the box the caption lives in, not only the exact pixels the
  // remover repainted — a word sitting slightly off its usual spot is still
  // caption, and those were the fragments that used to survive.
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let p = 0; p < px; p++) {
    if (!touched[p]) continue;
    const x = p % W, y = (p / W) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const PAD = 10;
  x0 = Math.max(0, x0 - PAD); y0 = Math.max(0, y0 - PAD);
  x1 = Math.min(W - 1, x1 + PAD); y1 = Math.min(H - 1, y1 + PAD);
  const inBand = new Uint8Array(px);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) inBand[y * W + x] = 1;
  console.log(`caption band x ${x0}-${x1}, y ${y0}-${y1} ` +
    `(${(100 * (x1 - x0 + 1) * (y1 - y0 + 1) / px).toFixed(1)}% of frame searched)`);

  // Per-frame text mask: caption-coloured cores inside that band, grown by
  // DILATE so the dark outline and antialiasing go too.
  const masks = [];
  for (let f = 0; f < N; f++) {
    const core = new Uint8Array(px);
    for (let p = 0; p < px; p++) {
      if (!inBand[p]) continue;
      const i = f * fsz + p * 3;
      if (Math.abs(a[i] - cap[0]) + Math.abs(a[i + 1] - cap[1]) + Math.abs(a[i + 2] - cap[2]) <= COL) core[p] = 1;
    }
    const m = new Uint8Array(px);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!core[y * W + x]) continue;
        for (let dy = -DILATE; dy <= DILATE; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -DILATE; dx <= DILATE; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < W) m[yy * W + xx] = 1;
          }
        }
      }
    }
    masks.push(m);
  }
  const everText = new Uint8Array(px);
  let maskedTotal = 0;
  for (const m of masks) for (let p = 0; p < px; p++) { if (m[p]) { everText[p] = 1; maskedTotal++; } }
  const everPx = everText.reduce((s, v) => s + v, 0);
  console.log(`text pixels: ${everPx} distinct (${(100 * everPx / px).toFixed(1)}% of frame), ` +
    `${(maskedTotal / N).toFixed(0)} per frame on average`);

  // For every text pixel: how many frames show it uncovered, and how steady is
  // it there? Steady means a median fill will look right; jumpy means the
  // background moves and this needs flow-based inpainting instead.
  const outBuf = Buffer.from(a.subarray(0, N * fsz));
  let recov = 0, never = 0, thin = 0, devSum = 0, devN = 0;
  const vals = new Array(N);
  for (let p = 0; p < px; p++) {
    if (!everText[p]) continue;
    let n = 0;
    for (let f = 0; f < N; f++) if (!masks[f][p]) vals[n++] = f;
    if (n === 0) { never++; continue; }
    if (n < MIN_OBS) thin++; else recov++;

    for (let c = 0; c < 3; c++) {
      const s = [];
      for (let k = 0; k < n; k++) s.push(a[vals[k] * fsz + p * 3 + c]);
      s.sort((x, y) => x - y);
      const m = s[Math.floor(s.length / 2)];
      if (c === 0) {
        let d = 0;
        for (const v of s) d += Math.abs(v - m);
        devSum += d / s.length; devN++;
      }
      for (let f = 0; f < N; f++) if (masks[f][p]) outBuf[f * fsz + p * 3 + c] = m;
    }
  }
  // Pixels the caption never uncovered keep the remover's guess.
  for (let p = 0; p < px; p++) {
    if (!everText[p]) continue;
    let n = 0;
    for (let f = 0; f < N; f++) if (!masks[f][p]) n++;
    if (n) continue;
    for (let f = 0; f < N; f++) for (let c = 0; c < 3; c++) outBuf[f * fsz + p * 3 + c] = b[f * fsz + p * 3 + c];
  }

  console.log(`recoverable from other frames: ${recov} px (${(100 * recov / everPx).toFixed(1)}%), ` +
    `only 1-2 views: ${thin} (${(100 * thin / everPx).toFixed(1)}%), ` +
    `never uncovered: ${never} (${(100 * never / everPx).toFixed(1)}%)`);
  console.log(`background steadiness at those pixels: ${(devSum / Math.max(1, devN)).toFixed(1)} ` +
    `mean deviation (under ~12 = static enough for a median fill)`);

  const rawOut = 'C:/Users/Neo/tmp-tf-out.raw';
  fs.writeFileSync(rawOut, outBuf);
  await must(['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(fps), '-i', rawOut,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out], 'encode');

  // Contact sheet: original on top, rebuilt below, same four frames.
  const pick = [Math.floor(N * 0.15), Math.floor(N * 0.4), Math.floor(N * 0.6), Math.floor(N * 0.85)];
  const sel = `select='${pick.map((f) => `eq(n\\,${f})`).join('+')}'`;
  await must(['-y', '-i', orig, '-i', out,
    '-filter_complex',
    `[0:v]${sel},scale=300:-1,tile=4x1[t];[1:v]${sel},scale=300:-1,tile=4x1[c];[t][c]vstack`,
    '-frames:v', '1', sheet], 'sheet');
  console.log(`rebuilt: ${out}\nsheet:   ${sheet}`);
})().catch((e) => { console.log('FAILED:', e.message); process.exit(1); });
