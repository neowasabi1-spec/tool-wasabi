const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data } = await sb.from('funnel_crawl_jobs')
    .select('id,created_at,result').order('created_at', { ascending: false }).limit(10);
  let step = null, jid = null;
  for (const j of data) {
    for (const s of ((j.result || {}).steps || [])) {
      if (/quiz|step=|question/.test(s.url || '') && (s.html || '').length > 8000) { step = s; jid = j.id; break; }
    }
    if (step) break;
  }
  if (!step) { console.log('no step'); return; }
  const h = step.html;
  const styles = (h.match(/<style[\s\S]*?<\/style>/gi) || []);
  const allCss = styles.join('\n');
  console.log('job', jid.slice(0,8), 'step', step.stepIndex, '| htmlLen', h.length);
  console.log('style blocks:', styles.length, '| total CSS chars:', allCss.length);
  console.log('external <link stylesheet>:', (h.match(/<link[^>]+stylesheet/gi)||[]).length);
  // Does the CSS contain layout / theme rules?
  const checks = {
    'background-color': /background-color/i.test(allCss),
    'border-radius': /border-radius/i.test(allCss),
    'display:flex': /display:\s*flex/i.test(allCss),
    'grid': /display:\s*grid/i.test(allCss),
    'rgb/hex colors': /#[0-9a-f]{6}|rgb\(/i.test(allCss),
    'class .card/option/answer': /\.(card|option|answer|choice)/i.test(allCss),
    'emotion (css-)': /css-[a-z0-9]{6,}/i.test(h),
    'tailwind utility (bg-/flex)': /\b(bg-|flex|grid|rounded-)/.test(h),
  };
  for (const [k,v] of Object.entries(checks)) console.log('  ', v ? 'YES' : 'no ', k);
  // Sample of a body element classes
  const bodyMatch = h.match(/<body[^>]*>/i);
  console.log('body tag:', bodyMatch ? bodyMatch[0].slice(0,200) : 'n/a');
  // first option-ish element
  const opt = h.match(/<div[^>]*class="[^"]*"[^>]*>\s*(Losing weight|Weight loss|Every day|What are your goals)/i);
  console.log('option sample:', opt ? opt[0].slice(0,160) : 'n/a');
})().catch((e) => { console.error(e.message); process.exit(1); });
