import { z } from 'zod';
import { brandContext, brandRules, latestPlaybook, loadProduct, modeInstructions, productSheet } from '../brain';
import { db, must } from '../db';
import { env } from '../env';
import { buildState, judge } from '../judge';
import { ANGLES, AWARENESS, FORMATS, HOOK_TYPES, PRODUCT_FIDELITY, PROMPT_GATE } from '../judge/questions';
import { progress } from '../jobs';
import { chatJson, embed } from '../openrouter';
import { getThresholds } from '../settings';
import type { Product } from '../types';
import { mmr, parseVector, toPg } from '../vectors';
import { distanceCheck, route, saveGate } from './gate';

export const AXES = ['hook_type', 'angle', 'format', 'avatar', 'awareness', 'setting'] as const;
export type Axis = (typeof AXES)[number];

export const MUTATIONS = {
  none: 'Nessuna mutazione: applica il DNA così com\'è al nostro prodotto',
  change_avatar: 'Cambia avatar: stesso hook, persona diversa (età, situazione, obiezione)',
  change_awareness: 'Cambia livello di consapevolezza (es. da problem-aware a unaware)',
  invert_angle: 'Inverti l\'angolo: da guadagno a rischio, o viceversa',
  transfer_format: 'Trasferisci il formato da un brand adiacente',
  raise_narrative: 'Alza il livello narrativo: da demo a storia',
} as const;
export type Mutation = keyof typeof MUTATIONS;

const DnaSchema = z.object({
  benefit_promise: z.string(),
  hook_mechanic: z.string(),
  emotional_lever: z.string(),
  message_structure: z.string(),
  format_and_rhythm: z.string(),
  visual_style: z.string().default(''),
  why_it_works: z.string(),
  source_product_specifics: z.array(z.string()),
  surface_to_avoid: z.array(z.string()),
});
export type Dna = z.infer<typeof DnaSchema>;

const keys = <T extends object>(o: T) => Object.keys(o) as [string, ...string[]];

const ConceptSchema = z.object({
  concepts: z.array(z.object({
    title: z.string(),
    dna_ref: z.string(),
    mutation: z.enum(keys(MUTATIONS)),
    genotype: z.object({
      hook_type: z.enum(keys(HOOK_TYPES)),
      angle: z.enum(keys(ANGLES)),
      format: z.enum(keys(FORMATS)),
      avatar: z.string(),
      awareness: z.enum(keys(AWARENESS)),
      setting: z.string(),
    }),
    brief: z.string(),
    adaptation: z.string(),
  })),
});

export type SourceRef = { creativeId: string; section?: 'hook' | 'message' | 'visual_format' };

/** Astrae il meccanismo di una creatività (o di una sua sezione). Chi genera vede solo questo, mai la sorgente. */
export async function extractDna(ref: SourceRef, projectId: string, product: Product): Promise<Dna> {
  const c = must(await db().from('jev_creatives').select('id, description_en').eq('id', ref.creativeId).single()) as { id: string; description_en: string };
  let focus = '';
  if (ref.section) {
    const { data: s } = await db().from('jev_creative_sections').select('text').eq('creative_id', ref.creativeId).eq('section', ref.section).maybeSingle();
    focus = `\nFOCUS ONLY ON THIS SECTION (${ref.section}):\n${s?.text ?? ''}`;
  }
  return chatJson({
    model: env.writerModel, purpose: 'dna', projectId, temperature: 0.2, maxTokens: 1500,
    messages: [
      {
        role: 'system',
        content: 'Extract the creative DNA of an ad: the transferable mechanism, stripped of all surface. Describe mechanics in abstract terms ' +
          '(e.g. "first-person confession that reframes a daily habit as the cause"), never the exact words, people, setting, visuals or claims. ' +
          'visual_style describes the transferable look: layout, typography, colour intensity, design genre (e.g. "bold direct-response graphic, huge two-line headline, fake approval buttons", "native UGC selfie with burned-in captions"). ' +
          'Separate what is transferable from what belongs to the advertised product: benefit_promise is the desire/result promised (transferable); ' +
          'source_product_specifics lists the advertised product\'s own mechanism, ingredients, features, proof, numbers and offer. ' +
          'List in surface_to_avoid the specific phrases, visuals and claims that must NOT be reused. Answer with one JSON object.',
      },
      {
        role: 'user',
        content: `${product.source_mode === 'same_product' ? 'The ad promotes the same product we sell.' : 'The ad promotes a different product with the same benefit as ours.'}\n\n` +
          `AD\n${c.description_en}${focus}\n\nReturn JSON: benefit_promise, hook_mechanic, emotional_lever, message_structure, format_and_rhythm, visual_style, why_it_works, source_product_specifics[], surface_to_avoid[].`,
      },
    ],
  }, DnaSchema);
}

