const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI'
);
const PID = '8dc8b6b3-9317-4c0e-acfd-7570e9838402';
(async () => {
  const { data } = await sb.from('competitor_shots')
    .select('id, ad_id, duration_sec, text_region, clean_path, inpaint_error')
    .eq('project_id', PID);
  const byAd = {};
  for (const s of data||[]) { (byAd[s.ad_id]=byAd[s.ad_id]||[]).push(s); }
  // find ads that have both cleaned and rejected
  const mixed = Object.entries(byAd).filter(([,arr]) =>
    arr.some(s=>s.clean_path) && arr.some(s=>!s.clean_path && /caption still readable/i.test(s.inpaint_error||'')));
  console.log(`ads with mixed outcome: ${mixed.length}`);
  for (const [ad, arr] of mixed.slice(0,3)) {
    console.log(`\n=== ad ${ad} (${arr.length} shots) ===`);
    for (const s of arr.sort((a,b)=>a.id-b.id)) {
      const st = s.clean_path ? 'CLEAN' : (/caption still readable/i.test(s.inpaint_error||'') ? 'REJECT' : 'other');
      const m = (s.inpaint_error||'').match(/(\d+)\/(\d+) frames/);
      console.log(`  #${s.id} ${st.padEnd(6)} dur=${s.duration_sec}s region="${s.text_region}" ${m?`(${m[1]}/${m[2]})`:''}`);
    }
  }
})();
