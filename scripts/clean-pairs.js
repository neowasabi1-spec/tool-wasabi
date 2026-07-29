/* Before/after sheet for a batch of subtitle cleanups.
 *
 * One row per shot, read left to right as original, cleaned, original, cleaned
 * at two moments of the clip, cropped to the measured caption band. That is the
 * fastest way to judge a batch: the caption must be gone and the background must
 * still look like footage.
 *
 *   node scripts/clean-pairs.js 79,82,94
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const BUCKET = 'project-files';
const FFMPEG = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const OUT = 'C:/Users/Neo/tmp-compare';

function ff(args) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => resolve({ code, err }));
  });
}

async function get(s, key, file) {
  if (!key) return false;
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return true;
  const { data, error } = await s.storage.from(BUCKET).download(key);
  if (error || !data) return false;
  fs.writeFileSync(file, Buffer.from(await data.arrayBuffer()));
  return true;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ids = String(process.argv[2] || '').split(',').map(Number).filter(Boolean);
  if (!ids.length) return console.log('usage: node scripts/clean-pairs.js 79,82,94');

  const s = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data: shots } = await s
    .from('competitor_shots')
    .select('id, file_path, clean_path, duration_sec, text_region')
    .in('id', ids);

  const rows = [];
  for (const id of ids) {
    const shot = (shots || []).find((x) => x.id === id);
    if (!shot?.clean_path) { console.log(`shot ${id}: no cleaned copy`); continue; }
    const orig = path.join(OUT, `p_${id}_orig.mp4`);
    const clean = path.join(OUT, `p_${id}_clean.mp4`);
    if (!(await get(s, shot.file_path, orig)) || !(await get(s, shot.clean_path, clean))) {
      console.log(`shot ${id}: could not download`);
      continue;
    }
    // Whole frames. Cropping to the stored text band hid the very captions that
    // matter, because that band is the thing that turned out to be unreliable.
    const crop = 'scale=170:-2';
    const dur = shot.duration_sec || 1.4;

    const cells = [];
    for (const frac of [0.35, 0.7]) {
      for (const [tag, file] of [['orig', orig], ['clean', clean]]) {
        const png = path.join(OUT, `p_${id}_${tag}_${frac}.png`);
        await ff(['-y', '-ss', (dur * frac).toFixed(2), '-i', file, '-frames:v', '1', '-vf', crop, png]);
        if (fs.existsSync(png)) cells.push(png);
      }
    }
    if (cells.length < 4) { console.log(`shot ${id}: not enough frames`); continue; }
    const row = path.join(OUT, `p_row_${id}.png`);
    // Uniform height so the rows stack: the crop height varies with the band.
    const r = await ff([
      '-y', ...cells.flatMap((c) => ['-i', c]),
      '-filter_complex',
      cells.map((_, i) => `[${i}:v]scale=170:300,setsar=1[c${i}]`).join(';') +
        ';' + cells.map((_, i) => `[c${i}]`).join('') + `hstack=inputs=${cells.length}[o]`,
      '-map', '[o]', row,
    ]);
    if (r.code === 0) rows.push([id, row]);
    else console.log(`shot ${id}: row failed`);
  }

  if (!rows.length) return console.log('nothing to show');
  const sheet = path.join(OUT, 'reclean_pairs.png');
  const r = await ff([
    '-y', ...rows.flatMap(([, f]) => ['-i', f]),
    '-filter_complex', `vstack=inputs=${rows.length}`, sheet,
  ]);
  console.log(r.code === 0
    ? `sheet: ${sheet}\nrows top to bottom: shots ${rows.map(([id]) => id).join(', ')}\ncolumns: original, cleaned, original, cleaned`
    : r.err.slice(-400));
})();
