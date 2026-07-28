/* Pull the AI-cleaned copies of the usable shots and lay original vs cleaned
 * side by side, so it is obvious when the cleanup degenerated into a big
 * smeared box instead of removing letters.
 *   node scripts/diag-clean-quality.js
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
const OUT = 'C:/Users/Neo/tmp-clean-check';

function ff(args) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => resolve({ code, err }));
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const s = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data: shots } = await s
    .from('competitor_shots')
    .select('id, file_path, clean_path, inpaint_error, text_region, duration_sec')
    .not('clean_path', 'is', null)
    .order('id');

  for (const sh of shots || []) {
    console.log(`\nshot #${sh.id} ${sh.duration_sec}s region=${sh.text_region}` +
      (sh.inpaint_error ? ` note: ${sh.inpaint_error}` : ''));
    for (const [tag, key] of [['orig', sh.file_path], ['clean', sh.clean_path]]) {
      const { data, error } = await s.storage.from(BUCKET).download(key);
      if (error) { console.log(`  ${tag}: download failed — ${error.message}`); continue; }
      const file = path.join(OUT, `shot${sh.id}_${tag}.mp4`);
      fs.writeFileSync(file, Buffer.from(await data.arrayBuffer()));
      const png = path.join(OUT, `shot${sh.id}_${tag}.png`);
      // Middle frame, where captions are usually fully on screen.
      const { code } = await ff(['-y', '-ss', String((sh.duration_sec || 1) / 2), '-i', file,
        '-frames:v', '1', '-vf', 'scale=320:-1', png]);
      console.log(`  ${tag}: ${(fs.statSync(file).size / 1024).toFixed(0)} KB frame=${code === 0 ? png : 'failed'}`);
    }
    // Side-by-side sheet for a quick visual verdict.
    const a = path.join(OUT, `shot${sh.id}_orig.png`);
    const b = path.join(OUT, `shot${sh.id}_clean.png`);
    if (fs.existsSync(a) && fs.existsSync(b)) {
      const cmp = path.join(OUT, `shot${sh.id}_compare.png`);
      await ff(['-y', '-i', a, '-i', b, '-filter_complex', 'hstack', cmp]);
      console.log(`  compare: ${cmp}`);
    }
  }
})();
