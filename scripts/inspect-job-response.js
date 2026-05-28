// Dig into the response HTML of a completed swipe_landing_local job.
// We try to detect whether the rewrite actually changed anything:
//   - look for the rewrite-marker counter the worker logs (mappingsCount)
//   - count how many text-bearing tags differ vs the source (rough heuristic)
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: <id-prefix>'); process.exit(1); }
  const { data: rows } = await sb
    .from('openclaw_messages').select('*').order('created_at', { ascending: false }).limit(50);
  const row = (rows || []).find((r) => String(r.id).startsWith(arg));
  if (!row) { console.log('no row'); return; }
  const resp = row.response;
  if (typeof resp !== 'string') { console.log('no response string'); return; }
  let parsed; try { parsed = JSON.parse(resp); } catch { parsed = null; }
  console.log('response length:', resp.length);
  if (parsed) {
    console.log('response keys :', Object.keys(parsed));
    if (parsed.html) console.log('  html len    :', parsed.html.length);
    if (parsed.mappings) console.log('  mappings    :', Array.isArray(parsed.mappings) ? parsed.mappings.length : typeof parsed.mappings);
    if (parsed.totalRewritten != null) console.log('  totalRewrtt :', parsed.totalRewritten);
    if (parsed.totalTexts != null) console.log('  totalTexts  :', parsed.totalTexts);
    if (parsed.error) console.log('  error       :', parsed.error);
    if (parsed.warnings) console.log('  warnings    :', parsed.warnings);
    if (parsed.stats) console.log('  stats       :', JSON.stringify(parsed.stats));
    console.log('  replacements             :', parsed.replacements);
    console.log('  replacements_dom         :', parsed.replacements_dom);
    console.log('  replacements_title       :', parsed.replacements_title);
    console.log('  replacements_meta        :', parsed.replacements_meta);
    console.log('  replacements_server_side :', parsed.replacements_server_side_html, '/', parsed.replacements_server_side_fuzzy);
    console.log('  unresolved_text_ids      :', Array.isArray(parsed.unresolved_text_ids) ? parsed.unresolved_text_ids.length : parsed.unresolved_text_ids);
    console.log('  coverage_ratio           :', parsed.coverage_ratio);
    console.log('  method_used              :', parsed.method_used);
    console.log('  provider                 :', parsed.provider);
    console.log('  changes_made             :', parsed.changes_made);
    console.log('  finalize_duration_ms     :', parsed.finalize_duration_ms);
    console.log('  is_spa_page              :', parsed.is_spa_page);
    console.log('  original_title           :', parsed.original_title);
    console.log('  new_title                :', parsed.new_title);
    console.log('  original_length          :', parsed.original_length, '-> new_length:', parsed.new_length);
    console.log('  spa_safety_strips        :', parsed.spa_safety_strips);
    console.log('  inline_css_stats         :', JSON.stringify(parsed.inline_css_stats));
    if (Array.isArray(parsed.mappings) && parsed.mappings.length) {
      const sample = parsed.mappings.slice(0, 5).map((m, i) =>
        `    [${i+1}] orig="${String(m.original || '').slice(0, 80)}" => new="${String(m.rewritten || m.new || '').slice(0, 80)}"`,
      );
      console.log('  first 5 mappings:\n' + sample.join('\n'));
    }
  } else {
    console.log('response head 800 chars:');
    console.log(resp.slice(0, 800));
  }
})();
