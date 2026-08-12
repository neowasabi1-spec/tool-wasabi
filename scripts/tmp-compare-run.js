const BASE = 'https://cute-cupcake-74bad8.netlify.app';
const FN = `${BASE}/.netlify/functions/inpaint-shot-background`;
const PID = '8dc8b6b3-9317-4c0e-acfd-7570e9838402';
// Long rejects: full-frame (X/X) and partial, bottom + center bands.
const ids = [615, 621, 670, 680];
(async () => {
  for (const shotId of ids) {
    const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId, projectId: PID, compareModel: 'ayushunleashed/minimax-remover' }) });
    console.log(`compare ${shotId} -> ${r.status}`);
  }
})();
