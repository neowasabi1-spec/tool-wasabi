/* Reset stuck/errored video_segment_jobs back to pending so the worker retries.
 *   node scripts/reset-shot-jobs.js
 */
const { createClient } = require('@supabase/supabase-js');
const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

(async () => {
  const supabase = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from('video_segment_jobs')
    .update({ status: 'pending', error: null, started_at: null, finished_at: null, shots_count: 0 })
    .in('status', ['error', 'processing'])
    .select('id');
  if (error) return console.log('reset error:', error.message);
  console.log('reset to pending:', (data || []).map((r) => r.id).join(', ') || '(none)');
})();
