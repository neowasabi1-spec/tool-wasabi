import { z } from 'zod';
import { brandContext, latestPlaybook, loadProduct, modeInstructions } from '../brain';
import { db, must } from '../db';
import { env } from '../env';
import { progress } from '../jobs';
import { chatJson } from '../openrouter';
import { getThresholds } from '../settings';

const WEIGHT: Record<string, number> = { own_metrics: 1, manual: 1, impressions: 0.7, longevity: 0.5, low_impressions: 0.3, short_lived: 0.3, adjacent: 0.2, none: 0.1 };

const days = (a: string | null, b: string | null) => (a && b ? (new Date(b).getTime() - new Date(a).getTime()) / 86400000 : 0);

/**
 * Costruisce il corpus di riferimento del prodotto.
 * - ads nostre con risultati: vincenti / perdenti per metrica (terzili)
 * - ads senza risultati: posizione nella classifica per impression della Ad Library (in cima = spende),
 *   poi longevità (indizio) o spente presto (negativo)
 * - brand adiacenti: solo ispirazione
 * Le etichette "manual" non vengono toccate.
 */
export async function buildCorpus(productId: string, jobId?: string) {
  const { product } = await loadProduct(productId);
  const th = await getThresholds();
  const rules = { metric: 'roas', ...(product.corpus_rules as { metric?: 'roas' | 'cpa' }) };
  await progress(jobId, 'Lettura creatività del prodotto');

  const creatives = must(await db().from('jev_creatives').select('id, source_id, first_seen, last_seen, active, extraction_status, impression_pct').eq('product_id', productId)) as any[];
  const sourceIds = [...new Set(creatives.map((c) => c.source_id).filter(Boolean))];
  const { data: sources } = await db().from('jev_sources').select('id, role').in('id', sourceIds.length ? sourceIds : ['00000000-0000-0000-0000-000000000000']);
  const role = new Map((sources ?? []).map((s) => [s.id, s.role as string]));

  // Metriche delle nostre ads: outcomes collegati alla creatività o all'id della Library
  const { data: ads } = await db().from('jev_ads').select('library_id, creative_id').in('creative_id', creatives.map((c) => c.id));
  const libToCreative = new Map((ads ?? []).map((a) => [a.library_id, a.creative_id]));
  const { data: outs } = await db().from('jev_outcomes').select('creative_id, external_ad_id, roas, cpa, spend').eq('product_id', productId);
  const metricByCreative = new Map<string, number>();
  for (const o of outs ?? []) {
    const cid = o.creative_id ?? libToCreative.get(o.external_ad_id);
    const v = rules.metric === 'cpa' ? o.cpa : o.roas;
    if (cid && v != null && Number(o.spend ?? 0) > 0) metricByCreative.set(cid, Number(v));
  }
  const vals = [...metricByCreative.values()].sort((a, b) => a - b);
  const q = (p: number) => vals[Math.floor(p * (vals.length - 1))];
  const [lo, hi] = vals.length >= 3 ? [q(1 / 3), q(2 / 3)] : [NaN, NaN];

  const { data: manual } = await db().from('jev_reference_ads').select('creative_id').eq('product_id', productId).eq('outcome_source', 'manual');
  const manualIds = new Set((manual ?? []).map((m) => m.creative_id));

  const rows: { product_id: string; creative_id: string; outcome: string; outcome_source: string; weight: number }[] = [];
  for (const c of creatives) {
    if (manualIds.has(c.id)) continue;
    const r = role.get(c.source_id) ?? 'competitor';
    let outcome = 'unknown', src = 'none';
    const m = metricByCreative.get(c.id);
    if (r === 'adjacent') { outcome = 'inspiration'; src = 'adjacent'; }
    else if (m != null && !Number.isNaN(lo)) {
      const better = rules.metric === 'cpa' ? m <= lo : m >= hi;
      const worse = rules.metric === 'cpa' ? m >= hi : m <= lo;
      outcome = better ? 'win' : worse ? 'loss' : 'unknown';
      src = 'own_metrics';
    } else {
      const life = days(c.first_seen, c.last_seen);
      const pct = c.impression_pct as number | null;
      if (pct != null && pct <= th.topImpressionPct) { outcome = 'win'; src = 'impressions'; }
      else if (life >= th.longevityDays) { outcome = 'win'; src = 'longevity'; }
      else if (pct != null && pct >= 1 - th.bottomImpressionPct && !c.active) { outcome = 'loss'; src = 'low_impressions'; }
      else if (!c.active && life <= th.shortLivedDays) { outcome = 'loss'; src = 'short_lived'; }
    }
    rows.push({ product_id: productId, creative_id: c.id, outcome, outcome_source: src, weight: WEIGHT[src] ?? 0.1 });
  }
  await db().from('jev_reference_ads').delete().eq('product_id', productId).neq('outcome_source', 'manual');
  for (let i = 0; i < rows.length; i += 500) await db().from('jev_reference_ads').insert(rows.slice(i, i + 500));
  const count = (o: string) => rows.filter((r) => r.outcome === o).length;
  return { total: rows.length, win: count('win'), loss: count('loss'), inspiration: count('inspiration'), unknown: count('unknown') };
}

