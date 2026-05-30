// scripts/inspect-job-input.js
// Dumpa l'INPUT (user_message) del job piu' recente: cosa e' stato passato
// al worker? prodotto, brief, market_research, knowledge, prompts, tone, lang.
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);

function show(label, v) {
  if (v == null) { console.log('  ' + label + ': <ASSENTE>'); return; }
  if (typeof v === 'string') {
    console.log('  ' + label + ': [string ' + v.length + ' char] ' + JSON.stringify(v.slice(0, 200)) + (v.length > 200 ? '…' : ''));
  } else if (Array.isArray(v)) {
    console.log('  ' + label + ': [array ' + v.length + ']');
  } else if (typeof v === 'object') {
    console.log('  ' + label + ': [object keys: ' + Object.keys(v).join(',') + ']');
  } else {
    console.log('  ' + label + ': ' + v);
  }
}

(async () => {
  const { data: rows } = await sb
    .from('openclaw_messages')
    .select('id, status, target_agent, created_at, user_message')
    .order('created_at', { ascending: false })
    .limit(5);
  const row = (rows || [])[0];
  if (!row) { console.log('nessun job'); return; }
  console.log('JOB:', row.id, '| agent:', row.target_agent, '| status:', row.status);

  let um = row.user_message;
  let parsed = null;
  try { parsed = typeof um === 'string' ? JSON.parse(um) : um; } catch { parsed = null; }
  if (!parsed) { console.log('user_message non JSON. Head:\n', String(um).slice(0, 1000)); return; }

  console.log('\n--- CHIAVI user_message ---');
  console.log(' ', Object.keys(parsed).join(', '));

  // payload spesso annidato in parsed.payload o parsed.data
  const p = parsed.payload || parsed.data || parsed;
  console.log('\n--- CAMPI CHIAVE ---');
  show('action', p.action);
  show('sourceUrl', p.sourceUrl);
  show('tone', p.tone);
  show('language', p.language);
  show('html', p.html);
  show('product', p.product);
  if (p.product && typeof p.product === 'object') {
    show('  product.name', p.product.name);
    show('  product.brand_name', p.product.brand_name);
    show('  product.description', p.product.description);
    show('  product.characteristics', p.product.characteristics);
    show('  product.marketing_brief', p.product.marketing_brief);
    show('  product.market_research', p.product.market_research);
  }
  show('knowledge', p.knowledge);
  if (p.knowledge && typeof p.knowledge === 'object') {
    show('  knowledge.project', p.knowledge.project);
    if (p.knowledge.project) {
      show('    project.name', p.knowledge.project.name);
      show('    project.brief', p.knowledge.project.brief);
      show('    project.market_research', p.knowledge.project.market_research);
      show('    project.notes', p.knowledge.project.notes);
    }
    show('  knowledge.prompts', p.knowledge.prompts);
    if (Array.isArray(p.knowledge.prompts)) {
      p.knowledge.prompts.slice(0, 8).forEach((pr, i) =>
        console.log('      prompt[' + i + ']: ' + JSON.stringify(String(pr.title || '').slice(0, 60)) + ' (' + String(pr.content || '').length + ' char, cat=' + pr.category + ', fav=' + pr.is_favorite + ')'));
    }
  }
})();
