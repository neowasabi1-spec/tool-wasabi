// Repairs the damage from the (now reverted) CSS-inline change: any
// funnel_crawl_jobs step whose HTML had its external <link rel=stylesheet>
// replaced by an inline <style data-inlined-from="URL"> is converted BACK
// to the original <link>, so the steps render exactly as before the change.
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co',
  process.env.SUPABASE_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);

const INLINED_RE = /<style\s+data-inlined-from="([^"]+)"[^>]*>[\s\S]*?<\/style>/gi;

function deinline(html) {
  if (!html || !/data-inlined-from/.test(html)) return { html, changed: 0 };
  let changed = 0;
  const out = html.replace(INLINED_RE, (_m, href) => {
    changed++;
    return `<link rel="stylesheet" href="${href}">`;
  });
  return { html: out, changed };
}

(async () => {
  // Pull recent jobs (the inline change only ran today).
  const { data, error } = await sb
    .from('funnel_crawl_jobs')
    .select('id,result')
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) { console.error(error.message); process.exit(1); }

  let jobsFixed = 0, stepsFixed = 0;
  for (const j of data) {
    const result = j.result;
    if (!result || !Array.isArray(result.steps)) continue;
    let touched = false;
    for (const s of result.steps) {
      const { html, changed } = deinline(s.html || '');
      if (changed > 0) { s.html = html; s.htmlLength = html.length; stepsFixed += changed; touched = true; }
    }
    if (!touched) continue;
    const { error: upErr } = await sb
      .from('funnel_crawl_jobs')
      .update({ result })
      .eq('id', j.id);
    if (upErr) { console.error('  update failed', j.id, upErr.message); continue; }
    jobsFixed++;
    console.log('fixed job', j.id);
  }
  console.log(`\nDONE: ${jobsFixed} job ripristinati, ${stepsFixed} <style> riconvertiti in <link>.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
