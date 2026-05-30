const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI'
);
(async () => {
  const { data, error } = await sb
    .from('openclaw_messages')
    .select('id,status,created_at,completed_at,error_message,user_message,response')
    .order('created_at', { ascending: false })
    .limit(4);
  if (error) { console.error(error); process.exit(1); }
  for (const j of data) {
    console.log('==================================================');
    console.log(j.id.slice(0,8), '|', j.status, '| err:', j.error_message || '-');
    // parse user_message (the enqueued payload) to find product name / action
    let um = j.user_message;
    try { if (typeof um === 'string') um = JSON.parse(um); } catch {}
    if (um && typeof um === 'object') {
      const prod = um.product || um.productPayload || {};
      console.log('  action     :', um.action);
      console.log('  sourceUrl  :', um.sourceUrl);
      console.log('  product.name:', prod.name || prod.productName || um.productName);
      const brief = um.brief || prod.brief; 
      console.log('  brief len  :', brief ? String(brief).length : 0);
    } else {
      console.log('  user_message (raw head):', String(j.user_message||'').slice(0,300));
    }
    // parse response
    let r = j.response; try { if (typeof r === 'string') r = JSON.parse(r); } catch {}
    if (r && typeof r === 'object') {
      console.log('  replacements:', r.replacements, '| totalTexts:', r.totalTexts, '| provider:', r.provider);
      const cm = r.changes_made;
      if (Array.isArray(cm) && cm.length) {
        console.log('  --- changes_made (first 8) ---');
        cm.slice(0,8).forEach((c,i) => {
          const from = (c.original||c.from||c[0]||'').toString().slice(0,80);
          const to = (c.rewritten||c.to||c[1]||'').toString().slice(0,80);
          console.log(`   [${i}] "${from}"  =>  "${to}"`);
        });
      } else {
        console.log('  changes_made: empty/none');
      }
    }
  }
})();
