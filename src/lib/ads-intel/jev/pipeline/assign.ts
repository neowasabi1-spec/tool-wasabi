import { brandContext, loadProject, productsText } from '../brain';
import { enqueue, progress } from '../jobs';
import { db, must } from '../db';
import { buildState, judge } from '../judge';
import { assignQuestions } from '../judge/questions';
import type { Creative, Product } from '../types';

const ASSIGN_MIN_P = 0.6;

export const hostOf = (s: string) => {
  try {
    return new URL(s.startsWith('http') ? s : `https://${s}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return s.replace(/^www\./, '').toLowerCase();
  }
};

/**
 * Assegna una creatività a un prodotto:
 * 1) dominio mostrato nell'ad = landing catalogata → assegnata
 * 2) altrimenti il giudice sceglie tra i prodotti collegati alla fonte (+ "nessuno")
 * 3) sotto soglia → resta senza prodotto, in coda di assegnazione manuale
 */
export async function assignCreative(creativeId: string) {
  const c = must(await db().from('jev_creatives').select('*').eq('id', creativeId).single()) as Creative;
  if (!c.source_id) return null;
  const { data: links } = await db().from('jev_product_sources').select('product_id').eq('source_id', c.source_id);
  const ids = (links ?? []).map((l) => l.product_id);
  if (!ids.length) return null;
  const products = must(await db().from('jev_products').select('*').in('id', ids)) as Product[];

  const hosts = c.captions.map(hostOf);
  const byDomain = products.filter((p) => p.landing_urls.some((u) => hosts.some((h) => h && (h === hostOf(u) || h.endsWith(`.${hostOf(u)}`)))));
  if (byDomain.length === 1) {
    await db().from('jev_creatives').update({ product_id: byDomain[0].id, assigned_by: 'domain', assign_p: 1 }).eq('id', creativeId);
    return byDomain[0].id;
  }

  const project = await loadProject(c.project_id);
  const candidates = byDomain.length > 1 ? byDomain : products;
  const state = buildState({
    brand_context: brandContext(project),
    brand_products: productsText(candidates),
    ad: c.description_en ?? c.bodies.join('\n'),
  });
  const answers = await judge({ type: 'assign', id: creativeId }, 'assign', state, assignQuestions(candidates), c.project_id);
  const a = answers.product;
  const chosen = typeof a.value === 'string' && a.value !== 'none' && a.p >= ASSIGN_MIN_P ? a.value : null;
  await db().from('jev_creatives').update({ product_id: chosen, assigned_by: chosen ? 'judge' : null, assign_p: a.p }).eq('id', creativeId);
  return chosen;
}

/**
 * Riassegna le creatività delle fonti collegate a un prodotto (dopo un cambio di modalità o di beneficio,
 * o una fonte collegata in ritardo) e rimette in coda il giudizio. Le assegnazioni manuali non si toccano.
 */
export async function reassignProduct(productId: string, jobId?: string) {
  const { data: links } = await db().from('jev_product_sources').select('source_id').eq('product_id', productId);
  const sourceIds = (links ?? []).map((l) => l.source_id);
  if (!sourceIds.length) return { reassigned: 0 };
  const { data: cs } = await db().from('jev_creatives').select('id, project_id, product_id, assigned_by, extraction_status')
    .in('source_id', sourceIds).neq('extraction_status', 'pending');
  const todo = (cs ?? []).filter((c) => c.assigned_by !== 'manual');
  let toThis = 0, elsewhere = 0, none = 0;
  for (const [i, c] of todo.entries()) {
    if (i % 5 === 0) await progress(jobId, `Riassegnazione ${i}/${todo.length}`);
    await db().from('jev_creatives').update({ product_id: null, assigned_by: null, assign_p: null, ranking: null }).eq('id', c.id);
    const chosen = await assignCreative(c.id);
    if (chosen === productId) toThis++; else if (chosen) elsewhere++; else none++;
    if (chosen) await enqueue('analyze_creative', { creativeId: c.id }, c.project_id);
  }
  return { reassigned: todo.length, toThis, elsewhere, unassigned: none, manualKept: (cs ?? []).length - todo.length };
}
