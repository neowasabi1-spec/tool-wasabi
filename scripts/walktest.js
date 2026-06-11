// Enqueue an isolated quiz-walk job (target openclaw:walktest) and poll
// until it completes, printing captured steps + stop reason.
// Run: node scripts/walktest.js [url] [maxSteps]
const { createClient } = require('@supabase/supabase-js');
const URL_ = 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const sb = createClient(URL_, KEY);

const entryUrl = process.argv[2] || 'https://bioma.health/weight-loss';
const maxSteps = Number(process.argv[3] || 25);

(async () => {
  const params = {
    entryUrl, headless: true, maxSteps, quizMaxSteps: maxSteps, quizMode: true,
    captureHtml: true, source: 'quiz-swipe', captureScreenshots: false,
    viewportWidth: 1280, viewportHeight: 800,
  };
  const { data, error } = await sb.from('funnel_crawl_jobs')
    .insert({ status: 'pending', entry_url: entryUrl, params, current_step: 0, total_steps: 0, target_agent: 'openclaw:walktest' })
    .select('id').single();
  if (error) { console.error('insert error:', error.message); process.exit(1); }
  const id = data.id;
  console.log('enqueued job', id, 'target=openclaw:walktest url=', entryUrl, 'maxSteps=', maxSteps);

  const deadline = Date.now() + 4 * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data: j } = await sb.from('funnel_crawl_jobs').select('*').eq('id', id).maybeSingle();
    if (!j) continue;
    const res = j.result || {};
    const tag = `${j.status} cur=${j.current_step} total=${j.total_steps}`;
    if (tag !== last) { console.log('  ', tag); last = tag; }
    if (j.status === 'completed' || j.status === 'failed') {
      const diag = res.stopDiagnostic || {};
      console.log('\n=== DONE ===');
      console.log('status:', j.status, '| captured steps:', (res.steps || []).length, '| stop:', diag.reason || '-', j.error ? '| ERR ' + j.error : '');
      for (const s of res.steps || []) console.log(`  step ${s.stepIndex}: ${(s.url || '').slice(0, 70)} "${(s.title || '').slice(0, 30)}"`);
      process.exit(0);
    }
  }
  console.log('timeout waiting for worker — is it running with OPENCLAW_AGENT=openclaw:walktest?');
  process.exit(2);
})().catch((e) => { console.error('fatal', e.message); process.exit(1); });
