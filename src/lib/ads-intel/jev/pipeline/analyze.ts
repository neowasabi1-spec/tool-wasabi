import { brandContext, latestPlaybook, loadProduct, productsText } from '../brain';
import { db, must } from '../db';
import { buildState, judge, norm, type Answers } from '../judge';
import { AD_QUESTIONS, FORMAT_QUESTIONS, HOOK_QUESTIONS, MESSAGE_QUESTIONS } from '../judge/questions';
import { enqueue, progress } from '../jobs';
import { getThresholds } from '../settings';
import type { Creative } from '../types';
import { parseVector } from '../vectors';

export const DEFAULT_WEIGHTS = {
  ad_angle: 0.45, ad_fit: 0.4, ad_repro: 0.15,
  hook_stop: 0.5, hook_corpus: 0.3, hook_fit: 0.2,
  message_angle: 0.5, message_fit: 0.5,
  format_repro: 0.6, format_corpus: 0.4,
};
export type Weights = typeof DEFAULT_WEIGHTS;

/** Le k creatività del corpus più simili, con esito, formattate per lo state del giudice. */
export async function similarReferences(productId: string, embedding: number[] | null, excludeId: string, k = 8) {
  if (!embedding) return [];
  const { data } = await db().rpc('match_reference', { p_product: productId, p_embedding: `[${embedding.join(',')}]`, p_k: k + 1 });
  const rows = ((data ?? []) as { creative_id: string; outcome: string; outcome_source: string; similarity: number }[]).filter((r) => r.creative_id !== excludeId).slice(0, k);
  if (!rows.length) return [];
  const { data: cs } = await db().from('jev_creatives').select('id, description_en').in('id', rows.map((r) => r.creative_id));
  const desc = new Map((cs ?? []).map((c) => [c.id, c.description_en as string]));
  return rows.map((r) => `[${r.outcome.toUpperCase()} · source: ${r.outcome_source} · similarity ${r.similarity.toFixed(2)}]\n${(desc.get(r.creative_id) ?? '').slice(0, 2500)}`);
}

const corpusScore = (a?: Answers[string]) => {
  if (!a?.probs) return 0.5;
  return Number(a.probs.closer_to_winners ?? 0) + 0.5 * Number(a.probs.no_clear_match ?? 0);
};

/** Giudica una creatività (e le sue sezioni se è un video) e calcola la classifica nel codice. */
export async function analyzeCreative(creativeId: string, jobId?: string) {
  const c = must(await db().from('jev_creatives').select('*').eq('id', creativeId).single()) as Creative;
  if (!c.product_id || !c.description_en) return { skipped: !c.product_id ? 'senza prodotto' : 'non estratta' };
  const { product, project } = await loadProduct(c.product_id);
  const th = await getThresholds();
  const w: Weights = { ...DEFAULT_WEIGHTS, ...(product.weights as Partial<Weights>) };
  const playbook = await latestPlaybook(product.id);
  const refs = await similarReferences(product.id, parseVector(c.embedding), c.id);

  const base = {
    brand_context: brandContext(project, product),
    brand_products: productsText([product]),
    playbook: playbook?.text ?? '(playbook non ancora generato)',
  };

  await progress(jobId, 'Giudizio sull\'ad');
  const ad = await judge({ type: 'creative', id: c.id }, 'ad', buildState({ ...base, ad: c.description_en }, { similar_reference_ads: refs }), AD_QUESTIONS, project.id);
  const borrowed = ad.borrowed_ip.pTrue ?? 0;
  const adScore = w.ad_angle * norm(ad.angle_strength) + w.ad_fit * norm(ad.positioning_fit) + w.ad_repro * norm(ad.reproducibility);
  await db().from('jev_creatives').update({
    ranking: {
      score: adScore,
      excluded: borrowed > th.borrowedIp,
      reason: borrowed > th.borrowedIp ? `IP di terzi (p=${borrowed.toFixed(2)})` : null,
      angle_strength: ad.angle_strength.value, positioning_fit: ad.positioning_fit.value, reproducibility: ad.reproducibility.value,
    },
  }).eq('id', c.id);

  if (c.media_type === 'video') {
    const { data: sections } = await db().from('jev_creative_sections').select('*').eq('creative_id', c.id);
    for (const s of sections ?? []) {
      await progress(jobId, `Giudizio sezione ${s.section}`);
      const sectionRefs = await similarReferences(product.id, parseVector(s.embedding), c.id, 6);
      const state = buildState({ ...base, ad: `${s.text}\n\n(Full ad for context)\n${c.description_en.slice(0, 6000)}` }, { similar_reference_ads: sectionRefs });
      let ranking: Record<string, unknown> = {};
      if (s.section === 'hook') {
        const a = await judge({ type: 'section', id: s.id }, 'hook', state, HOOK_QUESTIONS, project.id);
        ranking = {
          score: w.hook_stop * norm(a.stop_power) + w.hook_corpus * corpusScore(a.vs_corpus) + w.hook_fit * norm(ad.positioning_fit),
          hook_type: a.hook_type.value, stop_power: a.stop_power.value, vs_corpus: a.vs_corpus.value,
          corpus_score: corpusScore(a.vs_corpus), fit: ad.positioning_fit.value,
        };
      } else if (s.section === 'message') {
        const a = await judge({ type: 'section', id: s.id }, 'message', state, MESSAGE_QUESTIONS, project.id);
        const ip = a.borrowed_ip.pTrue ?? 0;
        ranking = {
          score: w.message_angle * norm(a.angle_strength) + w.message_fit * norm(a.positioning_fit),
          excluded: ip > th.borrowedIp,
          angle: a.angle.value, awareness_level: a.awareness_level.value, claim_risk: a.claim_risk.value,
          angle_strength: a.angle_strength.value, positioning_fit: a.positioning_fit.value,
        };
      } else {
        const a = await judge({ type: 'section', id: s.id }, 'format', state, FORMAT_QUESTIONS, project.id);
        ranking = {
          score: w.format_repro * norm(a.reproducibility) + w.format_corpus * corpusScore(a.vs_corpus),
          format: a.format.value, production_level: a.production_level.value, vs_corpus: a.vs_corpus.value,
          reproducibility: a.reproducibility.value, corpus_score: corpusScore(a.vs_corpus),
        };
      }
      await db().from('jev_creative_sections').update({ ranking }).eq('id', s.id);
    }
  }
  return { score: adScore };
}

