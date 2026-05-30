const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
(async () => {
  // 1) cloning_jobs: distingui REALI (descrizione lunga) da quelli di TEST (mio)
  console.log('=== CLONING_JOBS (ultimi 10) ===');
  const { data: cj } = await sb.from('cloning_jobs').select('id,status,total_texts,product_description,created_at,completed_at').order('created_at', { ascending: false }).limit(10);
  for (const j of cj) {
    const desc = String(j.product_description || '');
    const isTest = desc.length < 50;
    const age = Math.round((Date.now()-new Date(j.created_at))/60000);
    console.log(`  ${age}m | ${j.status.padEnd(11)} | texts=${j.total_texts} | descLen=${desc.length} ${isTest ? '⚠️TEST(mio)' : 'REALE'} | ${j.id}`);
  }

  // 2) openclaw_messages: path Neo/Morfeo
  console.log('\n=== OPENCLAW_MESSAGES (ultimi 8) ===');
  const { data: om, error } = await sb.from('openclaw_messages').select('*').order('created_at', { ascending: false }).limit(8);
  if (error) { console.log('  ERR:', error.message); return; }
  if (!om || !om.length) { console.log('  (vuoto)'); return; }
  console.log('  COLONNE:', Object.keys(om[0]).join(', '));
  for (const m of om) {
    const age = Math.round((Date.now()-new Date(m.created_at))/60000);
    let resp = '';
    try { const p = JSON.parse(m.response); resp = `success=${p.success} totalTexts=${p.totalTexts} repl=${p.replacements} provider=${p.provider}`; }
    catch { resp = '(response non-JSON: ' + String(m.response||'').slice(0,120) + ')'; }
    console.log(`  --- ${age}m | status=${m.status} | agent=${m.agent} | action=${m.action}`);
    if (m.error_message) console.log('      ERROR_MESSAGE:', String(m.error_message).slice(0, 200));
    console.log('      resp:', resp);
  }
})();
