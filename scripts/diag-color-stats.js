/* Leftover-text measure in colour: learn the caption colour from the pixels the
 * remover repainted in the original, then count how many pixels still carry that
 * colour in the output. Grey legibility cannot tell a yellow letter fragment
 * from a white highlight; the caption colour can.
 *
 *   node scripts/diag-color-stats.js <orig.mp4> <clean.mp4> [width]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FFMPEG = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const [orig, clean, gwArg] = process.argv.slice(2);
const GW = Number(gwArg) || 400;

function ff(args) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => resolve({ code, err }));
  });
}

(async () => {
  const { err } = await ff(['-hide_banner', '-i', clean]);
  const dim = err.match(/Video:.*?[,\s](\d{2,5})x(\d{2,5})/);
  const W = +dim[1];
  const H = +dim[2];
  const w = GW;
  const h = Math.round((H / W) * GW / 2) * 2;

  const bufs = {};
  for (const [k, f] of [['a', orig], ['b', clean]]) {
    const raw = `C:/Users/Neo/tmp-rgb-${k}.raw`;
    await ff(['-y', '-i', f, '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
    bufs[k] = fs.readFileSync(raw);
  }
  const px = w * h;
  const fsz = px * 3;
  const frames = Math.min(Math.floor(bufs.a.length / fsz), Math.floor(bufs.b.length / fsz));

  // Pixels the model repainted at some point: candidate caption pixels.
  const mask = new Uint8Array(px);
  for (let f = 0; f < frames; f++) {
    for (let p = 0; p < px; p++) {
      const i = f * fsz + p * 3;
      const d = Math.abs(bufs.a[i] - bufs.b[i]) + Math.abs(bufs.a[i + 1] - bufs.b[i + 1]) +
        Math.abs(bufs.a[i + 2] - bufs.b[i + 2]);
      if (d > 90) mask[p] = 1;
    }
  }

  // Caption colour: the repaint mask covers a box around each word, so most
  // masked pixels are background. Captions are either strongly coloured or plain
  // white, so look for a saturated population first and fall back to white.
  const satPix = [];
  const whitePix = [];
  for (let f = 0; f < frames; f += 2) {
    for (let p = 0; p < px; p++) {
      if (!mask[p]) continue;
      const i = f * fsz + p * 3;
      const r = bufs.a[i], g = bufs.a[i + 1], b = bufs.a[i + 2];
      if (Math.max(r, g, b) < 190) continue;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 100) satPix.push([r, g, b]);
      else if (Math.min(r, g, b) > 200) whitePix.push([r, g, b]);
    }
  }
  const med = (arr, k) => {
    const v = arr.map((p) => p[k]).sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)] || 0;
  };
  const useSat = satPix.length >= 200;
  const pool = useSat ? satPix : whitePix;
  const cap = [med(pool, 0), med(pool, 1), med(pool, 2)];
  console.log(`frame ${w}x${h}, ${frames} frames, mask ${mask.reduce((s, v) => s + v, 0)} px`);
  console.log(`caption colour rgb(${cap.join(',')}) from ${pool.length} ` +
    `${useSat ? 'saturated' : 'white'} samples (saturated pool ${satPix.length}, white pool ${whitePix.length})`);

  const out = [];
  for (let f = 0; f < frames; f++) {
    let hit = 0;
    for (let p = 0; p < px; p++) {
      if (!mask[p]) continue;
      const i = f * fsz + p * 3;
      // Original must carry the caption colour here...
      const ao = Math.abs(bufs.a[i] - cap[0]) + Math.abs(bufs.a[i + 1] - cap[1]) + Math.abs(bufs.a[i + 2] - cap[2]);
      if (ao > 110) continue;
      // ...and the output must still carry it.
      const bo = Math.abs(bufs.b[i] - cap[0]) + Math.abs(bufs.b[i + 1] - cap[1]) + Math.abs(bufs.b[i + 2] - cap[2]);
      if (bo <= 110) hit++;
    }
    out.push(hit);
  }
  console.log('caption-colour pixels left per frame:');
  console.log(out.map((v, i) => `${i}:${v}`).join(' '));
})();
