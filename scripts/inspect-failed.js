// Inspect failed (0-replacement) swipe jobs: show totalTexts vs replacements
// to determine whether extraction (worker code) or the LLM call failed.
const { createClient } = require('@supabase/supabase-js');
const URL = 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const sb = createClient(URL, KEY);

(async () => {
  const { data, error } = await sb
    .from('openclaw_messages')
    .select('id,status,created_at,completed_at,error_message,response,target_agent')
    .order('created_at', { ascending: false })
    .limit(6);
  if (error) { console.error(error); process.exit(1); }
  for (const j of data) {
    let r = j.response;
    try { if (typeof r === 'string') r = JSON.parse(r); } catch {}
    const age = Math.round((Date.now() - new Date(j.created_at).getTime()) / 1000);
    const dur = j.completed_at ? Math.round((new Date(j.completed_at).getTime() - new Date(j.created_at).getTime())/1000)+'s' : '-';
    console.log('----------------------------------------');
    console.log(`${j.id.slice(0,8)} | ${j.status} | ${age}s fa | dur ${dur} | target=${j.target_agent || '(null)'}`);
    if (j.error_message) console.log('  job.error:', String(j.error_message).slice(0, 300));
    if (r && typeof r === 'object') {
      console.log('  totalTexts          :', r.totalTexts);
      console.log('  replacements        :', r.replacements);
      console.log('  replacements_dom    :', r.replacements_dom);
      console.log('  coverage_ratio      :', r.coverage_ratio);
      console.log('  provider            :', r.provider);
      console.log('  method_used         :', r.method_used);
      console.log('  changes_made        :', r.changes_made);
      console.log('  unresolved (#)      :', Array.isArray(r.unresolved_text_ids) ? r.unresolved_text_ids.length : r.unresolved_text_ids);
      if (r.error) console.log('  response.error      :', String(r.error).slice(0,300));
      if (r.llm_error || r.last_error) console.log('  llm_error           :', String(r.llm_error || r.last_error).slice(0,300));
    } else {
      console.log('  (response non-JSON):', String(r).slice(0, 200));
    }
  }
})();
