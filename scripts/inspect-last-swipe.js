const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
function age(iso){ if(!iso) return '?'; const ms=Date.now()-new Date(iso).getTime(); if(ms<60000) return Math.round(ms/1000)+'s'; if(ms<3600000) return Math.round(ms/60000)+'m'; return (ms/3600000).toFixed(1)+'h'; }
(async () => {
  const { data } = await sb.from('openclaw_messages')
    .select('id,status,target_agent,created_at,completed_at,error_message,user_message,response')
    .in('target_agent',['openclaw:neo','openclaw:morfeo'])
    .order('created_at',{ascending:false}).limit(6);
  for (const m of data||[]) {
    const um = String(m.user_message||'');
    const src = (um.match(/sourceUrl"\s*:\s*"([^"]+)/)||[])[1] || '?';
    const briefLen = (um.match(/"brief"\s*:\s*"((?:[^"\\]|\\.)*)"/)||[])[1]?.length || 0;
    const hasHtml = /"html"\s*:/.test(um);
    const resp = String(m.response||'');
    let respInfo = '(vuota)';
    if (resp) {
      try { const j = JSON.parse(resp); respInfo = `JSON keys=[${Object.keys(j).join(',')}] replacements=${j.replacements ?? j.totalReplacements ?? '?'} htmlLen=${(j.html||j.finalHtml||'').length}`; }
      catch { respInfo = `len=${resp.length} head="${resp.slice(0,80).replace(/\s+/g,' ')}"`; }
    }
    const dur = m.completed_at ? Math.round((new Date(m.completed_at)-new Date(m.created_at))/1000)+'s' : '-';
    console.log(`\n[${m.status}] ${String(m.id).slice(0,8)} ${m.target_agent} | creato ${age(m.created_at)} fa | dur ${dur}`);
    console.log('  src:', src.slice(0,60), '| msgBriefLen~', briefLen, '| html inviato:', hasHtml);
    if (m.error_message) console.log('  ERR:', String(m.error_message).slice(0,150));
    console.log('  response:', respInfo);
  }
})();
