const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data } = await sb.from('funnel_crawl_jobs')
    .select('id,created_at,result').order('created_at', { ascending: false }).limit(4);
  for (const j of data) {
    const steps = (j.result || {}).steps || [];
    const s = steps.find((x) => /quiz\?question|step=/.test(x.url || '')) || steps[steps.length - 1];
    if (!s) continue;
    const h = s.html || '';
    console.log('=== job', j.id.slice(0,8), '| step', s.stepIndex, '| len', h.length, '===');
    console.log('  links stylesheet:', (h.match(/<link[^>]+stylesheet[^>]*>/gi) || []).length);
    console.log('  style blocks:', (h.match(/<style[\s\S]*?<\/style>/gi) || []).length);
    console.log('  has </html>:', /<\/html>/i.test(h), '| has </body>:', /<\/body>/i.test(h));
    const headEnd = h.search(/<\/head>/i);
    console.log('  HEAD snippet:\n', h.slice(0, 600).replace(/\s+/g, ' '));
    console.log('');
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
