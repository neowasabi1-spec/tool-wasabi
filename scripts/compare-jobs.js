const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data, error } = await sb
    .from('funnel_crawl_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(8);
  if (error) { console.error(error.message); process.exit(1); }
  if (data[0]) console.log('COLUMNS:', Object.keys(data[0]).join(', '), '\n');
  for (const j of data) {
    const steps = ((j.result || {}).steps) || [];
    let inl = 0, htmlSteps = 0;
    for (const s of steps) {
      const h = s.html || '';
      if (h) htmlSteps++;
      inl += (h.match(/data-inlined-from/g) || []).length;
    }
    console.log(
      (j.created_at || '').slice(11, 19),
      '| id', (j.id || '').slice(0, 8),
      '| owner', String(j.owner_user_id || j.user_id || j.created_by || '—').slice(0, 8),
      '| target', j.target_agent || 'null',
      '| status', j.status,
      '| steps', steps.length,
      '| htmlSteps', htmlSteps,
      '| inlined', inl,
      '| entry', String(j.entry_url || j.url || (j.params && j.params.url) || '—').slice(0, 50),
    );
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
