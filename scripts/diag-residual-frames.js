/* Find frames where the AI text removal did nothing, i.e. where burned-in text
 * is still on screen. Works by diffing original vs cleaned: pixels the model
 * repainted differ, so the union of those pixels is the caption area, and any
 * frame with (almost) no difference inside that area was skipped by the model.
 *
 *   node scripts/diag-residual-frames.js <orig.mp4> <clean.mp4>
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FFMPEG = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const [orig, clean] = process.argv.slice(2);
if (!orig || !clean) {
  console.log('usage: node scripts/diag-residual-frames.js <orig.mp4> <clean.mp4>');
  process.exit(1);
}

const MW = 96;
const MH = 168;

function ff(args) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => resolve({ code, err }));
  });
}

(async () => {
  const raw = 'C:/Users/Neo/tmp-resid.raw';
  const { code, err } = await ff([
    '-y', '-i', orig, '-i', clean,
    '-filter_complex',
    `[1:v]scale=${MW}:${MH}[b];[0:v]scale=${MW}:${MH}[a];[a][b]blend=all_mode=difference,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', raw,
  ]);
  if (code !== 0) {
    console.log('ffmpeg failed:', err.split(/\r?\n/).slice(-4).join(' | '));
    process.exit(1);
  }

  const buf = fs.readFileSync(raw);
  const fsz = MW * MH;
  const n = Math.floor(buf.length / fsz);

  // Union of repainted pixels across all frames = the caption area.
  const hot = new Uint8Array(fsz);
  for (let f = 0; f < n; f++) {
    for (let i = 0; i < fsz; i++) if (buf[f * fsz + i] > 40) hot[i] = 1;
  }
  let x0 = MW, x1 = -1, y0 = MH, y1 = -1, hotCount = 0;
  for (let y = 0; y < MH; y++) {
    for (let x = 0; x < MW; x++) {
      if (hot[y * MW + x]) {
        hotCount++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (hotCount === 0) {
    console.log(`frames=${n} — model repainted NOTHING: text present on every frame`);
    process.exit(0);
  }
  console.log(`frames=${n} caption area: x ${(x0 / MW).toFixed(2)}-${(x1 / MW).toFixed(2)} y ${(y0 / MH).toFixed(2)}-${(y1 / MH).toFixed(2)} (${hotCount} px)`);

  // Per-frame repaint energy inside that area.
  const energy = [];
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) sum += buf[f * fsz + y * MW + x];
    }
    energy.push(sum / ((y1 - y0 + 1) * (x1 - x0 + 1)));
  }
  const sorted = [...energy].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const thr = Math.max(2, median * 0.25);
  const skipped = energy.map((e, i) => ({ i, e })).filter((r) => r.e < thr);
  console.log(`median energy ${median.toFixed(1)}, threshold ${thr.toFixed(1)}`);
  console.log(`frames with no repaint: ${skipped.length}/${n}` +
    (skipped.length ? ` -> ${skipped.map((r) => r.i).join(',')}` : ''));
  console.log('per-frame energy:', energy.map((e) => e.toFixed(0)).join(' '));
})();
