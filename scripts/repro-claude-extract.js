// Riproduce l'EXTRACT di Claude in produzione, con l'HTML VERO di un job,
// esattamente come fa il frontend (body snello, solo renderedHtml grosso).
const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
const BASE = 'https://cute-cupcake-74bad8.netlify.app';
(async () => {
  // prendi original_html vero da un job recente
  const { data } = await sb.from('cloning_jobs').select('id,original_html,url,product_name').order('created_at',{ascending:false}).limit(5);
  const job = data.find(j => (j.original_html||'').length > 50000) || data[0];
  const html = job.original_html || '';
  console.log('JOB', String(job.id).slice(0,8), '| htmlLen', html.length, '(', (html.length/1024/1024).toFixed(2), 'MB)\n');

  const body = JSON.stringify({
    phase: 'extract',
    url: job.url || 'https://example.com',
    cloneMode: 'rewrite',
    productName: job.product_name || 'Test',
    productDescription: 'desc',
    framework: '', target: '', customPrompt: '',
    targetLanguage: 'en',
    userId: '00000000-0000-0000-0000-000000000001',
    renderedHtml: html,
  });
  console.log('proxy extract bodyKB =', Math.round(body.length/1024), '\n');

  const t = Date.now();
  let res, text;
  try {
    res = await fetch(BASE + '/api/funnel-swap-proxy', { method:'POST', headers:{'Content-Type':'application/json'}, body });
    text = await res.text();
  } catch (e) { console.log('FETCH ERR', Date.now()-t+'ms', e.message); return; }
  const ms = Date.now()-t;
  let j=null; try{ j=JSON.parse(text); }catch{}
  console.log('EXTRACT status=', res.status, ms+'ms');
  if (j) console.log('JSON:', JSON.stringify(j).slice(0,200));
  else console.log('NON-JSON (questo è il bug!):', text.slice(0,200).replace(/\s+/g,' '));
})();
