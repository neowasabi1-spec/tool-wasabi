// Enqueue a swipe_landing_local job and poll until done.
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const url = process.argv[2];
  const target = process.env.SWIPETEST_TARGET || 'openclaw:neo';
  const payload = {
    action: 'swipe_landing_local',
    sourceUrl: url,
    product: { name: 'TestProduct', description: 'PROJECT: TestProduct\n\nDESCRIPTION: generic test product for swipe capture verification.' },
    tone: 'persuasive',
    language: 'en',
  };
  const { data, error } = await sb
    .from('openclaw_messages')
    .insert({ user_message: JSON.stringify(payload), section: 'swipe_job', status: 'pending', target_agent: target })
    .select('id')
    .single();
  if (error) { console.log('insert ERR', error.message); process.exit(1); }
  const id = data.id;
  console.log('enqueued', id, '->', target);
  for (let i = 0; i < 90; i++) {
    await sleep(3000);
    const { data: row } = await sb.from('openclaw_messages').select('status,error_message,response').eq('id', id).single();
    if (!row) continue;
    if (row.status === 'completed' || row.status === 'error' || row.status === 'failed') {
      console.log('status:', row.status);
      if (row.error_message) console.log('error:', row.error_message.slice(0, 200));
      if (row.response) {
        try {
          const j = JSON.parse(row.response);
          console.log('original_length:', j.original_length, '| new_length:', j.new_length, '| totalTexts:', j.totalTexts, '| replacements:', j.replacements);
          console.log('method_used:', j.method_used, '| source?', j.source);
          const body = (j.html || '').match(/<body[\s\S]*?<\/body>/i);
          const txt = body ? body[0].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
          console.log('captured body visible text len:', txt.length);
          console.log('imgs in html:', (j.html.match(/<img/gi) || []).length);
        } catch { console.log('response (raw):', row.response.slice(0, 150)); }
      }
      return;
    }
    if (i % 3 === 0) console.log('  ...', row.status);
  }
  console.log('timeout waiting');
})().catch((e) => { console.error(e.message); process.exit(1); });
