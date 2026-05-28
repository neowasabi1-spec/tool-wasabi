// Dump head + tail + length of market_research for a project, to see if
// the 187k char blob contains multiple file headers or just one big file.
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const id = process.argv[2] || '03c19293';
  const { data, error } = await sb
    .from('projects')
    .select('id, name, market_research')
    .ilike('name', '%NeuroFlush%');
  if (error) { console.error(error); process.exit(1); }
  const row = (data || [])[0];
  if (!row) { console.log('not found'); return; }
  const mr = row.market_research;
  console.log('project :', row.name, row.id);
  console.log('type    :', typeof mr);
  if (typeof mr === 'string') {
    console.log('length  :', mr.length);
    const headers = [...mr.matchAll(/^===\s*FILE:.*$/gm)].map((m, i) => `  [${i+1}] @${m.index}  ${m[0]}`);
    console.log('FILE headers found:', headers.length);
    console.log(headers.slice(0, 20).join('\n'));
    console.log('--- HEAD 400 ---');
    console.log(mr.slice(0, 400));
    console.log('--- TAIL 400 ---');
    console.log(mr.slice(-400));
  } else if (typeof mr === 'object') {
    console.log('object keys:', Object.keys(mr || {}));
    const c = mr?.content || '';
    console.log('content length:', c.length);
    const headers = [...c.matchAll(/^===\s*FILE:.*$/gm)].map((m, i) => `  [${i+1}] @${m.index}  ${m[0]}`);
    console.log('FILE headers found:', headers.length);
    console.log(headers.slice(0, 20).join('\n'));
  }
})();
