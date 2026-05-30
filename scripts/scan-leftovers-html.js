// Scansiona il final_html dell'ultimo job per FRAMMENTI di testo (tra > e <)
// che contengono termini del competitor → cioè nodi non riscritti.
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
const COMP = ['burning feet', 'aching shoulder', 'back pain', 'tingling', 'neuropath', 'sciatic', 'nerve', 'magnesium', 'muscle', 'joint', 'cramp', 'feet', 'foot', 'arthrit', 'inflammation in your', 'starving', 'numbness', 'pins and needles', 'circulation'];
(async () => {
  const { data: jobs } = await sb.from('cloning_jobs').select('id,final_html,status,created_at').order('created_at', { ascending: false }).limit(8);
  const job = jobs.find((j) => j.final_html && String(j.final_html).length > 1000);
  if (!job) { console.log('nessun job con final_html'); return; }
  const html = String(job.final_html || '');
  const ageM = Math.round((Date.now() - new Date(job.created_at).getTime()) / 60000);
  console.log('JOB', job.id, '|', job.status, '|', ageM + 'm fa | final_html len=', html.length, '\n');
  // estrai tutti i frammenti di testo tra > e < (come fa l'estrattore)
  const re = />([^<>{}]{4,400})</g;
  let m, frags = [];
  while ((m = re.exec(html)) !== null) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (t.length < 4) continue;
    if (!/[a-zA-Z]{3,}/.test(t)) continue;
    frags.push({ t, idx: m.index });
  }
  console.log('frammenti di testo totali nel final_html:', frags.length);
  const seen = new Set();
  const hits = [];
  for (const f of frags) {
    const low = f.t.toLowerCase();
    const found = COMP.filter((w) => low.includes(w));
    if (found.length && !seen.has(f.t)) {
      seen.add(f.t);
      hits.push({ ...f, found });
    }
  }
  console.log('\nFRAMMENTI con termini COMPETITOR rimasti:', hits.length);
  for (const h of hits) {
    console.log('---', '[' + h.found.join(',') + ']');
    console.log('   ', h.t.slice(0, 260));
  }
})();
