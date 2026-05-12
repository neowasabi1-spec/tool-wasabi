/**
 * Inspect the 3 failing funnels: list their pages, length, last run
 * status and error.
 */
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co',
  process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
  { auth: { persistSession: false, autoRefreshToken: false } }
);

(async () => {
  const { count: funnelCount, error: cErr } = await supabase
    .from('checkpoint_funnels')
    .select('*', { count: 'exact', head: true });
  console.log(`checkpoint_funnels total rows visible: ${funnelCount} (err: ${cErr?.message || 'none'})`);

  const { data: recentFunnels, error: rfErr } = await supabase
    .from('checkpoint_funnels')
    .select('id, name, url, pages, last_run_status, last_run_at, created_at')
    .order('created_at', { ascending: false })
    .limit(8);
  console.log(`\nLast 8 funnels (err: ${rfErr?.message || 'none'}):`);
  for (const f of recentFunnels || []) {
    console.log(`  • ${f.id.substring(0, 8)}…${f.id.substring(f.id.length - 12)}  [${f.pages?.length || 0} pg]  ${f.name}  → last_run: ${f.last_run_status || '–'}`);
  }

  const { data: recentRuns, error: rrErr } = await supabase
    .from('funnel_checkpoints')
    .select('id, funnel_name, status, error, started_at, completed_at, created_at')
    .order('created_at', { ascending: false })
    .limit(8);
  console.log(`\nLast 8 runs (err: ${rrErr?.message || 'none'}):`);
  for (const r of recentRuns || []) {
    const dur = r.completed_at && r.started_at
      ? `${Math.round((new Date(r.completed_at) - new Date(r.started_at)) / 1000)}s`
      : '–';
    const ago = `${Math.round((Date.now() - new Date(r.created_at)) / 60000)}m ago`;
    console.log(`  • ${ago}  [${r.status}/${dur}]  ${r.funnel_name}`);
    if (r.error) console.log(`      err: ${r.error.substring(0, 200)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
