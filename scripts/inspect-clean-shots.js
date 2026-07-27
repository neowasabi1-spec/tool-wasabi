/* Why does Build video say "No clean shots"? Show shot counts (total / clean /
 * with-subs) grouped by project, plus latest segment jobs.
 *   node scripts/inspect-clean-shots.js
 */
const { createClient } = require('@supabase/supabase-js');
const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

(async () => {
  const s = createClient(URL, KEY, { auth: { persistSession: false } });

  const { data: shots, error } = await s
    .from('competitor_shots')
    .select('id, project_id, has_text, section, tags, created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return console.log('ERROR reading competitor_shots:', error.message);

  const byProj = {};
  for (const sh of shots) {
    const p = (byProj[sh.project_id] = byProj[sh.project_id] || { total: 0, clean: 0, subs: 0, nullText: 0 });
    p.total++;
    if (sh.has_text === true) p.subs++;
    else if (sh.has_text === false) p.clean++;
    else p.nullText++;
  }
  console.log(`\ncompetitor_shots (latest ${shots.length}) by project:`);
  for (const [proj, c] of Object.entries(byProj)) {
    console.log(`  ${proj}: total=${c.total} clean(has_text=false)=${c.clean} subs(true)=${c.subs} null=${c.nullText}`);
  }

  console.log('\nsample of latest 8 shots:');
  for (const sh of shots.slice(0, 8)) {
    console.log(`  #${sh.id} proj=${sh.project_id} has_text=${sh.has_text} section=${sh.section} tags=${JSON.stringify(sh.tags)}`);
  }

  const { data: jobs } = await s
    .from('video_segment_jobs')
    .select('id, status, project_id, ad_id, shots_count, error, created_at')
    .order('created_at', { ascending: false })
    .limit(12);
  console.log('\nlatest video_segment_jobs:');
  for (const j of jobs || []) {
    console.log(`  #${j.id} ${j.status} proj=${j.project_id} ad=${j.ad_id} shots=${j.shots_count}` + (j.error ? ` ERR: ${String(j.error).slice(0, 160)}` : ''));
  }
})();
