/* Ask production to clean a shot with a mask-driven remover and bring the result
 * back for a look. The Replicate key only exists on Netlify, so the deployed
 * background function does the work and drops its output plus a diagnostics
 * sidecar in <project>/shots-compare/; this polls for those, then stacks
 * original / current cleanup / new attempt on the frame with the most caption.
 *
 *   node scripts/run-remover-compare.js <shotId> [model]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

// The deploy that actually holds the provider keys — same origin the browser
// extension talks to. A same-repo twin site exists without those keys, and
// pointing here by accident makes every run exit before it does any work.
const SITE = process.env.SITE_URL || 'https://cute-cupcake-74bad8.netlify.app';
const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const BUCKET = 'project-files';
const FFMPEG = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const OUT = 'C:/Users/Neo/tmp-compare';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (!shotId) return console.log('usage: node scripts/run-remover-compare.js <shotId> [model]');

  const s = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data: shot } = await s
    .from('competitor_shots')
    .select('id, project_id, file_path, clean_path, duration_sec, text_region')
    .eq('id', shotId)
    .maybeSingle();
  if (!shot) return console.log(`shot #${shotId} not found`);

  const base = `${shot.project_id}/shots-compare/${shotId}_${model.split('/')[1]}`;
  // Clear a previous attempt so polling can't pick up a stale file.
  await s.storage.from(BUCKET).remove([`${base}.mp4`, `${base}.json`]);

  const resp = await fetch(`${SITE}/.netlify/functions/inpaint-shot-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shotId, projectId: shot.project_id, compareModel: model }),
  });
  console.log(`triggered ${model} on shot #${shotId} (${resp.status})`);

  const jsonFile = path.join(OUT, `shot${shotId}_report.json`);
  let report = null;
  for (let i = 0; i < 90; i++) {
    await sleep(10000);
    if (await get(s, `${base}.json`, jsonFile)) {
      report = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      break;
    }
    if (i % 3 === 2) console.log(`  waiting… ${(i + 1) * 10}s`);
  }
  if (!report) return console.log('no report appeared — check the Netlify function logs');
  console.log(JSON.stringify(report, null, 2));
  if (report.error) return;

  const files = { orig: shot.file_path, ai: shot.clean_path, new: `${base}.mp4` };
  const local = {};
  for (const [tag, key] of Object.entries(files)) {
    if (!key) continue;
    const f = path.join(OUT, `shot${shotId}_${tag}.mp4`);
    if (await get(s, key, f)) local[tag] = f;
  }

  // Same instant in all three, cropped to the caption band and zoomed.
  const at = (shot.duration_sec || 1.4) * 0.6;
  const pngs = [];
  for (const tag of ['orig', 'ai', 'new']) {
    if (!local[tag]) continue;
    const png = path.join(OUT, `shot${shotId}_${tag}.png`);
    await ff(['-y', '-ss', String(at), '-i', local[tag], '-frames:v', '1',
      '-vf', 'crop=iw:ih*0.34:0:ih*0.36,scale=460:-1', png]);
    if (fs.existsSync(png)) pngs.push(png);
  }
  if (pngs.length > 1) {
    const sheet = path.join(OUT, `shot${shotId}_compare.png`);
    await ff(['-y', ...pngs.flatMap((p) => ['-i', p]), '-filter_complex', `vstack=inputs=${pngs.length}`, sheet]);
    console.log(`sheet (${['orig', 'ai', 'new'].filter((t) => local[t]).join(' / ')}): ${sheet}`);
  }
  console.log(`videos: ${Object.values(local).join('  ')}`);
})();
