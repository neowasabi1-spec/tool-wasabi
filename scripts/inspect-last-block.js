// scripts/inspect-last-block.js
// Pesca l'ultimo job openclaw completato e indaga il blocco
// "first brain supplement ... 2025 Nature Medicine discovery":
//  - e' stato ESTRATTO? (cerca nei mappings/texts della risposta)
//  - Morfeo l'ha RISCRITTO? (original != rewritten?)
//  - e' rimasto ORIGINALE nell'HTML finale?
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);

const NEEDLE = process.argv[2] || 'Nature Medicine discovery';
const NEEDLE2 = 'first brain supplement';

(async () => {
  const { data: rows } = await sb
    .from('openclaw_messages')
    .select('id, status, target_agent, created_at, completed_at, user_message, response')
    .in('status', ['completed', 'done', 'success'])
    .order('created_at', { ascending: false })
    .limit(10);

  if (!rows || rows.length === 0) { console.log('Nessun job completato trovato.'); return; }

  const row = rows[0];
  console.log('JOB:', row.id, '| agent:', row.target_agent, '| created:', row.created_at);

  let parsed = null;
  try { parsed = JSON.parse(row.response); } catch { /* */ }
  if (!parsed) { console.log('Risposta non JSON. Head:\n', String(row.response).slice(0, 500)); return; }

  console.log('\n--- CHIAVI RISPOSTA ---');
  console.log(' ', Object.keys(parsed).join(', '));
  console.log('  unresolved_text_ids (lista):', JSON.stringify(parsed.unresolved_text_ids));

  console.log('\n--- STATISTICHE FINALIZE ---');
  console.log('  totalTexts               :', parsed.totalTexts);
  console.log('  replacements             :', parsed.replacements);
  console.log('  replacements_dom         :', parsed.replacements_dom);
  console.log('  server_side html/fuzzy   :', parsed.replacements_server_side_html, '/', parsed.replacements_server_side_fuzzy);
  console.log('  unresolved_text_ids (n)  :', Array.isArray(parsed.unresolved_text_ids) ? parsed.unresolved_text_ids.length : parsed.unresolved_text_ids);
  console.log('  coverage_ratio           :', parsed.coverage_ratio);
  console.log('  is_spa_page              :', parsed.is_spa_page, '| spa_safety_strips:', parsed.spa_safety_strips);

  const mappings = Array.isArray(parsed.mappings) ? parsed.mappings
    : Array.isArray(parsed.changes_made) ? parsed.changes_made : [];
  console.log('\n--- RICERCA NEI MAPPINGS (' + mappings.length + ' totali) ---');
  const hits = mappings.filter((m) => {
    const o = String(m.original || m.from || '');
    const n = String(m.rewritten || m.new || m.to || '');
    return o.includes(NEEDLE) || o.includes(NEEDLE2) || n.includes(NEEDLE) || n.includes(NEEDLE2);
  });
  if (hits.length === 0) {
    console.log('  >>> NESSUN mapping contiene il blocco. (probabile: NON estratto o NON mandato al modello)');
  } else {
    for (const m of hits) {
      const o = String(m.original || m.from || '');
      const n = String(m.rewritten || m.new || m.to || '');
      console.log('  original :', o);
      console.log('  rewritten:', n);
      console.log('  CAMBIATO?:', o.trim() !== n.trim() ? 'SI' : 'NO (identico → finalize lo salta)');
      console.log('');
    }
  }

  const html = parsed.html || '';
  console.log('--- STATO NELL HTML FINALE (len ' + html.length + ') ---');
  const idx = html.indexOf(NEEDLE);
  const idx2 = html.indexOf(NEEDLE2);
  const at = idx !== -1 ? idx : idx2;
  if (at !== -1) {
    console.log('  Trovato a offset', at, '— contesto:');
    console.log('  ...' + html.substring(Math.max(0, at - 120), at + 200).replace(/\s+/g, ' ') + '...');
  } else {
    console.log('  Il testo NON e nell HTML finale (forse gia riscritto/diverso).');
  }
})();
