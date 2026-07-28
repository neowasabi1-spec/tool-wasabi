/* Pull the latest generated video and lay out a contact sheet of frames, so it
 * is visible how many distinct shots it actually used and where any smeared
 * frames come from.
 *   node scripts/diag-generated-video.js [generatedVideoId]
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
const OUT = 'C:/Users/Neo/tmp-gen-check';

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
  const wanted = process.argv[2] ? Number(process.argv[2]) : null;

  let q = s.from('generated_videos').select('*').order('created_at', { ascending: false }).limit(1);
  if (wanted) q = s.from('generated_videos').select('*').eq('id', wanted);
  const { data } = await q;
  const v = (data || [])[0];
  if (!v) return console.log('no generated video found');
  console.log(`generated #${v.id} ad=${v.ad_id} dur=${v.duration_sec}s voice=${v.voice}`);
  console.log(`script: ${String(v.script || '').slice(0, 600)}`);

  const { data: blob, error } = await s.storage.from(BUCKET).download(v.file_path);
  if (error) return console.log('download failed:', error.message);
  const file = path.join(OUT, `gen${v.id}.mp4`);
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  console.log(`saved ${(fs.statSync(file).size / 1048576).toFixed(1)} MB -> ${file}`);

  // One frame per second, tiled: repeated footage jumps out immediately.
  const sheet = path.join(OUT, `gen${v.id}_sheet.png`);
  const { code, err } = await ff(['-y', '-i', file, '-vf', 'fps=1,scale=160:-1,tile=8x6', '-frames:v', '1', sheet]);
  console.log(code === 0 ? `sheet: ${sheet}` : `sheet failed: ${err.split(/\r?\n/).slice(-3).join(' | ')}`);
})();
