// Enqueue a fresh Autopilot run on an existing project to verify the pipeline
// end-to-end. Usage: node scripts/launch-pipeline.js <projectId>
const SITE = process.env.SITE || 'https://cute-cupcake-74bad8.netlify.app';

(async () => {
  const projectId = process.argv[2] || '53738dcb-862c-41e0-b422-c45101518d4a';
  const body = {
    projectId,
    product: 'Intima Balance / DE',
    market: 'Germania · tedesco',
    competitorLink: 'https://naturtreu.de/products/floraintima-milchsaurebakterien-mit-cranberry-vitamin-b3',
    description: 'prodotto per il mercato tedesco per i problemi intimi delle donne',
  };
  const res = await fetch(`${SITE}/api/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log('HTTP', res.status);
  console.log(text.slice(0, 800));
})();
