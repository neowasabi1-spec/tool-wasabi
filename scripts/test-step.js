// Directly invoke a single pipeline step on the deployed site and print the
// raw HTTP result (status + body). This surfaces the real error that the
// background sequencer swallows. Usage: node scripts/test-step.js <jobId> [stepKey]
const SITE = process.env.SITE || 'https://cute-cupcake-74bad8.netlify.app';

(async () => {
  const jobId = process.argv[2];
  const stepKey = process.argv[3] || 'market_research';
  if (!jobId) { console.error('usage: node scripts/test-step.js <jobId> [stepKey]'); process.exit(1); }

  const started = Date.now();
  console.log(`POST ${SITE}/api/pipeline/step  { jobId, stepKey: ${stepKey} }`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 240000);
  try {
    const res = await fetch(`${SITE}/api/pipeline/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, stepKey }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    console.log(`HTTP ${res.status} in ${(Date.now() - started) / 1000}s`);
    console.log('BODY:', text.slice(0, 2000));
  } catch (e) {
    console.log(`REQUEST FAILED after ${(Date.now() - started) / 1000}s: ${e.name} ${e.message}`);
  } finally {
    clearTimeout(t);
  }
})();
