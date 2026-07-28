/* Verify the stage-2 erase filter graph actually runs in ffmpeg, for one and for
 * several text regions, and that clustering merges per-frame detections.
 *   node scripts/test-erase-graph.js <video.mp4>
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ts = require('typescript');

const video = process.argv[2] || 'C:/Users/Neo/tmp-n81.mp4';
const FFMPEG = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'netlify', 'functions', 'inpaint-shot-background.mts'),
  'utf8',
);
const start = src.indexOf('export function parseOcrBoxes');
const end = src.indexOf('export default async');
const snippet = `type Box = { x0: number; y0: number; x1: number; y1: number };\n${src.slice(start, end)}
module.exports = { parseOcrBoxes, clusterDetections, buildEraseGraph, toRect };`;
const js = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const { clusterDetections, buildEraseGraph, toRect } = mod.exports;

const W = 720;
const H = 900;

// Two captions detected on several consecutive frames, as OCR would report them.
const dets = [];
for (let i = 0; i < 5; i++) {
  const t = i / 3;
  dets.push({ b: { x0: 0.20, y0: 0.30, x1: 0.83, y1: 0.42 }, t });          // "CLICK"
  dets.push({ b: { x0: 0.22 + i * 0.004, y0: 0.44, x1: 0.80, y1: 0.55 }, t }); // "BELOW", drifting
  if (i > 2) dets.push({ b: { x0: 0.05, y0: 0.85, x1: 0.35, y1: 0.93 }, t }); // separate lower-left
}

const clusters = clusterDetections(dets, 1 / 3 + 0.2);
console.log(`clustered ${dets.length} detections into ${clusters.length} region(s)`);
for (const c of clusters) {
  console.log(`  x ${c.b.x0.toFixed(2)}-${c.b.x1.toFixed(2)} y ${c.b.y0.toFixed(2)}-${c.b.y1.toFixed(2)} t ${c.t0.toFixed(2)}-${c.t1.toFixed(2)}`);
}

const rects = clusters.map((c) => toRect(c, W, H)).filter(Boolean);
console.log(`-> ${rects.length} pixel rect(s)`);

function runFfmpeg(graph, out) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, [
      '-y', '-i', video, '-filter_complex', graph,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-an', out,
    ]);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => resolve({ code, err }));
  });
}

(async () => {
  let failures = 0;
  for (const [label, subset] of [['single region', rects.slice(0, 1)], ['all regions', rects]]) {
    const graph = buildEraseGraph(subset);
    const out = `C:/Users/Neo/tmp-erase-${subset.length}.mp4`;
    const { code, err } = await runFfmpeg(graph, out);
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
    console.log(`\n${label}: ${subset.length} rect(s) -> exit ${code}, output ${size} bytes`);
    if (code !== 0 || size < 1000) {
      failures++;
      console.log('  GRAPH:', graph);
      console.log('  STDERR TAIL:', err.split(/\r?\n/).filter((l) => l.trim()).slice(-6).join('\n  '));
    }
  }
  console.log(failures ? `\nFAILURES: ${failures}` : '\nALL OK');
  process.exit(failures ? 1 : 0);
})();