/** In modalità "stesso prodotto" i fatti usati dalle ads sorgente valgono anche per noi. */
export function fidelitySheet(product: Product, dna?: Pick<Dna, 'source_product_specifics'>): string {
  const sheet = productSheet(product);
  if (product.source_mode !== 'same_product' || !dna?.source_product_specifics?.length) return sheet;
  return `${sheet}\n\nFacts about this same product used in its existing ads:\n${dna.source_product_specifics.map((x) => `- ${x}`).join('\n')}`;
}

export type GenerateOpts = {
  kind: 'text' | 'image' | 'video';
  count: number;
  sources: SourceRef[];
  varyAxis: Axis | 'all';
  mutations: Mutation[];
  notes?: string;
  /** Remix: ogni concept combina un hook, un messaggio e un formato presi (se possibile) da ads diverse. */
  combine?: boolean;
  /** lotto di generazione a cui appartengono i concept */
  batchId?: string;
};

const SECTION_NAME = { hook: 'hook', message: 'message', visual_format: 'visual format' } as const;

/** Numeri delle DNA citate in dna_ref ("D1", "D1+D4+D6"). */
export const parseRefs = (ref: string, max: number) =>
  [...new Set((ref.match(/\d+/g) ?? []).map(Number).filter((n) => n >= 1 && n <= max))];

