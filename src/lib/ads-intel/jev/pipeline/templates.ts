import crypto from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { db } from '../db';
import { env } from '../env';
import { progress } from '../jobs';
import { chatJson, embed, looseNumber, looseString, looseStringArray, type ContentPart } from '../openrouter';
import { pool } from '../pool';
import { getThresholds } from '../settings';
import { getMedia } from '../storage';
import { cosine, parseVector, toPg } from '../vectors';
import { averageLinkage } from './families';

/**
 * Template grafici.
 *
 * Una "famiglia di stile" calcolata sull'immagine intera raggruppava per TESTO (lo stesso messaggio in dieci grafiche
 * diverse) e la generazione mescolava le grafiche. Qui lo stile è la scheda riproducibile di UNA ad di riferimento:
 * sfondo, elementi dall'alto in basso, caratteri, colori e spazi di testo. Si genera dentro un template alla volta,
 * cambiando solo i testi; i template si raggruppano confrontando la sola struttura grafica, senza le parole.
 */

export const TemplateSpec = z.object({
  template_name: looseString,
  name_it: looseString,
  genre: looseString,
  canvas: z.object({ background: looseString, effects: looseString }),
  layout: z.array(z.object({ order: looseNumber, element: looseString, position: looseString, size: looseString, look: looseString })),
  typography: looseString,
  palette_hex: looseStringArray,
  slots: z.array(z.object({ slot: looseString, role: looseString, current_text: looseString, words: looseNumber, casing: looseString })),
  must_keep: looseStringArray,
  free_to_change: looseStringArray,
});
export type TemplateSpec = z.infer<typeof TemplateSpec>;

const EXTRACT_SYSTEM = 'You reverse-engineer an ad image into a reusable design template that a designer could rebuild pixel-close with DIFFERENT text. ' +
  'Describe only what is visible. layout lists every visual element top to bottom with position (e.g. "top centre, 12% from top"), size (share of width/height) and look (shape, colour, shadow, material, font). ' +
  'Never quote the ad\'s words in layout, typography or canvas: all text belongs in slots. ' +
  'slots are the pieces of text that change from ad to ad (headline, body, button labels, reference numbers, app name, timestamps...): give a snake_case slot name, its role, the current text, word count and casing. ' +
  'must_keep = the features that make this template recognisable; free_to_change = what can vary without breaking it. ' +
  'name_it = an Italian name of 3 to 7 words for the template (layout and key elements, no brand names). Answer with one JSON object in English (except name_it).';

const EXTRACT_SHAPE = 'Return JSON {template_name, name_it, genre, canvas{background, effects}, layout[{order, element, position, size, look}], typography, palette_hex[], slots[{slot, role, current_text, words, casing}], must_keep[], free_to_change[]}.';

/** La struttura grafica in parole, senza testi: è ciò che si confronta per raggruppare i template. */
export function templateSignature(t: TemplateSpec): string {
  return [
    `Genre: ${t.genre}.`,
    `Background: ${t.canvas.background}${t.canvas.effects ? `; ${t.canvas.effects}` : ''}.`,
    `Elements: ${[...t.layout].sort((a, b) => a.order - b.order).map((l) => `${l.element} (${l.position}; ${l.look})`).join(' | ')}.`,
    `Typography: ${t.typography}.`,
    `Text slots: ${t.slots.map((s) => s.role).join(', ')}.`,
  ].join('\n');
}

export async function imageDataUrl(path: string, max = 1024): Promise<string> {
  const buf = await sharp(await getMedia(path)).resize(max, max, { fit: 'inside' }).jpeg({ quality: 90 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

export async function extractTemplateSpec(imageUrl: string, projectId?: string | null): Promise<TemplateSpec> {
  return chatJson({
    model: env.visionModel, purpose: 'template:extract', projectId, temperature: 0, maxTokens: 5000,
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }, { type: 'text', text: EXTRACT_SHAPE }] as ContentPart[] },
    ],
  }, TemplateSpec);
}

