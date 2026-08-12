const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI'
);
const PID = '8dc8b6b3-9317-4c0e-acfd-7570e9838402';
const cls = (s) => s.clean_path ? 'CLEAN'
  : /caption still readable/i.test(s.inpaint_error||'') ? 'REJECT'
  : /credit|402|paused/i.test(s.inpaint_error||'') ? 'PAUSED(credit)'
  : s.inpaint_status;
(async () => {
  const { data } = await sb.from('competitor_shots')
    .select('id, ad_id, duration_sec, section, clean_path, inpaint_status, inpaint_error, has_text')
    .eq('project_id', PID);
  console.log(`rows returned: ${(data||[]).length}`);
  const byAd = {};
  for (const s of data||[]) (byAd[s.ad_id] ||= []).push(s);
  // find ads with BOTH a clean and a reject (mixed outcome)
  const mixed = Object.entries(byAd).filter(([,arr]) => {
    const k = new Set(arr.map(cls));
    return k.has('CLEAN') && (k.has('REJECT') || k.has('PAUSED(credit)'));
  });
  console.log(`ads total: ${Object.keys(byAd).length}; mixed-outcome ads: ${mixed.length}\n`);
  for (const [ad, arr] of Object.entries(byAd)) {
    const cnt = {};
    for (const s of arr) cnt[cls(s)] = (cnt[cls(s)]||0)+1;
    const durs = arr.map(s=>s.duration_sec||0);
    console.log(`AD ${ad}: ${arr.length} shots | ${JSON.stringify(cnt)} | dur ${Math.min(...durs).toFixed(1)}-${Math.max(...durs).toFixed(1)}s`);
  }
  console.log('');
  for (const [ad, arr] of mixed.slice(0, 5)) {
    const withText = arr.filter(s => s.has_text);
    console.log(`AD ${ad} — ${arr.length} shots (${withText.length} has_text)`);
    for (const s of arr.sort((a,b)=>(a.duration_sec||0)-(b.duration_sec||0))) {
      const chunked = (s.duration_sec||0) > 2.7 ? 'CHUNK' : 'single';
      console.log(`  #${s.id}  ${(s.duration_sec||0).toFixed(2)}s  txt=${s.has_text?'Y':'n'} ${chunked.padEnd(6)} ${cls(s).padEnd(14)} ${(s.inpaint_error||'').slice(0,44)}`);
    }
    console.log('');
  }
})();
