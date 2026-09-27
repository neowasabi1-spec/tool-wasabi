import { db } from '../db';
import { progress } from '../jobs';
import { generateConcepts, type Mutation } from './concepts';
import { ensureCorpus } from './corpus';
import { createBatch } from '../batches';
import { createOutput } from './outputs';

export type AutoOpts = {
  kind: 'text' | 'image' | 'video';
  top: number;          // quante creatività migliori usare come sorgenti
  count: number;        // quanti concept generare
  language: string;
  remix?: boolean;
  mutations?: Mutation[];
  /** same = stesso formato dell'output (immagine → immagini e caroselli, video → video, testo → tutte) */
  sourceFormat?: 'same' | 'all' | 'image' | 'video';
};

const FORMATS_FOR: Record<string, string[] | null> = {
  image: ['image', 'carousel'],
  video: ['video'],
  all: null,
};

/**
 * "Genera prompt dalle migliori": prende le prime N creatività della shortlist (per punteggio, escluse quelle con IP
 * di terzi), genera i concept e crea subito gli output di quelli che non sono stati scartati dal gate.
 * I concept in revisione ricevono comunque l'output, così si valutano con il prompt davanti.
 */
export async function autoPrompts(productId: string, opts: AutoOpts, jobId?: string) {
  await ensureCorpus(productId, jobId);
  const { data } = await db().from('jev_creatives').select('id, ranking, media_type, impression_pct').eq('product_id', productId).not('ranking', 'is', null);
  // efficacia reale (posizione per impression: Meta ci sta spendendo) + giudizio di Jev
  const merit = (c: { ranking: any; impression_pct: number | null }) => 0.5 * (c.ranking?.score ?? 0) + 0.5 * (c.impression_pct == null ? 0.5 : 1 - c.impression_pct);
  const wanted = opts.sourceFormat === 'all' ? null
    : opts.sourceFormat === 'image' || opts.sourceFormat === 'video' ? FORMATS_FOR[opts.sourceFormat]
    : opts.kind === 'text' ? null : FORMATS_FOR[opts.kind];
  const top = (data ?? [])
    .filter((c) => !c.ranking?.excluded)
    .filter((c) => !wanted || wanted.includes(c.media_type))
    .sort((a, b) => merit(b) - merit(a))
    .slice(0, Math.max(1, opts.top));
  if (!top.length) throw new Error(wanted ? `Nessuna creatività giudicata di formato ${wanted.join('/')}: scegli "Sorgenti: tutti i formati".` : 'Nessuna creatività giudicata per questo prodotto: aggiorna le fonti e attendi l\'analisi.');

  const batchId = await createBatch(productId, 'auto', `Dalle migliori ${top.length} · ${opts.kind}${opts.remix ? ' · remix' : ''}`, { ...opts, sources: top.map((c) => c.id) });
  await progress(jobId, `Concept dalle ${top.length} creatività migliori`);
  const g = await generateConcepts(productId, {
    kind: opts.kind,
    count: opts.count,
    sources: top.map((c) => ({ creativeId: c.id })),
    varyAxis: 'all',
    mutations: opts.mutations?.length ? opts.mutations : ['none'],
    combine: !!opts.remix && top.length >= 2,
    batchId,
  }, jobId);

  const ids = g.conceptIds.length ? g.conceptIds : ['00000000-0000-0000-0000-000000000000'];
  const { data: concepts } = await db().from('jev_concepts').select('id, status').in('id', ids);
  const { data: gates } = await db().from('jev_gate_results').select('target_id, reject_kind').eq('target_type', 'concept').in('target_id', ids);
  const kind = new Map((gates ?? []).map((x) => [x.target_id, x.reject_kind]));
  // scartati per copia o fuori brand: no; scartati solo come "deboli": sì, il ciclo di miglioramento dell'output li completa
  const usable = (concepts ?? []).filter((c) => c.status !== 'reject' || kind.get(c.id) === 'weak');
  const outputs: { conceptId: string; decision?: string; error?: string }[] = [];
  for (const [i, c] of usable.entries()) {
    await progress(jobId, `Prompt ${i + 1}/${usable.length}`);
    try {
      const r = await createOutput(c.id, { language: opts.language, variants: 3, batchId }, undefined);
      outputs.push({ conceptId: c.id, decision: r.decision });
    } catch (e) {
      outputs.push({ conceptId: c.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    sources: top.length,
    concepts: g.created,
    rejectedConcepts: (concepts ?? []).length - usable.length,
    outputs: outputs.filter((o) => !o.error).length,
    outputErrors: outputs.filter((o) => o.error).map((o) => o.error),
  };
}