const Pattern = z.object({ pattern: z.string(), evidence: z.string(), example_ids: z.array(z.string()) });
const PlaybookSchema = z.object({
  hooks_working: z.array(Pattern), hooks_failing: z.array(Pattern),
  messages_working: z.array(Pattern), messages_failing: z.array(Pattern),
  formats_working: z.array(Pattern), formats_failing: z.array(Pattern),
  category_conventions: z.array(z.string()),
  untapped_angles: z.array(z.string()),
  summary: z.string(),
});
export type Playbook = z.infer<typeof PlaybookSchema>;

const MAX_PER_GROUP = 25;

/** Distilla il corpus in un playbook compatto (deve stare nel contesto di Jev insieme al resto). */
export async function buildPlaybook(productId: string, jobId?: string) {
  const { product, project } = await loadProduct(productId);
  const { data: refs } = await db().from('jev_reference_ads').select('creative_id, outcome, outcome_source, weight').eq('product_id', productId).neq('outcome', 'unknown');
  if (!refs?.length) throw new Error('Corpus vuoto: aggiorna le fonti e ricostruisci il corpus prima del playbook.');
  const pick = (o: string) => refs.filter((r) => r.outcome === o).sort((a, b) => b.weight - a.weight).slice(0, MAX_PER_GROUP);
  const chosen = [...pick('win'), ...pick('loss'), ...pick('inspiration')];
  const { data: cs } = await db().from('jev_creatives').select('id, description_en').in('id', chosen.map((r) => r.creative_id));
  const desc = new Map((cs ?? []).map((c) => [c.id, c.description_en as string]));
  await progress(jobId, `Distillazione playbook da ${chosen.length} creatività`);

  const block = chosen.map((r) => `### id=${r.creative_id} · ${r.outcome.toUpperCase()} (${r.outcome_source}, weight ${r.weight})\n${(desc.get(r.creative_id) ?? '').slice(0, 1800)}`).join('\n\n');
  const pb = await chatJson({
    model: env.writerModel, purpose: 'playbook', projectId: project.id, temperature: 0.3, maxTokens: 6000,
    messages: [
      {
        role: 'system',
        content: 'You are a senior performance creative strategist. Distil a reference corpus of ads into a compact, evidence-based playbook. ' +
          'Weigh evidence by source: own_metrics > impressions (top of the page ranking by impressions) > longevity > low_impressions / short_lived. INSPIRATION items come from adjacent categories: use them only for untapped_angles. ' +
          'Describe mechanisms (hook mechanic, emotional lever, structure, format), never copy wording. Max 6 items per list. Answer with one JSON object.',
      },
      {
        role: 'user',
        content: `${brandContext(project, product)}\n\n${modeInstructions(product)}\nIn SAME BENEFIT mode the corpus sells other products: describe patterns about how the benefit is sold, not facts about those products.\n\nCORPUS\n${block}\n\nReturn JSON: hooks_working[], hooks_failing[], messages_working[], messages_failing[], formats_working[], formats_failing[] ` +
          `(each {pattern, evidence, example_ids[]}), category_conventions[] (what everybody does), untapped_angles[], summary.`,
      },
    ],
  }, PlaybookSchema);

  const lines = (title: string, xs: z.infer<typeof Pattern>[]) => (xs.length ? `${title}\n${xs.map((x) => `- ${x.pattern} (${x.evidence})`).join('\n')}` : '');
  const text = [
    pb.summary,
    lines('HOOKS THAT WORK', pb.hooks_working), lines('HOOKS THAT FAIL', pb.hooks_failing),
    lines('MESSAGES THAT WORK', pb.messages_working), lines('MESSAGES THAT FAIL', pb.messages_failing),
    lines('FORMATS THAT WORK', pb.formats_working), lines('FORMATS THAT FAIL', pb.formats_failing),
    pb.category_conventions.length ? `CATEGORY CONVENTIONS (not distinctive)\n${pb.category_conventions.map((x) => `- ${x}`).join('\n')}` : '',
    pb.untapped_angles.length ? `UNTAPPED ANGLES\n${pb.untapped_angles.map((x) => `- ${x}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 12000);

  const prev = await latestPlaybook(productId);
  await db().from('jev_playbooks').insert({ product_id: productId, version: (prev?.version ?? 0) + 1, content: pb, text });
  return { version: (prev?.version ?? 0) + 1 };
}

