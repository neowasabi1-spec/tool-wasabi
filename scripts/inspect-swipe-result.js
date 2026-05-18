// scripts/inspect-swipe-result.js
//
// Scarica il response del job swipe_landing_local da Supabase,
// salva l'HTML rewritten su disco, e cerca se i facts del COMPETITOR
// originale sono ancora presenti (= rewrite ha SALTATO quei testi).
//
//   node scripts/inspect-swipe-result.js [messageId]
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

(async () => {
  let messageId = process.argv[2];
  if (!messageId) {
    // Prendi l'ultimo completed swipe_job
    const { data, error } = await supabase
      .from('openclaw_messages')
      .select('id, created_at, completed_at, response, target_agent')
      .eq('section', 'swipe_job')
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1);
    if (error) { console.error('Query error:', error.message); process.exit(1); }
    if (!data || data.length === 0) { console.error('Nessun swipe_job completato.'); process.exit(1); }
    messageId = data[0].id;
    console.log('Ultimo swipe_job completed: ' + messageId);
    console.log('  Completed at: ' + data[0].completed_at);
    console.log('  Target agent: ' + data[0].target_agent);
  }

  const { data, error } = await supabase
    .from('openclaw_messages')
    .select('id, response, created_at, completed_at, user_message')
    .eq('id', messageId)
    .single();
  if (error) { console.error('Query error:', error.message); process.exit(1); }

  let parsed;
  try { parsed = JSON.parse(data.response); }
  catch (e) { console.error('Response non e JSON valido:', e.message); process.exit(1); }

  console.log('\n=== Job ' + data.id.slice(0, 8) + ' ===');
  console.log('  Response keys: ' + Object.keys(parsed).join(', '));
  console.log('  replacements: ' + parsed.replacements);
  console.log('  totalTexts: ' + parsed.totalTexts);
  console.log('  unresolved: ' + (parsed.unresolved_text_ids?.length || 0));
  console.log('  HTML output: ' + (parsed.html?.length || 0) + ' chars');

  // Job request payload (per sapere il product name target)
  let jobInput;
  try { jobInput = JSON.parse(data.user_message); } catch {}
  if (jobInput) {
    console.log('  Source URL: ' + jobInput.sourceUrl);
    console.log('  Product target: ' + (jobInput.product?.name || 'N/A'));
  }

  // Salva HTML su disco
  const tmpDir = process.env.TEMP || '/tmp';
  const outPath = path.join(tmpDir, 'swipe-result-' + messageId.slice(0, 8) + '.html');
  fs.writeFileSync(outPath, parsed.html || '');
  console.log('\nHTML salvato in: ' + outPath);

  if (!parsed.html) { console.error('Nessun HTML nel response!'); process.exit(1); }

  // Cerca facts del COMPETITOR originale che NON devono essere presenti
  console.log('\n=== FACTS COMPETITOR ORIGINALI (dovrebbero essere SOSTITUITI) ===');
  const competitorFacts = [
    'Jeremy Campbell',
    'Dr. Campbell',
    'Chicago',
    '15 minutes',
    '15-Min',
    '15 Minutes',
    '1100 patients',
    '10 years',
    '10,000 hours',
    '4,000 5-star',
    '300,000 men and women',
    '$199.95',
    '$99.95',
    'nooro',
    'Nooro',
    'NMES Foot Massager',
    'Charlotte Hudson',
    'William Boxall',
    'plantar fasciitis',
    'tibialis posterior',
    'overpronation',
  ];
  let stillPresent = 0;
  for (const fact of competitorFacts) {
    const re = new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = (parsed.html.match(re) || []).length;
    if (matches > 0) {
      stillPresent++;
      console.log('  X  ' + fact.padEnd(30) + ' presente ' + matches + ' volte (NON sostituito!)');
    } else {
      console.log('  OK ' + fact.padEnd(30) + ' RIMOSSO');
    }
  }
  console.log('\nTotale facts originali ANCORA presenti: ' + stillPresent + '/' + competitorFacts.length);

  // Cerca facts del NOSTRO prodotto che DOVREBBERO essere stati inseriti
  console.log('\n=== FACTS NOSTRO PRODOTTO (dovrebbero essere PRESENTI) ===');
  const ourFacts = [
    'Alan Reed',
    'Dr. Reed',
    'Dr. Alan',
    'Metabolic Wave',
    '9 minuti',
    '9 minutes',
    '4 minuti',
    '8 ore',
    '90-day',
    '6.8%',
    '24%',
    'audio',
  ];
  let presentOurs = 0;
  for (const fact of ourFacts) {
    const re = new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = (parsed.html.match(re) || []).length;
    if (matches > 0) {
      presentOurs++;
      console.log('  OK ' + fact.padEnd(30) + ' presente ' + matches + ' volte');
    } else {
      console.log('  X  ' + fact.padEnd(30) + ' MANCANTE (non e stato inserito)');
    }
  }
  console.log('\nTotale facts nostri PRESENTI: ' + presentOurs + '/' + ourFacts.length);

  console.log('\n=== CONCLUSIONE ===');
  if (stillPresent > 3) {
    console.log('PROBLEMA: ' + stillPresent + ' facts del competitor sono ancora nella pagina.');
    console.log('Il rewrite NON ha sostituito i fatti chiave → l\'agente sta paraphrasando, non riscrivendo.');
  } else if (presentOurs < 3) {
    console.log('PROBLEMA: solo ' + presentOurs + ' facts nostri sono presenti → il brief non viene usato.');
  } else {
    console.log('OK: ' + stillPresent + ' facts competitor restano, ' + presentOurs + ' facts nostri presenti.');
  }
})().catch((e) => { console.error('Crashed:', e); process.exit(1); });
