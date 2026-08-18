// Call the deployed step route directly and print the raw result/error.
// Usage: node scripts/run-step.js <jobId> [stepKey]
const SITE = process.env.SITE || 'https://cute-cupcake-74bad8.netlify.app';

(async () => {
  const jobId = process.argv[2];
  const stepKey = process.argv[3] || 'market_research';
  if (!jobId) { console.error('need jobId'); process.exit(1); }
  const t = Date.now();
  try {
    const res = await fetch(`${SITE}/api/pipeline/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, stepKey }),
    });
    const secs = ((Date.now() - t) / 1000).toFixed(1);
    console.log(`HTTP ${res.status} in ${secs}s`);
    const text = await res.text();
    console.log('BODY:', text.slice(0, 2000));
  } catch (e) {
    const secs = ((Date.now() - t) / 1000).toFixed(1);
    console.error(`FETCH FAILED after ${secs}s:`, e.message);
  }
})();
