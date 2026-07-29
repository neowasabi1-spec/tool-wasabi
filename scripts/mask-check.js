/* Run the caption mask detector locally on shots and preview what it selects.
 *
 * Replicate runs cost money and take minutes, so the mask is judged here first:
 * it prints what colours were learned and how much of the frame is selected, and
 * writes a frame with the mask painted magenta so it is obvious whether it sits
 * on the glyphs or on someone's shirt.
 *
 *   node scripts/mask-check.js 147,124
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawn } = require('child_process');
const ts = require('typescript');
const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const BUCKET = 'project-files';
const FFMPEG = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const OUT = 'C:/Users/Neo/tmp-compare';
// Same analysis width the cleanup function uses (RGB_W), so a verdict here is
// the verdict there. At 320 the scores drifted enough to flip borderline shots.
const W = 400;

// caption-mask.ts only needs run() and FFMPEG from ./video, so stub that away
// rather than dragging the whole Netlify helper into this script.
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === './video') return { FFMPEG, run: () => Promise.resolve('') };
  return origLoad(req, parent, isMain);
};
function loadTs(file) {
  const src = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  return m.exports;
}
const { captionMasks, maskIsTrustworthy } = loadTs(
  path.join(__dirname, '..', 'netlify', 'functions', '_shared', 'caption-mask.ts'),
);

function ff(args, wantStdout) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args);
    const out = [];
    let err = '';
    if (wantStdout) p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (c) => (c === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err.slice(-300)))));
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ids = String(process.argv[2] || '').split(',').map(Number).filter(Boolean);
  const which = process.argv[3] === 'clean' ? 'clean' : 'orig';
  const s = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data: shots } = await s
    .from('competitor_shots')
    .select('id, file_path, clean_path, text_region, duration_sec')
    .in('id', ids);

  for (const id of ids) {
    const shot = (shots || []).find((x) => x.id === id);
    if (!shot) { console.log(`shot ${id}: not found`); continue; }
    // "clean" inspects the cleaned copy instead, which answers whether running
    // the same pass again would catch what the first one left behind.
    const key = which === 'clean' ? shot.clean_path : shot.file_path;
    if (!key) { console.log(`shot ${id}: no ${which} copy`); continue; }
    const src = path.join(OUT, `m_${id}_${which}.mp4`);
    if (!fs.existsSync(src)) {
      const { data, error } = await s.storage.from(BUCKET).download(key);
      if (error || !data) { console.log(`shot ${id}: download failed`); continue; }
      fs.writeFileSync(src, Buffer.from(await data.arrayBuffer()));
    }
    // Frames at the analysis width, 6 fps is plenty to learn colours.
    const raw = await ff(['-i', src, '-vf', `fps=6,scale=${W}:-2`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], true);
    // ffmpeg prints the stream size on stderr, which saves needing ffprobe here.
    const info = await new Promise((resolve) => {
      const p = spawn(FFMPEG, ['-i', src]);
      let e = '';
      p.stderr.on('data', (d) => (e += d.toString()));
      p.on('close', () => resolve(e));
    });
    const dim = info.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
    const sw = dim ? Number(dim[1]) : 0;
    const sh = dim ? Number(dim[2]) : 0;
    if (!sw || !sh) { console.log(`shot ${id}: could not probe size`); continue; }
    const h = Math.round((sh * W) / sw / 2) * 2;
    if (raw.length % (W * h * 3) !== 0) { console.log(`shot ${id}: odd frame size ${W}x${h}`); continue; }
    const frames = raw.length / (W * h * 3);

    const cm = captionMasks(raw, frames, W, h, shot.text_region);
    if (!cm) { console.log(`shot ${id}: no caption colour found`); continue; }
    const trust = maskIsTrustworthy(cm, W, h);
    console.log(
      `shot ${id}: ${cm.kind}, colours ${JSON.stringify(cm.colours)}, ` +
      `samples ${cm.samples}, ${((cm.pxPerFrame / (W * h)) * 100).toFixed(2)}% ` +
      `on ${Math.round(cm.textFrames * 100)}% of frames ` +
      `-> ${trust.ok ? 'USE MASK' : 'fallback'} (${trust.why})`,
    );

    // Paint the mask over a few moments so the selection can be eyeballed: a
    // caption that moves between lines is only visible at some of them.
    const shown = [];
    for (const frac of [0.3, 0.55, 0.8]) {
      const f = Math.min(frames - 1, Math.floor(frames * frac));
      const px = Buffer.from(raw.subarray(f * W * h * 3, (f + 1) * W * h * 3));
      const mask = cm.masks[f];
      for (let p = 0; p < W * h; p++) {
        if (!mask[p]) continue;
        px[p * 3] = 255; px[p * 3 + 1] = 0; px[p * 3 + 2] = 255;
      }
      const cell = path.join(OUT, `mask_${id}_${which}_${Math.round(frac * 100)}.png`);
      const rawFile = path.join(OUT, `mask_${id}_${which}_${Math.round(frac * 100)}.raw`);
      fs.writeFileSync(rawFile, px);
      await ff(['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${h}`, '-i', rawFile, cell]);
      fs.rmSync(rawFile, { force: true });
      shown.push(cell);
    }
    const png = path.join(OUT, `mask_${id}_${which}.png`);
    await ff(['-y', ...shown.flatMap((c) => ['-i', c]),
      '-filter_complex', `hstack=inputs=${shown.length}`, png]);
    console.log(`  preview: ${png}`);
  }
})();
