// Riassunto dei job swipe_landing_local recenti: quanti testi sono stati
// effettivamente riscritti (replacements) per ognuno. Serve a capire DA QUANDO
// il rewrite ha smesso di produrre output.
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);

(async () => {
  const sinceArg = process.argv[2]; // optional ISO/relative window, default 24h
  const sinceMs = sinceArg
    ? Number.isFinite(Number(sinceArg))
      ? Date.now() - Number(sinceArg) * 3600_000
      : new Date(sinceArg).getTime()
    : Date.now() - 24 * 3600_000;

  const { data, error } = await sb
    .from('openclaw_messages')
    .select('id, status, target_agent, created_at, completed_at, error_message, response, user_message')
    .gte('created_at', new Date(sinceMs).toISOString())
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) { console.error(error); process.exit(1); }

  console.log(`window: since ${new Date(sinceMs).toISOString()}  (${(data || []).length} rows)`);
  console.log('─'.repeat(120));
  for (const m of data || []) {
    const um = m.user_message || '';
    const action = (um.match(/"action"\s*:\s*"([^"]+)/) || [])[1] || '?';
    const urlMatch = um.match(/sourceUrl"?\s*:\s*"([^"]+)/);
    const url = urlMatch ? urlMatch[1] : '';
    let totalTexts = '-', replacements = '-', coverage = '-', provider = '-', briefLen = '-', mrLen = '-';
    if (m.response) {
      try {
        const r = JSON.parse(m.response);
        totalTexts = r.totalTexts ?? '-';
        replacements = r.replacements ?? '-';
        coverage = r.coverage_ratio ?? '-';
        provider = r.provider ?? '-';
      } catch {/* ignore */}
    }
    // peek into user_message to learn brief/MR sizes that left the proxy
    const bm = um.match(/"brief"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (bm) briefLen = bm[1].length;
    const mm = um.match(/"market_research"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (mm) mrLen = mm[1].length;
    const t = new Date(m.created_at).toLocaleString('it-IT', { hour12: false });
    const dur = m.completed_at ? Math.round((new Date(m.completed_at).getTime() - new Date(m.created_at).getTime()) / 1000) : '-';
    const err = m.error_message ? ` ERR=${String(m.error_message).slice(0, 60)}` : '';
    console.log(
      `${t} | ${m.id.slice(0,8)} | ${(m.status||'?').padEnd(11)} | ${(m.target_agent||'null').padEnd(16)} | dur=${String(dur).padStart(3)}s | texts=${String(totalTexts).padStart(3)} repl=${String(replacements).padStart(3)} cov=${String(coverage).padStart(4)} | brief=${String(briefLen).padStart(6)} mr=${String(mrLen).padStart(6)} | ${url.slice(0, 50)}${err}`,
    );
  }
})();
