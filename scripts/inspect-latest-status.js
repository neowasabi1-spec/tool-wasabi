// scripts/inspect-latest-status.js
// Mostra lo stato + statistiche dell'ULTIMO job (qualsiasi status), per
// capire se il rewrite e' fallito, ha 0 replacements, o e' andato in errore.
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data: rows } = await sb
    .from('openclaw_messages')
    .select('id, status, target_agent, created_at, completed_at, error_message, response')
    .order('created_at', { ascending: false })
    .limit(6);
  for (const row of rows || []) {
    const ageM = Math.round((Date.now() - new Date(row.created_at).getTime()) / 60000);
    console.log('========================================================');
    console.log('JOB', row.id, '| agent', row.target_agent, '| status', row.status, '|', ageM + 'm fa');
    if (row.error_message) console.log('  ERROR_MESSAGE:', String(row.error_message).slice(0, 300));
    let p = null;
    try { p = JSON.parse(row.response); } catch { /* */ }
    if (!p) {
      console.log('  (response non-JSON o assente) head:', String(row.response || '').slice(0, 200));
      continue;
    }
    console.log('  success:', p.success, '| provider:', p.provider);
    console.log('  totalTexts:', p.totalTexts, '| replacements:', p.replacements, '| dom:', p.replacements_dom);
    console.log('  server html/fuzzy:', p.replacements_server_side_html, '/', p.replacements_server_side_fuzzy);
    console.log('  unresolved:', Array.isArray(p.unresolved_text_ids) ? p.unresolved_text_ids.length : p.unresolved_text_ids, '| coverage:', p.coverage_ratio);
    console.log('  error:', p.error, '| warnings:', p.warnings ? JSON.stringify(p.warnings).slice(0, 200) : undefined);
    console.log('  html len:', p.html ? p.html.length : '(no html)');
  }
})();