const merit = (c: { ranking: any; impression_pct: number | null }) =>
  0.5 * (c.ranking?.score ?? 0) + 0.5 * (c.impression_pct == null ? 0.5 : 1 - c.impression_pct);

/**
 * Schede dei template per le immagini del prodotto (solo quelle mancanti) + raggruppamento dei template equivalenti.
 * `limit`: solo le prime N immagini per merito (per partire in fretta); senza limite, tutte.
 */
export async function buildTemplates(productId: string, jobId?: string, opts: { limit?: number } = {}) {
  const th = await getThresholds();
  const { data } = await db().from('jev_creatives').select('id, project_id, media_paths, ranking, impression_pct')
    .eq('product_id', productId).in('media_type', ['image', 'carousel']);
  const rows = (data ?? []).filter((c) => c.media_paths?.length && !c.ranking?.excluded).sort((a, b) => merit(b) - merit(a));
  const wanted = opts.limit ? rows.slice(0, opts.limit) : rows;
  const { data: have } = await db().from('jev_templates').select('creative_id').eq('product_id', productId);
  const done = new Set((have ?? []).map((t) => t.creative_id));
  const todo = wanted.filter((c) => !done.has(c.id));

  let n = 0, failed = 0;
  await pool(todo, 5, async (c) => {
    try {
      const spec = await extractTemplateSpec(await imageDataUrl(c.media_paths[0]), c.project_id);
      const signature = templateSignature(spec);
      const [vec] = await embed([signature], 'embed:template', c.project_id);
      await db().from('jev_templates').upsert({ product_id: productId, creative_id: c.id, spec, signature, embedding: toPg(vec), label: spec.name_it }, { onConflict: 'product_id,creative_id' });
    } catch (e) {
      failed++;
      console.warn(`[template] ${c.id}: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
    }
    await progress(jobId, `Schede dei template ${++n}/${todo.length}`);
  });

  await progress(jobId, 'Raggruppamento dei template per struttura grafica');
  const { data: all } = await db().from('jev_templates').select('id, creative_id, embedding, label').eq('product_id', productId);
  const items = (all ?? []).map((t) => ({ ...t, vec: parseVector(t.embedding) })).filter((t): t is typeof t & { vec: number[] } => !!t.vec);
  const clusters = averageLinkage(items.map((t) => t.vec), th.templateSimilarity);
  const byCreative = new Map(rows.map((c) => [c.id, c]));
  for (const cl of clusters) {
    const members = cl.map((i) => items[i]);
    const key = 't_' + crypto.createHash('sha256').update(members.map((m) => m.creative_id).sort().join(',')).digest('hex').slice(0, 10);
    // nome del gruppo = nome del template del membro migliore
    const best = [...members].sort((a, b) => merit(byCreative.get(b.creative_id) ?? { ranking: null, impression_pct: null }) - merit(byCreative.get(a.creative_id) ?? { ranking: null, impression_pct: null }))[0];
    await db().from('jev_templates').update({ group_key: key, label: best.label }).in('id', members.map((m) => m.id));
  }
  return { extracted: todo.length - failed, failed, templates: items.length, groups: clusters.length, sizes: clusters.map((c) => c.length).sort((a, b) => b - a).slice(0, 15) };
}

export type TemplateMember = {
  templateId: string; creativeId: string; impression_rank: number | null; impression_pct: number | null;
  score: number | null; merit: number; thumb: string | null;
};
export type TemplateGroup = {
  key: string; label: string; anchor: TemplateMember; members: TemplateMember[]; bestRank: number | null; merit: number;
};

/** Gruppi di template del prodotto, dal migliore (merito del suo membro migliore). Ancora = il membro migliore. */
export async function templateGroups(productId: string): Promise<TemplateGroup[]> {
  const { data: ts } = await db().from('jev_templates').select('id, creative_id, group_key, label').eq('product_id', productId).not('group_key', 'is', null);
  if (!ts?.length) return [];
  const { data: cs } = await db().from('jev_creatives').select('id, media_paths, impression_rank, impression_pct, ranking').in('id', ts.map((t) => t.creative_id));
  const cm = new Map((cs ?? []).map((c) => [c.id, c]));
  const groups = new Map<string, { label: string; members: TemplateMember[] }>();
  for (const t of ts) {
    const c = cm.get(t.creative_id);
    if (!c || c.ranking?.excluded) continue;
    const g = groups.get(t.group_key) ?? { label: t.label ?? 'Template', members: [] as TemplateMember[] };
    g.members.push({ templateId: t.id, creativeId: c.id, impression_rank: c.impression_rank, impression_pct: c.impression_pct, score: c.ranking?.score ?? null, merit: merit(c), thumb: c.media_paths?.[0] ?? null });
    groups.set(t.group_key, g);
  }
  return [...groups.entries()].map(([key, g]) => {
    const members = g.members.sort((a, b) => b.merit - a.merit);
    const ranks = members.map((m) => m.impression_rank).filter((r): r is number => r != null);
    return { key, label: g.label, anchor: members[0], members, bestRank: ranks.length ? Math.min(...ranks) : null, merit: members[0].merit };
  }).sort((a, b) => b.merit - a.merit || b.members.length - a.members.length);
}

/**
 * Template da usare in una generazione automatica: i migliori per merito, ma diversi tra loro. Si salta un template
 * troppo simile a uno già scelto: prima un formato e un genere grafico diversi, poi almeno un template diverso, poi il resto.
 * (I gruppi non bastano: tra i poster dello stesso genere la somiglianza è un continuo.)
 */
export async function pickDiverseTemplates(groups: TemplateGroup[], k: number): Promise<TemplateGroup[]> {
  const pool = groups.slice(0, 40);
  const { data } = await db().from('jev_templates').select('id, embedding').in('id', pool.length ? pool.map((g) => g.anchor.templateId) : ['00000000-0000-0000-0000-000000000000']);
  const vec = new Map((data ?? []).map((t) => [t.id, parseVector(t.embedding)]));
  // formato chiuso della scheda visiva (chat, notifica, poster…): la prosa della scheda varia anche a parità di grafica
  const { data: cs } = await db().from('jev_creatives').select('id, visual_features').in('id', pool.length ? pool.map((g) => g.anchor.creativeId) : ['00000000-0000-0000-0000-000000000000']);
  const format = new Map((cs ?? []).map((c) => [c.id, String(c.visual_features?.format ?? 'other')]));
  const picked: TemplateGroup[] = [];
  const passes = [{ limit: 0.87, newFormat: true }, { limit: 0.9, newFormat: false }, { limit: 1.01, newFormat: false }];
  for (const pass of passes) {
    for (const g of pool) {
      if (picked.length >= k) return picked;
      if (picked.includes(g)) continue;
      if (pass.newFormat && picked.some((p) => format.get(p.anchor.creativeId) === format.get(g.anchor.creativeId))) continue;
      const v = vec.get(g.anchor.templateId);
      const close = v && picked.some((p) => { const w = vec.get(p.anchor.templateId); return !!w && cosine(v, w) >= pass.limit; });
      if (!close) picked.push(g);
    }
  }
  return picked;
}

export async function loadTemplate(templateId: string) {
  const { data } = await db().from('jev_templates').select('id, creative_id, group_key, label, spec').eq('id', templateId).single();
  if (!data) throw new Error(`Template non trovato: ${templateId}`);
  const { data: c } = await db().from('jev_creatives').select('id, media_paths, impression_rank').eq('id', data.creative_id).single();
  return { ...data, spec: TemplateSpec.parse(data.spec), anchorPath: c?.media_paths?.[0] as string, anchorRank: c?.impression_rank as number | null };
}
