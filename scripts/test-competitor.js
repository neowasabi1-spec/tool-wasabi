// Targeted test of ONLY the Autopilot competitor step (multi-platform).
// Inserts a pipeline_jobs row where every step except `competitor` is already
// marked completed, then triggers the deployed background function so just the
// competitor discovery runs (Meta + TikTok + Google via Apify).
//
// Usage: node scripts/test-competitor.js [projectId]
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const SITE = process.env.SITE || 'https://cute-cupcake-74bad8.netlify.app';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const steps = [
  { key: 'market_research', label: 'Market research', status: 'completed' },
  { key: 'brief', label: 'Product brief', status: 'completed' },
  { key: 'competitor', label: 'Competitor research', status: 'pending' },
  { key: 'ads', label: 'Angles & Ads', status: 'skipped' },
  { key: 'landing', label: 'Landing + mockup', status: 'skipped' },
];

(async () => {
  const projectId = process.argv[2] || '53738dcb-862c-41e0-b422-c45101518d4a';
  const input = {
    product: 'Intima Balance / DE',
    market: 'Germania · tedesco',
    competitorLink: 'https://naturtreu.de/products/floraintima-milchsaurebakterien-mit-cranberry-vitamin-b3',
    description: 'prodotto per il mercato tedesco per i problemi intimi delle donne',
  };

  const { data: job, error } = await sb
    .from('pipeline_jobs')
    .insert({ project_id: projectId, status: 'running', input, steps, current_step: 'competitor' })
    .select('id')
    .single();
  if (error) { console.error('INSERT ERROR:', error.message); process.exit(1); }
  console.log('Created competitor-only job:', job.id);

  const res = await fetch(`${SITE}/.netlify/functions/pipeline-run-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: job.id }),
  });
  console.log('Background trigger HTTP', res.status);
  console.log('\nPoll with:  node scripts/inspect-pipeline.js');
  console.log('Then check: node scripts/inspect-outputs.js', projectId);
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
