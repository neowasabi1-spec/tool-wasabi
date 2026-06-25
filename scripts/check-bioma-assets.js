const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data } = await sb.from('funnel_crawl_jobs')
    .select('id,result').order('created_at', { ascending: false }).limit(10);
  // find a quiz step with stylesheet links
  let step = null, origin = 'https://bioma.health';
  for (const j of data) {
    for (const s of ((j.result || {}).steps || [])) {
      if (/quiz\?question|step=/.test(s.url || '') && /<link[^>]+stylesheet/i.test(s.html || '')) {
        step = s; try { origin = new URL(s.url).origin; } catch {} break;
      }
    }
    if (step) break;
  }
  if (!step) { console.log('no quiz step found'); return; }
  const h = step.html;
  const hrefs = [];
  const re = /<link[^>]+href="([^"]+)"[^>]*stylesheet|<link[^>]+stylesheet[^>]*href="([^"]+)"/gi;
  let m; while ((m = re.exec(h))) hrefs.push(m[1] || m[2]);
  // also JS chunks
  const jsRe = /<script[^>]+src="([^"]+_next\/static[^"]+\.js)"/gi;
  const js = []; while ((m = jsRe.exec(h))) js.push(m[1]);
  const all = [...hrefs, ...js.slice(0, 3)].map((u) => (u.startsWith('http') ? u : origin + (u.startsWith('/') ? '' : '/') + u));
  console.log('step url:', step.url);
  for (const u of all) {
    try {
      const r = await fetch(u, { method: 'GET' });
      console.log(r.status, u.slice(0, 90));
    } catch (e) { console.log('ERR', u.slice(0, 90), e.message); }
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