export type WinnersRef = { winning: string[]; losing: string[]; winnerImages: string[]; winnerIds: string[]; loserIds: string[] };

/**
 * Esempi di riferimento per giudicare l'efficacia: vincenti e perdenti del corpus, preferendo lo stesso formato
 * dell'output (immagine → immagini e caroselli, video → video). Descrizioni brevi, per stare nel contesto di Jev.
 */
export async function winnersFor(productId: string, kind: 'text' | 'image' | 'video', k = 5): Promise<WinnersRef> {
  const { data: refs } = await db().from('jev_reference_ads').select('creative_id, outcome, weight').eq('product_id', productId).in('outcome', ['win', 'loss']);
  if (!refs?.length) return { winning: [], losing: [], winnerImages: [], winnerIds: [], loserIds: [] };
  const { data: cs } = await db().from('jev_creatives').select('id, media_type, description_en, media_paths, poster_path, impression_rank').in('id', refs.map((r) => r.creative_id));
  const byId = new Map((cs ?? []).map((c) => [c.id, c]));
  const same = (t: string) => (kind === 'image' ? t === 'image' || t === 'carousel' : kind === 'video' ? t === 'video' : true);
  const pick = (outcome: string) => refs
    .filter((r) => r.outcome === outcome && byId.get(r.creative_id)?.description_en)
    .map((r) => ({ r, c: byId.get(r.creative_id)! }))
    .sort((a, b) => Number(same(b.c.media_type)) - Number(same(a.c.media_type)) || b.r.weight - a.r.weight || (a.c.impression_rank ?? 999) - (b.c.impression_rank ?? 999))
    .slice(0, k);
  const text = (x: { c: any }) => `[#${x.c.impression_rank ?? '?'} by impressions · ${x.c.media_type}]\n${String(x.c.description_en).slice(0, 1100)}`;
  const win = pick('win');
  const loss = pick('loss');
  return {
    winnerIds: win.map((x) => x.c.id),
    loserIds: loss.map((x) => x.c.id),
    winning: win.map(text),
    losing: loss.map(text),
    winnerImages: win.map((x) => (x.c.media_type === 'video' ? x.c.poster_path : x.c.media_paths?.[0])).filter(Boolean).slice(0, 3),
  };
}

/** Se mancano, costruisce corpus e playbook: senza, il giudice non sa cosa funziona per questo prodotto. */
export async function ensureCorpus(productId: string, jobId?: string) {
  const { count } = await db().from('jev_reference_ads').select('id', { count: 'exact', head: true }).eq('product_id', productId);
  if (!count) { await progress(jobId, 'Costruzione del corpus (classifica per impression)'); await buildCorpus(productId, jobId); }
  const pb = await latestPlaybook(productId);
  if (!pb) { await progress(jobId, 'Generazione del playbook'); await buildPlaybook(productId, jobId); }
}

/** Riferimento esplicito (es. i membri di una famiglia di stile): vincenti = quelle creatività, perdenti dal corpus. */
export async function winnersFromIds(productId: string, kind: 'text' | 'image' | 'video', ids: string[], k = 5): Promise<WinnersRef> {
  const base = await winnersFor(productId, kind, k);
  if (!ids.length) return base;
  const { data: cs } = await db().from('jev_creatives').select('id, media_type, description_en, media_paths, poster_path, impression_rank').in('id', ids.slice(0, k));
  const ordered = ids.slice(0, k).map((id) => cs?.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c && !!c.description_en);
  return {
    ...base,
    winnerIds: ordered.map((c) => c.id),
    winning: ordered.map((c) => `[#${c.impression_rank ?? '?'} by impressions · ${c.media_type}]\n${String(c.description_en).slice(0, 1100)}`),
    winnerImages: ordered.map((c) => (c.media_type === 'video' ? c.poster_path : c.media_paths?.[0])).filter(Boolean).slice(0, 3),
  };
}
