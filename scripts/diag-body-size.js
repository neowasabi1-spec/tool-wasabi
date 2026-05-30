const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  await sb.from('openclaw_messages').delete().eq('section', 'diag_test');
  const { data, error } = await sb
    .from('openclaw_messages')
    .select('id,created_at,section,user_message')
    .eq('section', 'swipe_job')
    .order('created_at', { ascending: false })
    .limit(4);
  if (error) console.log('ERROR:', error.message);
  console.log('swipe_job rows:', (data || []).length);
  for (const r of data || []) {
    const um = r.user_message || '';
    let html = 0, brief = 0, mr = 0, promptsN = 0;
    try {
      const p = JSON.parse(um);
      html = (p.html || '').length;
      const proj = (p.knowledge && p.knowledge.project) || {};
      brief = (proj.brief || '').length;
      mr = typeof proj.market_research === 'string' ? proj.market_research.length
        : proj.market_research ? JSON.stringify(proj.market_research).length : 0;
      promptsN = (p.knowledge && Array.isArray(p.knowledge.prompts)) ? p.knowledge.prompts.length : 0;
    } catch (e) { /* ignore */ }
    const mb = (um.length / 1048576).toFixed(2);
    console.log(`${r.id.slice(0,8)} user_message=${um.length} (${mb}MB) | html=${html} brief=${brief} mr=${mr} prompts=${promptsN}`);
  }
})();
