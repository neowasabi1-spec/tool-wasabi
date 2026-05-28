/**
 * Marka come "error" tutti i job in stato 'processing' più vecchi di N minuti.
 * Usato per ripulire i job-zombie lasciati indietro quando il worker e' stato
 * killato a meta' lavoro: il record resta 'processing' all'infinito e la UI
 * resta in attesa indefinita.
 *
 *   node scripts/kill-zombie-jobs.js          # default: 15 min
 *   node scripts/kill-zombie-jobs.js 60       # solo job > 60 min
 *   node scripts/kill-zombie-jobs.js --dry    # mostra senza modificare
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const minutesArg = args.find((a) => /^\d+$/.test(a));
const MAX_AGE_MIN = minutesArg ? parseInt(minutesArg, 10) : 15;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

(async () => {
  const cutoff = new Date(Date.now() - MAX_AGE_MIN * 60_000).toISOString();
  const { data, error } = await supabase
    .from('openclaw_messages')
    .select('id, section, target_agent, created_at')
    .eq('status', 'processing')
    .lt('created_at', cutoff);
  if (error) { console.error('Query failed:', error.message); process.exit(1); }
  if (!data || data.length === 0) {
    console.log(`✓ Nessun job zombie (processing piu' vecchio di ${MAX_AGE_MIN} min).`);
    return;
  }
  console.log(`Trovati ${data.length} job zombie (processing > ${MAX_AGE_MIN} min):`);
  for (const r of data) {
    const ageMin = Math.round((Date.now() - new Date(r.created_at).getTime()) / 60_000);
    console.log(`  • ${r.id.slice(0, 8)}  ${r.section || '(no-section)'}  ${r.target_agent || '(any)'}  ${ageMin}m`);
  }
  if (dryRun) {
    console.log('\n(dry-run, nessuna modifica fatta)');
    return;
  }
  const ids = data.map((r) => r.id);
  const { error: updErr } = await supabase
    .from('openclaw_messages')
    .update({
      status: 'error',
      error_message: `Worker died mid-processing (zombie cleanup, was processing for >${MAX_AGE_MIN}min)`,
      completed_at: new Date().toISOString(),
    })
    .in('id', ids);
  if (updErr) { console.error('Update failed:', updErr.message); process.exit(1); }
  console.log(`\n✓ ${ids.length} job marcati come 'error'. Adesso il worker non li vede piu' e la UI puo' enqueueare nuovi job.`);
})().catch((e) => { console.error('Crashed:', e); process.exit(1); });
