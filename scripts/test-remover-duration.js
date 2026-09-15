/* Truncated MiniMax output used to be thrown away, which left the original
 * subtitled footage in place. Short gaps are padded; only a severely short
 * result is discarded.
 *   node scripts/test-remover-duration.js
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'netlify', 'functions', 'inpaint-shot-background.mts'),
  'utf8',
);
const start = src.indexOf('export function shouldKeepRemoverOutput');
const end = src.indexOf('async function ensureDuration');
if (start < 0 || end < 0) {
  console.error('could not find shouldKeepRemoverOutput');
  process.exit(1);
}
const snippet = `${src.slice(start, end)}\nmodule.exports = { shouldKeepRemoverOutput };`;
const js = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const { shouldKeepRemoverOutput } = mod.exports;

const cases = [
  ['exact', 1.70, 1.70, 'keep'],
  ['tiny shortfall', 1.55, 1.70, 'keep'],
  ['padable', 1.30, 1.70, 'pad'],
  ['too short', 1.00, 1.70, 'discard'],
  ['zero', 0, 1.70, 'discard'],
];

let failed = 0;
for (const [name, got, want, expect] of cases) {
  const gotV = shouldKeepRemoverOutput(got, want);
  const ok = gotV === expect;
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}: ${got}s of ${want}s → ${gotV} (want ${expect})`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
