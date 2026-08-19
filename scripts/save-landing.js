// One-off: fetch a real competitor landing URL and save it into a project's
// Competitor Landings (archived_funnels + page_html). Deduped by source_url.
// Usage: node scripts/save-landing.js <projectId> <url> [label]
const { createClient } = require('@supabase/supabase-js');
const URL_SB = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const sb = createClient(URL_SB, KEY);

(async () => {
  const projectId = process.argv[2] || '53738dcb-862c-41e0-b422-c45101518d4a';
  const url = process.argv[3] || 'https://naturtreu.de/products/floraintima-milchsaurebakterien-mit-cranberry-vitamin-b3';
  const label = process.argv[4] || 'Competitor';

  const { data: existing } = await sb.from('archived_funnels').select('id, steps').eq('project_id', projectId);
  for (const r of existing || []) {
    const s = Array.isArray(r.steps) ? r.steps[0] : null;
    if (s && s.cloned_data && s.cloned_data.source_url === url) { console.log('Already saved.'); return; }
  }

  const resp = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
  });
  console.log('HTTP', resp.status, resp.headers.get('content-type'));
  const html = (await resp.text()).slice(0, 3_000_000);
  console.log('htmlLen', html.length);
  if (html.length < 200) { console.error('HTML too short — aborting.'); process.exit(1); }

  let name = 'Competitor landing';
  try { name = new URL(url).hostname.replace(/^www\./, ''); } catch {}
  if (label) name = `${name} (${label})`;

  const step = {
    step_index: 1, name, page_type: 'landing', category: '', template_name: '',
    product_name: '', url_to_swipe: url, prompt: '', feedback: '',
    swipe_status: 'completed', swipe_result: '', swiped_data: null,
    cloned_data: { html, title: name, source_url: url, method_used: 'competitor-link', cloned_at: new Date().toISOString(), category: '', tags: [] },
  };
  const { data: created, error } = await sb
    .from('archived_funnels')
    .insert({ name, total_steps: 1, steps: [step], project_id: projectId })
    .select('id').single();
  if (error) { console.error('INSERT ERROR:', error.message); process.exit(1); }
  await sb.from('page_html').upsert(
    { page_id: created.id, kind: 'cloned', variant: 'desktop', html, updated_at: new Date().toISOString() },
    { onConflict: 'page_id,kind,variant' },
  );
  console.log(`Saved landing "${name}" (id ${created.id}).`);
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
