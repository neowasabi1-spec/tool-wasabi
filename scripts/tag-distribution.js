const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const jobId = '22e2c4df-76d8-456c-b3ac-ab4789adc4ce';
  const { data: texts } = await sb.from('cloning_texts').select('tag_name,original_text,new_text').eq('job_id', jobId).limit(3000);
  const dist = {};
  let textNodeCount = 0, textNodeChanged = 0;
  for (const t of texts) {
    const k = String(t.tag_name || '').split('@')[0].split(':')[0];
    dist[k] = (dist[k] || 0) + 1;
    if (String(t.tag_name) === 'text-node') {
      textNodeCount++;
      if (String(t.new_text || '').trim() && String(t.new_text).trim() !== String(t.original_text).trim()) textNodeChanged++;
    }
  }
  console.log('Distribuzione tag_name:', JSON.stringify(dist, null, 2));
  console.log('text-node estratti:', textNodeCount, '| cambiati:', textNodeChanged);
})();
