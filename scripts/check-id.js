const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const id = process.argv[2];
  const { data } = await sb
    .from('openclaw_messages')
    .select('status,error_message,response')
    .eq('id', id)
    .single();
  console.log('status:', data.status);
  if (data.error_message) console.log('err:', data.error_message.slice(0, 180));
  if (data.response) {
    const j = JSON.parse(data.response);
    console.log('original_length:', j.original_length, '| totalTexts:', j.totalTexts, '| replacements:', j.replacements, '| coverage:', j.coverage_ratio);
    const html = j.html || '';
    const body = html.match(/<body[\s\S]*?<\/body>/i);
    const txt = body ? body[0].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    console.log('captured body visible text len:', txt.length, '| imgs:', (html.match(/<img/gi) || []).length);
  }
})();
