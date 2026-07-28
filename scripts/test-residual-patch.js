/* End-to-end local check of the stage-2a residual patch, using the very
 * functions the Netlify function uses: diff original vs cleaned, find frames the
 * remover skipped, erase the caption area only on those frames' windows, then
 * re-diff to prove no skipped frames are left.
 *
 *   node scripts/test-residual-patch.js <orig.mp4> <clean.mp4> [out.mp4]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ts = require('typescript');

const FFMPEG = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const [orig, clean, outArg] = process.argv.slice(2);
if (!orig || !clean) {
  console.log('usage: node scripts/test-residual-patch.js <orig.mp4> <clean.mp4> [out.mp4]');
  process.exit(1);
}
const out = outArg || 'C:/Users/Neo/tmp-patched.mp4';

const src = fs.readFileSync(
  path.join(__dirname, '..', 'netlify', 'functions', 'inpaint-shot-background.mts'),
  'utf8',
);
const start = src.indexOf('const MW = 96;');
const end = src.indexOf('export default async');
const snippet = `type Box = { x0: number; y0: number; x1: number; y1: number };
${src.slice(start, end).replace(/async function diffFrames[\s\S]*?\n}\n/, '')}
module.exports = { analyzeResidual, framesToWindows, toRect, buildEraseGraph };`;
const js = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const { analyzeResidual, framesToWindows, toRect, buildEraseGraph } = mod.exports;

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

async function diff(a, b, raw) {
  const { code, err } = await ff([
    '-y', '-i', a, '-i', b, '-filter_complex',
    `[1:v]scale=${MW}:${MH}[y];[0:v]scale=${MW}:${MH}[x];[x][y]blend=all_mode=difference,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', raw,
  ]);
  if (code !== 0) throw new Error(err.split(/\r?\n/).slice(-3).join(' | '));
  return fs.readFileSync(raw);
}

async function probe(file) {
  const { err } = await ff(['-hide_banner', '-i', file]);
  const dim = err.match(/Video:.*?[,\s](\d{2,5})x(\d{2,5})/);
  const fps = err.match(/(\d+(?:\.\d+)?)\s+fps/);
  return { W: dim ? +dim[1] : 0, H: dim ? +dim[2] : 0, fps: fps ? parseFloat(fps[1]) : 30 };
}

(async () => {
  const { W, H, fps } = await probe(clean);
  const before = analyzeResidual(await diff(orig, clean, 'C:/Users/Neo/tmp-d1.raw'));
  console.log(`source ${W}x${H} @ ${fps}fps`);
  if (!before.area) {
    console.log('nothing was repainted -> stage 2b (OCR) territory, not 2a');
    process.exit(0);
  }
  console.log(`caption area x ${before.area.x0.toFixed(2)}-${before.area.x1.toFixed(2)} ` +
    `y ${before.area.y0.toFixed(2)}-${before.area.y1.toFixed(2)}`);
  console.log(`skipped frames BEFORE: ${before.badFrames.length}/${before.frames} [${before.badFrames.join(',')}]`);
  if (!before.badFrames.length) { console.log('already clean on every frame'); process.exit(0); }

  const windows = framesToWindows(before.badFrames, fps);
  const rects = windows.map((w) => toRect({ b: before.area, t0: w.t0, t1: w.t1 }, W, H)).filter(Boolean);
  console.log(`windows: ${windows.map((w) => `${w.t0.toFixed(2)}-${w.t1.toFixed(2)}s`).join(' ')}`);

  const graph = buildEraseGraph(rects);
  const { code, err } = await ff([
    '-y', '-i', clean, '-filter_complex', graph,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', out,
  ]);
  if (code !== 0) {
    console.log('render FAILED:', err.split(/\r?\n/).slice(-5).join(' | '));
    process.exit(1);
  }

  const after = analyzeResidual(await diff(orig, out, 'C:/Users/Neo/tmp-d2.raw'));
  console.log(`skipped frames AFTER:  ${after.badFrames.length}/${after.frames} [${after.badFrames.join(',')}]`);
  const ok = after.badFrames.length === 0;
  console.log(ok ? 'OK — no frame left untouched' : 'STILL SKIPPED FRAMES');
  console.log('output:', out);
  process.exit(ok ? 0 : 1);
})();
