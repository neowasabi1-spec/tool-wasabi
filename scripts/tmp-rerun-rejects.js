const { createClient } = require('@supabase/supabase-js');
const BASE = 'https://cute-cupcake-74bad8.netlify.app';
const FN = `${BASE}/.netlify/functions/inpaint-shot-background`;
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI'
);
const PID = '8dc8b6b3-9317-4c0e-acfd-7570e9838402';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

(async () => {
  const { data } = await sb.from('competitor_shots')
    .select('id, clean_path, inpaint_error')
    .eq('project_id', PID);
  const ids = (data||[])
    .filter((s) => !s.clean_path && /caption still readable|retriable|timed out|stalled/i.test(s.inpaint_error||''))
    .map((s) => s.id);
  console.log(`${stamp()} rejects + retriable to re-run with per-window verify: ${ids.length}`);
  if (!ids.length) return;

  for (let i = 0; i < ids.length; i += 50) {
    await sb.from('competitor_shots')
      .update({ inpaint_status: 'pending', inpaint_error: null })
      .in('id', ids.slice(i, i + 50));
  }

  const WAVE = 4;
  for (let i = 0; i < ids.length; i += WAVE) {
    const w = ids.slice(i, i + WAVE);
    for (const id of w) {
      await sb.from('competitor_shots').update({ inpaint_status: 'pending', inpaint_error: null }).eq('id', id);
      await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotId: id, projectId: PID }) }).catch(() => {});
      await sleep(800);
    }
    console.log(`${stamp()} fired ${Math.min(i + WAVE, ids.length)}/${ids.length}`);
    await sleep(12000);
  }
  console.log(`${stamp()} all fired — polling`);
  for (let i = 0; i < 150; i++) {
    await sleep(30000);
    const { data: d } = await sb.from('competitor_shots')
      .select('id, inpaint_status, clean_path').in('id', ids);
    const c = { cleaned: 0, processing: 0, pending: 0, error: 0, rejected: 0 };
    for (const s of d || []) {
      if (s.clean_path) c.cleaned++;
      else if (s.inpaint_status === 'processing') c.processing++;
      else if (s.inpaint_status === 'pending') c.pending++;
      else if (s.inpaint_status === 'error') c.error++;
      else c.rejected++;
    }
    console.log(`${stamp()} ${JSON.stringify(c)}`);
    if (!c.processing && !c.pending) { console.log(`RERUN COMPLETE — recovered ${c.cleaned}/${ids.length}`); return; }
  }
  console.log('RERUN POLL TIMEOUT');
})();
