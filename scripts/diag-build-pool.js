/* Why did the last build use a single shot? Show the latest build jobs and the
 * shot pool they could pick from: how many shots are usable (never had subs, or
 * have an AI-cleaned copy) versus locked out, and how the cleaned ones ended up.
 *   node scripts/diag-build-pool.js [projectId]
 */
const { createClient } = require('@supabase/supabase-js');
const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

(async () => {
  const s = createClient(URL, KEY, { auth: { persistSession: false } });
  const only = process.argv[2];

  const { data: builds } = await s
    .from('video_build_jobs')
    .select('id, project_id, ad_id, status, error, created_at, finished_at')
    .order('created_at', { ascending: false })
    .limit(8);
  console.log('latest video_build_jobs:');
  for (const b of builds || []) {
    console.log(`  #${b.id} ${b.status} proj=${b.project_id} ad=${b.ad_id} ${b.created_at}` +
      (b.error ? ` ERR: ${String(b.error).slice(0, 200)}` : ''));
  }

  const { data: vids } = await s
    .from('generated_videos')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);
  console.log('\nlatest generated_videos:');
  for (const v of vids || []) {
    const scenes = v.scenes || v.scene_data || null;
    console.log(`  #${v.id} proj=${v.project_id} dur=${v.duration_sec ?? '?'} file=${v.file_path}`);
    if (scenes) console.log(`     scenes: ${JSON.stringify(scenes).slice(0, 600)}`);
    console.log(`     columns: ${Object.keys(v).join(', ')}`);
  }

  const proj = only || (builds && builds[0] && builds[0].project_id);
  if (!proj) return;

  let q = s
    .from('competitor_shots')
    .select('id, ad_id, has_text, clean_path, inpaint_status, inpaint_error, text_score, text_region, section, duration_sec, tags, label')
    .eq('project_id', proj)
    .order('id', { ascending: false })
    .limit(400);
  const { data: shots, error } = await q;
  if (error) return console.log('ERROR:', error.message);

  const usable = shots.filter((x) => x.has_text !== true || x.clean_path);
  const locked = shots.filter((x) => x.has_text === true && !x.clean_path);
  const cleaned = shots.filter((x) => x.has_text === true && x.clean_path);
  console.log(`\nproject ${proj}: ${shots.length} shots — usable ${usable.length} ` +
    `(never-subs ${usable.length - cleaned.length}, AI-cleaned ${cleaned.length}), locked ${locked.length}`);

  const byStatus = {};
  for (const x of shots) byStatus[x.inpaint_status || 'none'] = (byStatus[x.inpaint_status || 'none'] || 0) + 1;
  console.log('inpaint_status:', JSON.stringify(byStatus));

  console.log('\nusable shots (what a build can pick):');
  for (const x of usable.slice(0, 40)) {
    console.log(`  #${x.id} ad=${x.ad_id} ${x.duration_sec}s section=${x.section} ` +
      `${x.clean_path ? 'CLEANED' : 'native-clean'} score=${x.text_score} region=${x.text_region} ` +
      `label=${JSON.stringify(x.label)} tags=${JSON.stringify(x.tags)}`);
  }
  const errs = shots.filter((x) => x.inpaint_status === 'error' || x.inpaint_error);
  if (errs.length) {
    console.log('\nshots with inpaint problems:');
    for (const x of errs.slice(0, 20)) {
      console.log(`  #${x.id} ${x.inpaint_status} ${String(x.inpaint_error).slice(0, 200)}`);
    }
  }
})();
