import crypto from 'node:crypto';
import { z } from 'zod';
import { brandContext, brandRules, loadProduct, modeInstructions } from '../brain';
import { db, must } from '../db';
import { env } from '../env';
import { buildState, judge } from '../judge';
import { HOOK_TEST_QUESTIONS, HOOK_TEST_WEIGHTS, HOOK_TYPES, PRODUCT_FIDELITY, QUALITY_FIX, qualityValue, TEXT_OUTPUT_GATE } from '../judge/questions';
import { progress } from '../jobs';
import { chatJson, looseNumber, looseString, looseStringArray } from '../openrouter';
import { getThresholds } from '../settings';
import { fidelitySheet, generateConcepts } from './concepts';
import { ensureCorpus } from './corpus';
import { familyMembers, imageFamilies, videoFamilies, type Family } from './families';
import { route, saveGate } from './gate';
import { createOutput } from './outputs';
import { englishSheet } from './visual';
import { createBatch } from '../batches';

export const WRITERS = {
  sonnet: 'anthropic/claude-sonnet-5',
  opus: 'anthropic/claude-opus-5.5',
} as const;

export type FamilyGenOpts = {
  kind: 'image' | 'video';
  familyKey: string;
  count: number;
  language: string;
  writers: (keyof typeof WRITERS)[];
};

async function findFamily(productId: string, kind: Family['kind'], key: string): Promise<Family> {
  const fams = kind === 'image' ? await imageFamilies(productId) : (await videoFamilies(productId))[kind === 'video_format' ? 'formats' : 'hooks'];
  const f = fams.find((x) => x.key === key);
  if (!f) throw new Error(`Famiglia non trovata: ${key}`);
  return f;
}

/**
 * Genera da UNA famiglia di stile: le sorgenti sono solo i suoi membri, il confronto di Jev è con i suoi vincenti,
 * e ogni concept produce un prompt per ciascun modello scelto (due "direttori artistici").
 * Video: le sezioni si ricombinano solo dentro la stessa famiglia di formato.
 */
