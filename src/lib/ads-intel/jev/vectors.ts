export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** pgvector restituisce il vettore come stringa "[0.1,0.2,...]". */
export function parseVector(v: unknown): number[] | null {
  if (!v) return null;
  if (Array.isArray(v)) return v as number[];
  if (typeof v === 'string') return JSON.parse(v);
  return null;
}

export const toPg = (v: number[]) => `[${v.join(',')}]`;

/** Maximal Marginal Relevance: bilancia qualità e diversità nella scelta finale. */
export function mmr<T>(items: { item: T; score: number; vec: number[] }[], k: number, lambda = 0.6): T[] {
  const picked: typeof items = [];
  const pool = [...items];
  while (picked.length < k && pool.length) {
    let best = 0, bestVal = -Infinity;
    pool.forEach((c, i) => {
      const maxSim = picked.length ? Math.max(...picked.map((p) => cosine(p.vec, c.vec))) : 0;
      const val = lambda * c.score - (1 - lambda) * maxSim;
      if (val > bestVal) { bestVal = val; best = i; }
    });
    picked.push(pool.splice(best, 1)[0]);
  }
  return picked.map((p) => p.item);
}