/** Rimette in coda l'analisi di tutte le creatività del prodotto (dopo un nuovo playbook o nuovi pesi). */
export async function analyzeProduct(productId: string) {
  const { data } = await db().from('jev_creatives').select('id, project_id').eq('product_id', productId).eq('extraction_status', 'done');
  for (const c of data ?? []) await enqueue('analyze_creative', { creativeId: c.id }, c.project_id);
  return { queued: data?.length ?? 0 };
}

/** Ricalcola i punteggi con i pesi attuali dai valori già giudicati: nessuna nuova chiamata al giudice. */
export async function rescoreProduct(productId: string) {
  const product = must(await db().from('jev_products').select('weights').eq('id', productId).single()) as { weights: Partial<Weights> };
  const w: Weights = { ...DEFAULT_WEIGHTS, ...product.weights };
  const n = (v: unknown) => (typeof v === 'number' ? Math.max(0, Math.min(1, v / 2)) : 0);
  const { data: cs } = await db().from('jev_creatives').select('id, ranking').eq('product_id', productId).not('ranking', 'is', null);
  for (const c of cs ?? []) {
    const r = c.ranking as Record<string, unknown>;
    await db().from('jev_creatives').update({ ranking: { ...r, score: w.ad_angle * n(r.angle_strength) + w.ad_fit * n(r.positioning_fit) + w.ad_repro * n(r.reproducibility) } }).eq('id', c.id);
  }
  const ids = (cs ?? []).map((c) => c.id);
  const { data: secs } = await db().from('jev_creative_sections').select('id, section, ranking').in('creative_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']).not('ranking', 'is', null);
  for (const s of secs ?? []) {
    const r = s.ranking as Record<string, unknown>;
    const cs_ = typeof r.corpus_score === 'number' ? r.corpus_score : 0.5;
    const score = s.section === 'hook' ? w.hook_stop * n(r.stop_power) + w.hook_corpus * cs_ + w.hook_fit * n(r.fit)
      : s.section === 'message' ? w.message_angle * n(r.angle_strength) + w.message_fit * n(r.positioning_fit)
      : w.format_repro * n(r.reproducibility) + w.format_corpus * cs_;
    await db().from('jev_creative_sections').update({ ranking: { ...r, score } }).eq('id', s.id);
  }
  return { creatives: cs?.length ?? 0, sections: secs?.length ?? 0 };
}
