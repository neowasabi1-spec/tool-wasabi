/* Quick diagnostic for the video shot pipeline.
 * Prints the latest video_segment_jobs (with ids needed to trigger the
 * background function) + shot counts.
 *   node scripts/inspect-shot-jobs.js
 */
const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

(async () => {
  const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

  const { data: jobs, error } = await supabase
    .from('video_segment_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    console.log('ERROR reading video_segment_jobs:', error.message);
    process.exit(0);
  }

  console.log(`\nvideo_segment_jobs (latest ${jobs.length}):`);
  for (const j of jobs) {
    console.log(
      `  #${j.id} status=${j.status} project=${j.project_id} brand=${j.brand_id} ad=${j.ad_id} shots=${j.shots_count}` +
        (j.error ? `\n     error: ${j.error}` : ''),
    );
  }

  const { count } = await supabase
    .from('competitor_shots')
    .select('id', { count: 'exact', head: true });
  console.log(`\ncompetitor_shots total: ${count ?? 'n/a'}`);
})();
