/* Sanity-check parseOcrBoxes against the shapes Florence-2 can come back as
 * (JSON object, JSON string, python-ish repr) plus a noise case.
 *   node scripts/test-ocr-box-parse.js
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'netlify', 'functions', 'inpaint-shot-background.mts'),
  'utf8',
);
// Compile just the parser: pull it out of the module so we don't drag in the
// Supabase/ffmpeg imports.
const start = src.indexOf('export function parseOcrBoxes');
const end = src.indexOf('/** Create a prediction');
const snippet = `type Box = { x0: number; y0: number; x1: number; y1: number };\n${src.slice(start, end)}\nmodule.exports = { parseOcrBoxes };`;
const js = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const { parseOcrBoxes } = mod.exports;

const W = 720;
const H = 900;
const cases = [
  ['object', { '<OCR_WITH_REGION>': { quad_boxes: [[100, 200, 600, 200, 600, 260, 100, 260]], labels: ['CLICK BELOW'] } }],
  ['json string', JSON.stringify({ quad_boxes: [[72, 90, 648, 90, 648, 180, 72, 180]] })],
  ['python repr', "{'<OCR_WITH_REGION>': {'quad_boxes': [[10.5, 20.0, 700.2, 20.0, 700.2, 80.0, 10.5, 80.0]], 'labels': ['HELLO']}}"],
  ['two boxes', { quad_boxes: [[0, 0, 100, 0, 100, 40, 0, 40], [300, 500, 700, 500, 700, 560, 300, 560]] }],
  ['noise/none', { labels: [], quad_boxes: [] }],
  ['tiny speck', { quad_boxes: [[10, 10, 14, 10, 14, 13, 10, 13]] }],
];

let failures = 0;
for (const [name, input] of cases) {
  const boxes = parseOcrBoxes(input, W, H);
  const pretty = boxes
    .map((b) => `[x ${b.x0.toFixed(2)}-${b.x1.toFixed(2)} y ${b.y0.toFixed(2)}-${b.y1.toFixed(2)}]`)
    .join(' ');
  console.log(`${name.padEnd(12)} -> ${boxes.length} box(es) ${pretty}`);
  const expectEmpty = name === 'noise/none' || name === 'tiny speck';
  if (expectEmpty && boxes.length) { console.log('  FAIL expected none'); failures++; }
  if (!expectEmpty && !boxes.length) { console.log('  FAIL expected boxes'); failures++; }
  if (name === 'two boxes' && boxes.length !== 2) { console.log('  FAIL expected exactly 2'); failures++; }
}
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exit(failures ? 1 : 0);