export async function generateConcepts(productId: string, opts: GenerateOpts, jobId?: string) {
  const { product, project } = await loadProduct(productId);
  const th = await getThresholds();
  const playbook = await latestPlaybook(productId);
  if (!opts.sources.length) throw new Error('Seleziona almeno una creatività o sezione sorgente.');
  if (opts.combine && opts.sources.length < 2) throw new Error('Per il remix servono almeno due sorgenti (ads o sezioni).');

  // Assi già "provati" delle sorgenti (giudicati da Jev) e loro posizione per impression
  const srcIds = [...new Set(opts.sources.map((s) => s.creativeId))];
  const { data: srcInfo } = await db().from('jev_creatives').select('id, impression_rank, media_type, extraction').in('id', srcIds);
  const { data: srcSecs } = await db().from('jev_creative_sections').select('creative_id, section, ranking').in('creative_id', srcIds);
  const proven = (id: string) => {
    const sec = (n: string) => srcSecs?.find((x) => x.creative_id === id && x.section === n)?.ranking ?? {};
    const info = srcInfo?.find((x) => x.id === id);
    return Object.fromEntries(Object.entries({
      impression_rank: info?.impression_rank ?? null,
      hook_type: sec('hook').hook_type, angle: sec('message').angle, awareness: sec('message').awareness_level,
      format: sec('visual_format').format ?? (info?.extraction as any)?.format_guess,
    }).filter(([, v]) => v != null && v !== ''));
  };

  await progress(jobId, `Estrazione DNA da ${opts.sources.length} sorgenti`);
  const dnas: { ref: SourceRef; dna: Dna }[] = [];
  for (const ref of opts.sources) dnas.push({ ref, dna: await extractDna(ref, project.id, product) });

  const { data: hist } = await db().from('jev_concepts').select('genotype, embedding').eq('product_id', productId).order('created_at', { ascending: false }).limit(60);
  const historyGenotypes = (hist ?? []).map((h) => JSON.stringify(h.genotype)).slice(0, 30);

  const adLetters = new Map<string, string>();
  const letter = (id: string) => { if (!adLetters.has(id)) adLetters.set(id, String.fromCharCode(65 + adLetters.size)); return adLetters.get(id)!; };
  const combine = !!opts.combine && dnas.length >= 2;

  // Il generatore non vede mai la superficie della sorgente. In modalità "stesso beneficio" non vede
  // nemmeno i fatti del prodotto sorgente: al loro posto usa la nostra scheda prodotto.
  const dnaText = dnas.map((d, i) => {
    const { surface_to_avoid: _surface, source_product_specifics, ...mech } = d.dna;
    const base = { ...mech, proven_axes: proven(d.ref.creativeId) };
    const payload = product.source_mode === 'same_product' ? { ...base, product_facts_used_by_source: source_product_specifics } : base;
    const label = d.ref.section ? `${SECTION_NAME[d.ref.section]} only` : 'whole ad: can supply hook, message or format';
    return `D${i + 1} (source ad ${letter(d.ref.creativeId)}, ${label}): ${JSON.stringify(payload)}`;
  }).join('\n');
  const enumText = (name: string, o: Record<string, string>) => `${name}: ${Object.entries(o).map(([k, v]) => `${k} (${v})`).join('; ')}`;
  const allowedMutations = opts.mutations.length ? opts.mutations : (['none'] as Mutation[]);
  const want = Math.max(opts.count * 2, opts.count + 4);

  await progress(jobId, `Generazione di ${want} candidati`);
  const out = await chatJson({
    model: env.writerModel, purpose: 'concepts', projectId: project.id, temperature: 0.9, maxTokens: 8000,
    messages: [
      {
        role: 'system',
        content: `You design new ${opts.kind} ad concepts for a brand. You receive abstract creative DNA (mechanisms), never the original ads. ` +
          (combine
            ? 'REMIX MODE: build each concept by combining exactly one HOOK, one MESSAGE and one VISUAL FORMAT taken from different DNAs (prefer different source ads), applied to OUR product, optionally transformed by an allowed mutation. The three parts must fit together as one coherent ad. Set dna_ref to the DNAs used, e.g. "D1+D4+D6". '
            : 'Build each concept from one DNA applied to OUR product, optionally transformed by an allowed mutation. ') +
          'Effectiveness comes first: the sources are ads that currently get the most delivery. Keep what makes them work — their proven_axes (hook type, angle, format), their visual_style and their audience call-out — unless a mutation or the variation instruction requires a change. ' +
          'Concepts in the batch must still differ from each other in execution; do not produce near-duplicates. ' +
          'The brief describes what the ad does, shows and says in 4-8 sentences, specific enough to produce. ' +
          'Every product fact in the brief must come from OUR PRODUCT SHEET (in SAME PRODUCT mode also from product_facts_used_by_source). In "adaptation" state in one or two sentences what you kept from the DNA and what you replaced with our product. Answer with one JSON object.',
      },
      {
        role: 'user',
        content: [
          `BRAND\n${brandContext(project, product)}`,
          `BRAND RULES\n${brandRules(project, product)}`,
          `OUR PRODUCT SHEET\n${productSheet(product)}`,
          modeInstructions(product),
          `PLAYBOOK\n${playbook?.text ?? '(none yet)'}`,
          `DNA\n${dnaText}`,
          `AXES\n${enumText('hook_type', HOOK_TYPES)}\n${enumText('angle', ANGLES)}\n${enumText('format', FORMATS)}\n${enumText('awareness', AWARENESS)}\navatar: free text (who the ad speaks to)\nsetting: free text (where it happens)`,
          opts.varyAxis === 'all'
            ? `VARIATION: vary all axes. No axis value may appear more than ${th.maxPerAxisValue} times in the batch.`
            : `VARIATION: this is a single-axis test. Keep every axis identical across concepts EXCEPT "${opts.varyAxis}", which must take a different value in each concept.`,
          `ALLOWED MUTATIONS\n${allowedMutations.map((m) => `${m}: ${MUTATIONS[m]}`).join('\n')}`,
          historyGenotypes.length ? `ALREADY PRODUCED (avoid repeating these genotypes)\n${historyGenotypes.join('\n')}` : '',
          opts.notes ? `NOTES FROM THE USER\n${opts.notes}` : '',
          `Return JSON {concepts:[{title, dna_ref (${combine ? `"Dx+Dy+Dz" using D1..D${dnas.length}` : `"D1".."D${dnas.length}"`}), mutation, genotype{hook_type,angle,format,avatar,awareness,setting}, brief, adaptation}]} with ${want} concepts.`,
        ].filter(Boolean).join('\n\n'),
      },
    ],
  }, ConceptSchema);

  // Copertura nel codice: nessun valore di un asse variato oltre il massimo per batch
  const varied: Axis[] = opts.varyAxis === 'all' ? [...AXES] : [opts.varyAxis];
  const counts: Record<string, number> = {};
  const covered = out.concepts.filter((c) => {
    const k = varied.map((a) => `${a}=${String(c.genotype[a]).toLowerCase()}`);
    const cap = opts.varyAxis === 'all' ? th.maxPerAxisValue : 1;
    if (k.some((x) => (counts[x] ?? 0) >= cap)) return false;
    k.forEach((x) => (counts[x] = (counts[x] ?? 0) + 1));
    return true;
  });

  await progress(jobId, 'Controllo distanza e diversità');
  const vecs = await embed(covered.map((c) => `${c.title}\n${JSON.stringify(c.genotype)}\n${c.brief}`), 'embed:concept', project.id);
  const { data: srcRows } = await db().from('jev_creatives').select('id, embedding').in('id', opts.sources.map((s) => s.creativeId));
  const srcVec = new Map((srcRows ?? []).map((r) => [r.id, parseVector(r.embedding)]));
  const historyVecs = (hist ?? []).map((h) => parseVector(h.embedding)).filter((v): v is number[] => !!v);

  const scored = covered.map((c, i) => {
    const refs = parseRefs(c.dna_ref, dnas.length);
    const parts = (refs.length ? refs : [1]).map((n) => dnas[n - 1]);
    const sv = parts.map((p) => srcVec.get(p.ref.creativeId)).filter((v): v is number[] => !!v);
    const distance = distanceCheck(vecs[i], sv, historyVecs, th);
    return { c, parts, vec: vecs[i], distance };
  })
    // in remix un concept deve davvero combinare almeno due DNA
    .filter((x) => !combine || x.parts.length >= 2)
    .filter((x) => x.distance.status !== 'copy');

  const picked = mmr(scored.map((x) => ({ item: x, vec: x.vec, score: x.distance.status === 'lost' ? 0.6 : 1 })), opts.count);

  const created: string[] = [];
  for (const [i, x] of picked.entries()) {
    await progress(jobId, `Gate sul concept ${i + 1}/${picked.length}`);
    const dna = x.parts.length === 1
      ? { ...x.parts[0].dna, ref: x.parts[0].ref }
      : {
          combined: true,
          parts: x.parts.map((p) => ({ ...p.dna, ref: p.ref })),
          source_product_specifics: x.parts.flatMap((p) => p.dna.source_product_specifics),
        };
    const row = must(await db().from('jev_concepts').insert({
      product_id: productId, batch_id: opts.batchId ?? null, kind: opts.kind, title: x.c.title, brief: x.c.brief,
      dna, genotype: x.c.genotype, mutation: x.c.mutation, adaptation: x.c.adaptation,
      source_refs: x.parts.map((p) => p.ref), distance: x.distance, embedding: toPg(x.vec),
    }).select('id').single()) as { id: string };
    const prompt = `${x.c.title}\n${x.c.brief}`;
    const answers = {
      ...(await judge({ type: 'concept', id: row.id }, 'prompt_gate', buildState({ brand_rules: brandRules(project, product), prompt }), PROMPT_GATE, project.id)),
      ...(await judge({ type: 'concept', id: row.id }, 'product_fidelity', buildState({ product_sheet: fidelitySheet(product, dna), prompt }), PRODUCT_FIDELITY, project.id)),
    };
    // un concept è un brief: basta che sia usabile; il prompt completo e il suo controllo arrivano con l'output
    const r = route(answers, x.distance, th, { brief_completeness: { minScore: 1 } });
    await saveGate({ type: 'concept', id: row.id }, 'prompt', r, x.distance);
    await db().from('jev_concepts').update({ status: r.decision }).eq('id', row.id);
    created.push(row.id);
  }
  return { candidates: out.concepts.length, afterCoverage: covered.length, afterDistance: scored.length, created: created.length, conceptIds: created };
}
