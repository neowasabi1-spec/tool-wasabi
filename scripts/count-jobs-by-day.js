// Conteggio openclaw_messages per giorno, per capire se i job vengono auto-puliti
// e da quanto tempo c'e' attivita'.
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data, error, count } = await sb
    .from('openclaw_messages')
    .select('id, status, target_agent, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) { console.error(error); process.exit(1); }
  console.log('total rows in table:', count);
  const byDay = new Map();
  for (const r of data || []) {
    const day = r.created_at.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { total: 0, byStatus: {}, byAgent: {} });
    const slot = byDay.get(day);
    slot.total++;
    slot.byStatus[r.status] = (slot.byStatus[r.status] || 0) + 1;
    slot.byAgent[r.target_agent || 'null'] = (slot.byAgent[r.target_agent || 'null'] || 0) + 1;
  }
  for (const [day, slot] of [...byDay.entries()].sort().reverse().slice(0, 30)) {
    console.log(`${day}  total=${slot.total}  status=${JSON.stringify(slot.byStatus)}  agent=${JSON.stringify(slot.byAgent)}`);
  }
})();
