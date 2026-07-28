/* End-to-end local check of stage 2a, using the very functions the Netlify
 * function uses: learn the caption colour, flag every frame where that colour
 * survives, drop those frames holding the previous good one, then re-check the
 * output frame by frame and confirm duration and frame count survived.
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
const snippet = `type Box = { x0: number; y0: number; x1: number; y1: number };
${src.slice(src.indexOf('const RGB_W = 400;'), src.indexOf('export default async'))
    .replace(/async function [\s\S]*?\n}\n/g, '')}
module.exports = { analyzeLeftoverText, buildDropGraph, toRect, buildEraseGraph };`;
// ES2020 target matters: downlevelled spread of a Set yields an empty array.
const js = ts.transpileModule(snippet, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const { analyzeLeftoverText, buildDropGraph } = mod.exports;

const RGB_W = 400;

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
  const d = err.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  return {
    W: dim ? +dim[1] : 0,
    H: dim ? +dim[2] : 0,
    fps: fps ? parseFloat(fps[1]) : 30,
    dur: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0,
  };
}

async function rgb(file, W, H, raw) {
  const w = RGB_W;
  const h = Math.round((H / W) * w / 2) * 2;
  await must(['-y', '-i', file, '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], 'rgb');
  return { buf: fs.readFileSync(raw), w, h };
}

(async () => {
  const { W, H, fps, dur } = await probe(clean);
  const a = await rgb(orig, W, H, 'C:/Users/Neo/tmp-rgb0.raw');
  const b = await rgb(clean, W, H, 'C:/Users/Neo/tmp-rgb1.raw');
  const res = analyzeLeftoverText(a.buf, b.buf, a.w, a.h);
  console.log(`source ${W}x${H} @ ${fps}fps, ${dur.toFixed(2)}s, analysis ${a.w}x${a.h}`);
  console.log(`repainted mask ${res.maskPx} px, caption colour ${res.colour ? `rgb(${res.colour.join(',')})` : 'unknown'}`);
  if (!res.maskPx) { console.log('nothing repainted -> stage 2b (OCR) territory'); process.exit(0); }
  console.log(`showing text BEFORE: ${res.bad.length}/${res.frames} ` +
    `[${res.bad.map((f) => `${f}(${res.counts[f]})`).join(' ')}]`);
  if (!res.bad.length) { console.log('OK — already clean on every frame'); process.exit(0); }

  const graph = buildDropGraph(res.bad, fps);
  console.log(`graph: ${graph}`);
  await must(['-y', '-i', clean, '-vf', graph,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', out], 'render');

  const after = await probe(out);
  const c = await rgb(out, after.W, after.H, 'C:/Users/Neo/tmp-rgb2.raw');

  // Dropping shifts frames, so compare each output frame with the source frame
  // that now occupies its slot: survivors shift left by the leading drop count,
  // and gaps hold the previous survivor.
  let lead = 0;
  while (res.bad.includes(lead)) lead++;
  const survivors = [...Array(res.frames).keys()].filter((f) => !res.bad.includes(f));
  const fsz = a.w * a.h * 3;
  const outFrames = Math.floor(c.buf.length / fsz);
  const remap = Buffer.alloc(outFrames * fsz);
  for (let i = 0; i < outFrames; i++) {
    const want = i + lead;
    let s = survivors[0];
    for (const f of survivors) if (f <= want) s = f;
    a.buf.copy(remap, i * fsz, s * fsz, (s + 1) * fsz);
  }
  const res2 = analyzeLeftoverText(remap, c.buf, c.w, c.h);
  console.log(`showing text AFTER:  ${res2.bad.length}/${res2.frames} ` +
    `[${res2.bad.map((f) => `${f}(${res2.counts[f]})`).join(' ')}] worst frame ${Math.max(0, ...res2.counts)}`);
  console.log(`duration ${dur.toFixed(2)}s -> ${after.dur.toFixed(2)}s, frames ${res.frames} -> ${outFrames}`);

  const kept = Math.abs(after.dur - dur) < 0.09 && Math.abs(outFrames - res.frames) <= 2;
  const ok = res2.bad.length === 0 && kept;
  console.log(ok ? 'OK — no text left, timing preserved' : (res2.bad.length ? 'STILL SHOWING TEXT' : 'TIMING CHANGED'));
  console.log('output:', out);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log('FAILED:', e.message); process.exit(1); });
