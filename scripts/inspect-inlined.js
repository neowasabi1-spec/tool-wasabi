const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data } = await sb
    .from('funnel_crawl_jobs')
    .select('id,result')
    .order('created_at', { ascending: false })
    .limit(2);
  const j = data.find((x) => ((x.result || {}).steps || []).length > 10) || data[0];
  const steps = (j.result || {}).steps || [];
  const s = steps[2] || steps[1] || steps[0];
  const h = s.html || '';
  fs.writeFileSync('.tmp-inlined-step.html', h);
  const styleLen = (h.match(/<style[\s\S]*?<\/style>/gi) || []).join('').length;
  console.log('job', j.id, 'step', s.stepIndex, s.url);
  console.log(
    'html', Math.round(h.length / 1024) + 'KB',
    '| total <style> content', Math.round(styleLen / 1024) + 'KB',
    '| inlined', (h.match(/data-inlined-from/g) || []).length,
    '| ext links', (h.match(/<link[^>]+stylesheet/gi) || []).length,
  );
  console.log('has flex/grid/padding rules:', /display\s*:\s*flex|display\s*:\s*grid|padding\s*:/.test(h));
  console.log('base tag:', (h.match(/<base[^>]*>/i) || ['(none)'])[0]);
  console.log('wrote .tmp-inlined-step.html');
})().catch((e) => { console.error(e.message); process.exit(1); });
