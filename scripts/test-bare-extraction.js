const { createClient } = require('@supabase/supabase-js');
const { extractAllTextsUniversal } = require('../worker-lib/text-extractor');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
(async () => {
  // HTML reale (struttura gethirelief col nodo "burning feet")
  const { data } = await sb.from('cloning_jobs').select('original_html,url').eq('id','ea69a84e-a31f-4b6c-8402-8a5ead9bdf60').limit(1);
  let html = data && data[0] && data[0].original_html;
  if (!html) {
    const { data: m } = await sb.from('openclaw_messages').select('response').eq('target_agent','openclaw:morfeo').eq('status','completed').order('created_at',{ascending:false}).limit(1);
    html = JSON.parse(m[0].response).html;
    console.log('(uso html finale del job morfeo)');
  }
  console.log('htmlLen', html.length);
  const t = Date.now();
  const texts = extractAllTextsUniversal(html);
  console.log('estratti', texts.length, 'testi in', Date.now()-t+'ms');

  const bare = texts.filter(x => x.context === 'bare');
  console.log('di cui bare:', bare.length);

  const hit = texts.find(x => /burning feet/i.test(x.text));
  console.log('\n"burning feet" estratto?', hit ? `SI [${hit.context}] -> "${hit.text.slice(0,120)}"` : 'NO');

  // controllo garbage: bare texts che sembrano codice
  const suspect = bare.filter(x => /[{}();=]|function|var |=>|window\.|document\./.test(x.text)).slice(0,5);
  console.log('\nbare sospetti (codice/garbage):', suspect.length);
  for (const s of suspect) console.log('  ⚠', s.text.slice(0,80));
  console.log('\nesempi bare puliti:');
  for (const b of bare.filter(x=>!suspect.includes(x)).slice(0,6)) console.log('  ·', b.text.slice(0,80));
})();
