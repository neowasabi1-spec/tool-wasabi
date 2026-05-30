// Riproduce la fase EXTRACT chiamando DIRETTAMENTE la edge function deployata
// con l'HTML reale (1.6MB) preso da un cloning_job. Misura tempo e mostra errore.
const { createClient } = require('@supabase/supabase-js');
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co', ANON);
const FN = 'https://sktpbizpckxldhxzezws.supabase.co/functions/v1/funnel-swap-v1-functions';
(async () => {
  // prendi un job con original_html non vuoto
  const { data: jobs } = await sb.from('cloning_jobs').select('id,original_html,url,product_name,product_description').order('created_at', { ascending: false }).limit(8);
  const job = jobs.find((j) => j.original_html && String(j.original_html).length > 1000);
  console.log('uso original_html del job', job.id, '| len=', job.original_html.length);

  const body = {
    phase: 'extract',
    url: job.url,
    cloneMode: 'rewrite',
    productName: job.product_name || 'NeuroFlush',
    productDescription: (job.product_description || 'test').slice(0, 4000),
    targetLanguage: 'en',
    userId: '00000000-0000-0000-0000-000000000001',
    renderedHtml: job.original_html,
  };

  const t = Date.now();
  let res, text;
  try {
    res = await fetch(FN, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + ANON, 'apikey': ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) {
    console.log('FETCH ERROR dopo', Date.now() - t, 'ms:', e.message);
    return;
  }
  const ms = Date.now() - t;
  console.log('STATUS', res.status, '| tempo', ms, 'ms | content-type', res.headers.get('content-type'));
  console.log('BODY (primi 800 char):');
  console.log(text.slice(0, 800));
})();
