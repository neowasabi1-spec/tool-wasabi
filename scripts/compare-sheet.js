/* Look at a subtitle-removal comparison without paying for another run.
 *
 * run-remover-compare.js leaves its result in <project>/shots-compare/. This
 * downloads the original, the cleanup currently in use and that new attempt,
 * then stacks the same instants from all three so the caption band can be
 * judged side by side: text gone, and background not wrecked.
 *
 *   node scripts/compare-sheet.js <shotId> [model]
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
  const { data, error } = await s.storage.from(BUCKET).download(key);
  if (error || !data) return false;
  fs.writeFileSync(file, Buffer.from(await data.arrayBuffer()));
  return true;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const shotId = Number(process.argv[2]);
  const model = process.argv[3] || 'ayushunleashed/minimax-remover';
  if (!shotId) return console.log('usage: node scripts/compare-sheet.js <shotId> [model]');

  const s = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data: shot } = await s
    .from('competitor_shots')
    .select('id, project_id, file_path, clean_path, duration_sec, text_region')
    .eq('id', shotId)
    .maybeSingle();
  if (!shot) return console.log(`shot #${shotId} not found`);

  const base = `${shot.project_id}/shots-compare/${shotId}_${model.split('/')[1]}`;
  const sources = { orig: shot.file_path, ai: shot.clean_path, new: `${base}.mp4` };
  const local = {};
  for (const [tag, key] of Object.entries(sources)) {
    if (!key) continue;
    const f = path.join(OUT, `shot${shotId}_${tag}.mp4`);
    if (await get(s, key, f)) local[tag] = f;
    else console.log(`missing: ${tag} (${key})`);
  }
  if (!local.new) return console.log('no comparison output stored for this shot yet');

  // Crop around the measured caption band so the text area fills the frame.
  const m = String(shot.text_region || '').match(/(\d*\.?\d+)\s*-\s*(\d*\.?\d+)/);
  const y0 = m ? Math.max(0, parseFloat(m[1]) - 0.06) : 0.35;
  const y1 = m ? Math.min(1, parseFloat(m[2]) + 0.06) : 0.7;
  const crop = `crop=iw:ih*${(y1 - y0).toFixed(3)}:0:ih*${y0.toFixed(3)},scale=300:-1`;
  const dur = shot.duration_sec || 1.4;
  const times = [0.2, 0.45, 0.7, 0.9].map((f) => +(dur * f).toFixed(2));

  const rows = [];
  for (const tag of ['orig', 'ai', 'new']) {
    if (!local[tag]) continue;
    const cols = [];
    for (const t of times) {
      const png = path.join(OUT, `f_${shotId}_${tag}_${String(t).replace('.', '')}.png`);
      await ff(['-y', '-ss', String(t), '-i', local[tag], '-frames:v', '1', '-vf', crop, png]);
      if (fs.existsSync(png)) cols.push(png);
    }
    if (cols.length < 2) continue;
    const row = path.join(OUT, `row_${shotId}_${tag}.png`);
    const r = await ff(['-y', ...cols.flatMap((c) => ['-i', c]), '-filter_complex', `hstack=inputs=${cols.length}`, row]);
    if (r.code === 0) rows.push([tag, row]);
  }
  if (rows.length < 2) return console.log('could not extract enough frames');

  const sheet = path.join(OUT, `shot${shotId}_timeline.png`);
  const r = await ff([
    '-y', ...rows.flatMap(([, f]) => ['-i', f]),
    '-filter_complex', `vstack=inputs=${rows.length}`, sheet,
  ]);
  console.log(r.code === 0
    ? `sheet: ${sheet}\nrows top to bottom: ${rows.map(([t]) => t).join(' / ')} — at ${times.join('s, ')}s`
    : r.err.slice(-400));
})();
