const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
(async () => {
  const { data } = await sb.from('openclaw_messages')
    .select('id,response,created_at')
    .eq('target_agent','openclaw:morfeo').eq('status','completed')
    .order('created_at',{ascending:false}).limit(1);
  const j = JSON.parse(data[0].response);
  const html = j.html || '';
  console.log('job', String(data[0].id).slice(0,8), '| htmlLen', html.length, '| replacements', j.replacements, '| unresolved', (j.unresolved_text_ids||[]).length);
  for (const phrase of ['burning feet','aching shoulders','stabbing back pain','tingling hands','hidden root cause','microplastics','brain fog']) {
    const n = (html.toLowerCase().split(phrase.toLowerCase()).length - 1);
    console.log(`  "${phrase}": ${n} volte nell'HTML finale`);
  }
  // changes_made: vediamo se una rewrite ha toccato la frase
  const cm = j.changes_made || [];
  console.log('\nchanges_made totali:', cm.length);
  const hit = cm.filter(c => JSON.stringify(c).toLowerCase().includes('burning feet') || JSON.stringify(c).toLowerCase().includes('root cause'));
  console.log('changes che menzionano burning feet/root cause:', hit.length);
  for (const h of hit.slice(0,3)) console.log('  ', JSON.stringify(h).slice(0,300));
})();