export async function familyGenerate(productId: string, opts: FamilyGenOpts, jobId?: string) {
  await ensureCorpus(productId, jobId);
  const famKind: Family['kind'] = opts.kind === 'image' ? 'image' : 'video_format';
  const fam = await findFamily(productId, famKind, opts.familyKey);
  const sources = fam.members.slice(0, 5).map((m) => ({ creativeId: m.id }));
  const writersSel = opts.writers.length ? opts.writers : ['sonnet', 'opus'];
  const batchId = await createBatch(productId, 'family', `Stile "${fam.label}" · ${writersSel.join(' + ')}`, { ...opts, familyLabel: fam.label, sources: sources.map((s) => s.creativeId) });
  await progress(jobId, `Famiglia "${fam.label}": ${fam.members.length} ads, ${sources.length} sorgenti`);

  const g = await generateConcepts(productId, {
    kind: opts.kind,
    count: opts.count,
    sources,
    varyAxis: 'all',
    mutations: ['none'],
    combine: opts.kind === 'video' && sources.length >= 2,
    notes: `All concepts must stay inside the style family "${fam.label}": same visual language and format as its ads.`,
    batchId,
  }, jobId);

  const ids = g.conceptIds.length ? g.conceptIds : ['00000000-0000-0000-0000-000000000000'];
  const { data: concepts } = await db().from('jev_concepts').select('id, status').in('id', ids);
  const { data: gates } = await db().from('jev_gate_results').select('target_id, reject_kind').eq('target_type', 'concept').in('target_id', ids);
  const kind = new Map((gates ?? []).map((x) => [x.target_id, x.reject_kind]));
  const usable = (concepts ?? []).filter((c) => c.status !== 'reject' || kind.get(c.id) === 'weak');

  const writers = opts.writers.length ? opts.writers : (['sonnet', 'opus'] as const);
  const family = { kind: famKind, key: fam.key, label: fam.label, memberIds: fam.members.map((m) => m.id) };
  const done: { concept: string; writer: string; outputId?: string; error?: string }[] = [];
  for (const [i, c] of usable.entries()) {
    for (const w of writers) {
      await progress(jobId, `Concept ${i + 1}/${usable.length} · prompt ${w}`);
      try {
        const r = await createOutput(c.id, { language: opts.language, writerModel: WRITERS[w], family, batchId }, undefined);
        done.push({ concept: c.id, writer: w, outputId: r.outputId });
      } catch (e) {
        done.push({ concept: c.id, writer: w, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { family: fam.label, sources: sources.length, concepts: g.created, outputs: done.filter((d) => d.outputId).length, errors: done.filter((d) => d.error).map((d) => d.error) };
}

/* ---------- Test degli hook: stesso corpo, hook nuovi ---------- */

const HookScene = z.object({
  id: looseString, start_s: looseNumber, end_s: looseNumber, visual: looseString, camera: looseString,
  on_screen_text: looseString, audio: z.object({ voiceover: looseString, sfx: looseString.optional() }),
});
const HookSpec = z.object({
  body: z.object({
    summary: looseString,
    keep_from_s: looseNumber,
    adapted_script: looseString,
    notes: looseString,
  }),
  hooks: z.array(z.object({
    hook_type: z.preprocess((v) => String(v ?? '').toLowerCase(), z.enum(Object.keys(HOOK_TYPES) as [string, ...string[]]).catch('other')),
    duration_s: looseNumber,
    scenes: z.array(HookScene).min(1),
    transition_to_body: looseString,
    why: looseString,
  })).min(2),
});

const code = () => `JFC-${crypto.randomBytes(4).toString('hex')}`;
const hookText = (h: z.infer<typeof HookSpec>['hooks'][number]) =>
  `${h.hook_type}, ${h.duration_s}s\n` + h.scenes.map((s) => `[${s.start_s}-${s.end_s}s] ${s.visual} | text: ${s.on_screen_text} | VO: ${s.audio.voiceover}`).join('\n') + `\nTransition: ${h.transition_to_body}`;

/**
 * Test degli hook su un video vincente: si tiene il corpo (adattato ai fatti della nostra scheda) e si scrivono
 * N hook nuovi, di tipi diversi. Ogni hook è votato da Jev contro gli hook dei video vincenti. Output: solo JSON.
 */
export async function hookVariants(productId: string, opts: { creativeId: string; count: number; language: string; writer?: keyof typeof WRITERS }, jobId?: string) {
  await ensureCorpus(productId, jobId);
  const { product, project } = await loadProduct(productId);
  const th = await getThresholds();
  const src = must(await db().from('jev_creatives').select('id, impression_rank, description_en').eq('id', opts.creativeId).single()) as { id: string; impression_rank: number | null; description_en: string };
  const { data: secs } = await db().from('jev_creative_sections').select('section, text, start_s, end_s').eq('creative_id', src.id);
  const sec = (n: string) => secs?.find((s) => s.section === n);

  // hook dei video vincenti (per il confronto) — i migliori per impression, escluso quello di partenza
  const { formats } = await videoFamilies(productId);
  const all = formats.flatMap((f) => f.members).filter((m) => m.id !== src.id).sort((a, b) => (a.impression_pct ?? 1) - (b.impression_pct ?? 1)).slice(0, 6);
  const { data: winHooks } = await db().from('jev_creative_sections').select('creative_id, text').eq('section', 'hook').in('creative_id', all.length ? all.map((m) => m.id) : ['00000000-0000-0000-0000-000000000000']);

  const sheet = fidelitySheet(product, undefined);
  const count = Math.min(6, Math.max(2, opts.count));
  await progress(jobId, `Scrittura di ${count} hook`);
  const spec = await chatJson({
    model: WRITERS[opts.writer ?? 'opus'], purpose: 'hook_test', projectId: project.id, temperature: 0.9, maxTokens: 6000,
    messages: [
      {
        role: 'system',
        content: 'You write hook tests for a proven video ad: keep its body, write new openings. Each hook is 2-5 seconds, a different hook_type from the others, and must flow into the body. ' +
          'Every product fact must come from the product sheet. Write on-screen text and voiceover in the requested language. Answer with one JSON object.',
      },
      {
        role: 'user',
        content: [
          `BRAND\n${brandContext(project, product)}`,
          `BRAND RULES\n${brandRules(project, product)}`,
          `OUR PRODUCT SHEET\n${sheet}`,
          modeInstructions(product),
          `PROVEN VIDEO (#${src.impression_rank ?? '?'} by impressions)\n${src.description_en.slice(0, 5000)}`,
          sec('hook') ? `ITS CURRENT HOOK\n${sec('hook')!.text}` : '',
          `HOOK TYPES: ${Object.entries(HOOK_TYPES).map(([k, v]) => `${k} (${v})`).join('; ')}`,
          `LANGUAGE: ${opts.language}`,
          `Return JSON {body{summary, keep_from_s (second where the original body starts), adapted_script (the body voiceover adapted to our product sheet), notes}, hooks:[{hook_type, duration_s, scenes[{id,start_s,end_s,visual,camera,on_screen_text,audio{voiceover,sfx}}], transition_to_body, why}]} with ${count} hooks.`,
        ].filter(Boolean).join('\n\n'),
      },
    ],
  }, HookSpec);

  // concept "contenitore" del test (serve per collegare output ed esiti)
  const batchId = await createBatch(productId, 'hooks', `Test hook su #${src.impression_rank ?? '?'} · ${count} hook`, { ...opts, count });
  const concept = must(await db().from('jev_concepts').insert({
    batch_id: batchId, product_id: productId, kind: 'video', title: `Test hook su #${src.impression_rank ?? '?'}`,
    brief: spec.body.summary, dna: { ref: { creativeId: src.id } }, source_refs: [{ creativeId: src.id }],
    genotype: { format: 'hook_test' }, mutation: 'none', status: 'approved',
  }).select('id').single()) as { id: string };
  const out = must(await db().from('jev_outputs').insert({
    batch_id: batchId, code: code(), concept_id: concept.id, product_id: productId, kind: 'video', language: opts.language,
    spec: { mode: 'hook_test', source_creative: src.id, writer: WRITERS[opts.writer ?? 'opus'], ...spec }, status: 'draft',
  }).select('id').single()) as { id: string };

  // Jev: ogni hook contro gli hook vincenti
  const en = await englishSheet(product, sheet);
  const scored = [];
  for (const [i, h] of spec.hooks.entries()) {
    await progress(jobId, `Jev valuta l'hook ${i + 1}/${spec.hooks.length}`);
    const q = await judge({ type: 'output', id: out.id }, `hook_${i + 1}`, buildState({
      audience: en.audience || '(not specified)',
      product_offer: en.sheet.slice(0, 3000),
      body: `${spec.body.summary}\n${spec.body.adapted_script}`.slice(0, 3000),
      hook: hookText(h),
    }, { winning_hooks: (winHooks ?? []).map((w) => w.text) }), HOOK_TEST_QUESTIONS, project.id);
    const dims = Object.fromEntries(Object.entries(q).map(([k, a]) => [k, Number(qualityValue(k, a).toFixed(3))]));
    const score = Object.entries(HOOK_TEST_WEIGHTS).reduce((s, [k, w]) => s + w * (dims[k] ?? 0), 0);
    const weak = Object.entries(dims).filter(([, v]) => v < 0.7).map(([k]) => QUALITY_FIX[k]).filter(Boolean);
    scored.push({ index: i + 1, hook_type: h.hook_type, score, dims, fix: weak });
  }

  // controlli su tutto il testo del test (fedeltà al prodotto, regole del brand)
  const allText = [spec.body.adapted_script, ...spec.hooks.map(hookText)].join('\n\n');
  const answers = {
    ...(await judge({ type: 'output', id: out.id }, 'output_gate', buildState({ brand_rules: brandRules(project, product), description: allText.slice(0, 12000) }),
      project.tone.trim() ? TEXT_OUTPUT_GATE : Object.fromEntries(Object.entries(TEXT_OUTPUT_GATE).filter(([k]) => k !== 'tone_match')), project.id)),
    ...(await judge({ type: 'output', id: out.id }, 'product_fidelity', buildState({ product_sheet: sheet, prompt: allText.slice(0, 12000) }), PRODUCT_FIDELITY, project.id)),
  };
  const r = route(answers, null, th);
  await saveGate({ type: 'output', id: out.id }, 'output', r, null);
  const best = [...scored].sort((a, b) => b.score - a.score)[0];
  await db().from('jev_outputs').update({
    status: r.decision === 'reject' ? 'rejected' : r.decision === 'review' ? 'review' : 'ready',
    quality: { score: best.score, dims: best.dims, best_round: 1, rounds: [{ round: 1, score: best.score, decision: r.decision, reasons: r.reasons }], hooks: scored },
  }).eq('id', out.id);
  return { outputId: out.id, hooks: scored.map((s) => ({ hook: s.index, type: s.hook_type, score: Math.round(s.score * 100) })), decision: r.decision };
}

export { familyMembers };
