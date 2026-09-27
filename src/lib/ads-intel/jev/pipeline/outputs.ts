import crypto from 'node:crypto';
import { z } from 'zod';
import { brandContext, brandRules, latestPlaybook, loadProduct, modeInstructions } from '../brain';
import { db, must } from '../db';
import { env } from '../env';
import { dhash, hamming } from '../imagehash';
import { buildState, judge, norm, type Answers } from '../judge';
import { IMAGE_OUTPUT_GATE, IMAGE_QUALITY_WEIGHTS, imageEffectivenessQuestions, OUTPUT_QUALITY, POLICY_QUESTIONS, PRODUCT_FIDELITY, PROMPT_GATE, QUALITY_FIX, QUALITY_LABEL, QUALITY_WEIGHTS, qualityValue, TEXT_OUTPUT_GATE } from '../judge/questions';
import { progress } from '../jobs';
import { chatJson, embedOne, looseBool, looseString, looseStringArray, type ContentPart } from '../openrouter';
import { getThresholds, type Thresholds } from '../settings';
import { getMedia, signedUrl } from '../storage';
import { parseVector, toPg } from '../vectors';
import { fidelitySheet } from './concepts';
import { winnersFor, winnersFromIds } from './corpus';
import { compactFeatures, creativeFeatures, describeVisual, englishSheet, type VisualFeatures } from './visual';
import { distanceCheck, route, saveGate, type Distance, type GateResult } from './gate';

/* ---------- Schemi delle specifiche ---------- */

export const TextSpec = z.object({
  variants: z.array(z.object({
    primary_text: z.string().min(1),
    headline: z.string().max(40, 'headline oltre 40 caratteri'),
    description: z.string().max(30, 'description oltre 30 caratteri'),
    cta: z.enum(['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'ORDER_NOW', 'GET_OFFER', 'SUBSCRIBE', 'DOWNLOAD', 'BOOK_NOW', 'CONTACT_US']),
    claims: z.array(z.string()),
  })).min(1),
});

export const ImageSpec = z.object({
  aspect_ratio: z.literal('1:1'),
  prompt: z.string().min(80),
  subject: z.string(),
  setting: z.string(),
  composition: z.string(),
  product: z.object({ treatment: z.string() }),
  palette: z.array(z.string()),
  on_image_text: z.array(z.object({ text: z.string(), position: z.string(), style: z.string() })),
  logo: z.object({ required: z.boolean(), position: z.string(), variant: z.string() }),
  avoid: z.array(z.string()),
});

const Scene = z.object({
  id: z.string(),
  start_s: z.number().min(0),
  end_s: z.number().positive(),
  visual: z.string(),
  camera: z.string(),
  on_screen_text: z.string(),
  product_visible: z.boolean(),
  audio: z.object({ voiceover: z.string(), sfx: z.string().nullable() }),
});

export const VideoSpec = z.object({
  aspect_ratio: z.enum(['9:16', '4:5', '1:1']),
  duration_s: z.number().positive().max(180),
  sections: z.object({
    hook: z.object({ start_s: z.number(), end_s: z.number(), scenes: z.array(z.string()).min(1) }),
    message: z.object({ start_s: z.number(), end_s: z.number(), scenes: z.array(z.string()).min(1) }),
    visual_format: z.object({ type: z.string(), cut_rhythm: z.string(), production_level: z.string() }),
  }),
  scenes: z.array(Scene).min(2),
  audio: z.object({ voice: z.string(), music: z.string(), music_mood: z.string() }),
  cta: z.object({ start_s: z.number(), end_s: z.number(), text: z.string() }),
}).superRefine((v, ctx) => {
  const scenes = [...v.scenes].sort((a, b) => a.start_s - b.start_s);
  const ids = new Set(scenes.map((s) => s.id));
  for (const [i, s] of scenes.entries()) {
    if (s.end_s <= s.start_s) ctx.addIssue({ code: 'custom', message: `scena ${s.id}: end_s <= start_s` });
    if (i > 0 && s.start_s < scenes[i - 1].end_s - 0.01) ctx.addIssue({ code: 'custom', message: `scene ${scenes[i - 1].id} e ${s.id} si sovrappongono` });
    if (i > 0 && s.start_s > scenes[i - 1].end_s + 0.01) ctx.addIssue({ code: 'custom', message: `buco tra ${scenes[i - 1].id} e ${s.id}` });
  }
  if (scenes[0] && scenes[0].start_s > 0.01) ctx.addIssue({ code: 'custom', message: 'la prima scena deve partire da 0' });
  const last = scenes[scenes.length - 1];
  if (last && Math.abs(last.end_s - v.duration_s) > 0.5) ctx.addIssue({ code: 'custom', message: 'le scene devono coprire tutta la durata' });
  for (const sec of ['hook', 'message'] as const) {
    for (const id of v.sections[sec].scenes) if (!ids.has(id)) ctx.addIssue({ code: 'custom', message: `sections.${sec} punta a una scena inesistente: ${id}` });
  }
});

/* ---------- Creazione output ---------- */

const code = () => `JFC-${crypto.randomBytes(4).toString('hex')}`;

const specText = (kind: string, spec: any): string => {
  if (kind === 'text') return spec.variants.map((v: any, i: number) => `VARIANT ${i + 1}\nPrimary text: ${v.primary_text}\nHeadline: ${v.headline}\nDescription: ${v.description}\nCTA: ${v.cta}`).join('\n\n');
  if (kind === 'video') {
    return `VIDEO ${spec.aspect_ratio}, ${spec.duration_s}s\nFormat: ${spec.sections.visual_format.type}, ${spec.sections.visual_format.cut_rhythm}\n` +
      spec.scenes.map((s: any) => `[${s.start_s}-${s.end_s}s] ${s.visual} | camera: ${s.camera} | text: ${s.on_screen_text} | VO: ${s.audio.voiceover}`).join('\n') +
      `\nVoice: ${spec.audio.voice}. Music: ${spec.audio.music} (${spec.audio.music_mood})\nCTA: ${spec.cta.text}`;
  }
  return `${spec.prompt_full ?? spec.prompt}\nPalette: ${(spec.palette ?? []).join(', ')}`;
};

/**
 * Output già prodotti con cui confrontarsi per non ripetersi. Le versioni dello STESSO concept (v1, v2…, i due
 * modelli) sono escluse: devono somigliarsi, sono la stessa idea corretta.
 */
async function historyVectors(productId: string, excludeId?: string, conceptId?: string): Promise<number[][]> {
  const { data } = await db().from('jev_outputs').select('id, concept_id, embedding').eq('product_id', productId).order('created_at', { ascending: false }).limit(80);
  return (data ?? []).filter((o) => o.id !== excludeId && (!conceptId || o.concept_id !== conceptId)).map((o) => parseVector(o.embedding)).filter((v): v is number[] => !!v);
}

async function sourceVectors(concept: any): Promise<number[][]> {
  const refs = (concept.source_refs ?? []) as { creativeId: string; section?: string }[];
  const out: number[][] = [];
  for (const r of refs) {
    if (r.section) {
      const { data } = await db().from('jev_creative_sections').select('embedding').eq('creative_id', r.creativeId).eq('section', r.section).maybeSingle();
      const v = parseVector(data?.embedding); if (v) out.push(v);
    }
    const { data } = await db().from('jev_creatives').select('embedding').eq('id', r.creativeId).maybeSingle();
    const v = parseVector(data?.embedding); if (v) out.push(v);
  }
  return out;
}

type Kind = 'text' | 'image' | 'video';

type Loaded = Awaited<ReturnType<typeof loadContext>>;

export type OutputOpts = {
  language: string;
  variants?: number;
  /** modello che scrive l'output (per default: visivo per immagini e video, testo per il resto) */
  writerModel?: string;
  /** famiglia di stile: i suoi membri sono il riferimento per il giudizio di Jev */
  family?: { kind: string; key: string; label: string; memberIds: string[] };
  /** lotto di generazione (per default quello del concept) */
  batchId?: string;
};

async function loadContext(conceptId: string, language: string, o: Partial<OutputOpts> = {}) {
  const concept = must(await db().from('jev_concepts').select('*').eq('id', conceptId).single()) as any;
  const { product, project } = await loadProduct(concept.product_id);
  const playbook = await latestPlaybook(product.id);
  const winners = o.family?.memberIds.length ? await winnersFromIds(product.id, concept.kind, o.family.memberIds) : await winnersFor(product.id, concept.kind);
  const hasLogo = !!project.logo_path;
  const hasPhotos = product.image_paths.length > 0;
  const ctx = [
    `BRAND\n${brandContext(project, product)}`,
    `BRAND RULES\n${brandRules(project, product)}`,
    `OUR PRODUCT SHEET (the only source of product facts)\n${fidelitySheet(product, concept.dna)}`,
    modeInstructions(product),
    playbook ? `PLAYBOOK\n${playbook.text.slice(0, 5000)}` : '',
    `CONCEPT\nTitle: ${concept.title}\nGenotype: ${JSON.stringify(concept.genotype)}\nMutation: ${concept.mutation}\nBrief: ${concept.brief}${concept.adaptation ? `\nAdaptation: ${concept.adaptation}` : ''}`,
    winners.winning.length
      ? `WINNING ADS FOR THIS PRODUCT (what currently gets the most delivery — match their effectiveness: audience call-out, offer framing, native direct-response style; imitating their approach is fine)\n${winners.winning.slice(0, 3).join('\n---\n')}`
      : '',
    `LANGUAGE: write all copy, on-screen text and voiceover in "${language}".`,
    `BRAND NAME to show, if any: "${product.name}". Never invent other brand names, logos or seals.`,
  ].filter(Boolean).join('\n\n');
  const writerModel = o.writerModel ?? (concept.kind === 'text' ? env.writerModel : env.visualWriterModel);
  const family = o.family ? { kind: o.family.kind, key: o.family.key, label: o.family.label } : null;
  return { concept, product, project, playbook, ctx, kind: concept.kind as Kind, winners, hasLogo, hasPhotos, language, writerModel, family };
}

/** Scrive la specifica; con `revise` riscrive la precedente seguendo il giudizio. */
async function writeSpec(L: Loaded, opts: { variants?: number }, revise?: { previous: unknown; feedback: string[] }): Promise<any> {
  const { kind, ctx, project, product } = L;
  const revision = revise
    ? `\n\nPREVIOUS VERSION\n${JSON.stringify(revise.previous, null, 1).slice(0, 8000)}\n\nEVALUATION FEEDBACK (fix these, keep what already works, do not add product facts that are not in the product sheet)\n${revise.feedback.map((f) => `- ${f}`).join('\n')}\n\nReturn the full revised JSON in the same shape.`
    : '';
  if (kind === 'text') {
    return chatJson({
      model: L.writerModel, purpose: revise ? 'refine:text' : 'output:text', projectId: project.id, temperature: 0.8, maxTokens: 4000,
      messages: [
        { role: 'system', content: 'You write Meta ad copy that sounds like a person, not a brochure. The first 125 characters of primary_text must carry the hook. Headline max 40 characters, description max 30. List in claims every factual claim you make. Answer with one JSON object.' },
        { role: 'user', content: `${ctx}\n\nReturn JSON {variants:[{primary_text, headline, description, cta, claims[]}]} with ${opts.variants ?? 3} variants that all execute the same concept.${revision}` },
      ],
    }, TextSpec);
  }
  if (kind === 'image') {
    const sp = await chatJson({
      model: L.writerModel, purpose: revise ? 'refine:image' : 'output:image', projectId: project.id, temperature: 0.7, maxTokens: 3000,
      messages: [
        { role: 'system', content: 'You write image-generation specs to be pasted into ChatGPT. The "prompt" field is complete and self-contained, written in English, with subject, setting, composition, lighting, product treatment and any on-image text quoted exactly in the target language. Square 1:1 format. Answer with one JSON object.' },
        { role: 'user', content: `${ctx}\n\n${attachmentsNote(L)}\nReturn JSON {aspect_ratio:"1:1", prompt, subject, setting, composition, product{treatment}, palette[] (colour names), on_image_text[{text,position,style}], logo{required,position,variant}, avoid[]}.${revision}` },
      ],
    }, ImageSpec);
    const withRefs = { ...sp, reference_images: [...product.image_paths, ...(project.logo_path ? [project.logo_path] : [])] };
    return { ...withRefs, prompt_full: composeImagePrompt(withRefs, L) };
  }
  return chatJson({
    model: L.writerModel, purpose: revise ? 'refine:video' : 'output:video', projectId: project.id, temperature: 0.7, maxTokens: 6000,
    messages: [
      { role: 'system', content: 'You write shot-by-shot video ad specs for an editor. Scenes are contiguous from 0 to duration_s with no gaps or overlaps. The hook section covers the opening scenes that must stop the scroll; the message section covers the body; the CTA closes. Answer with one JSON object.' },
      { role: 'user', content: `${ctx}\n\nReturn JSON {aspect_ratio ("9:16" unless the format needs otherwise), duration_s, sections{hook{start_s,end_s,scenes[]}, message{start_s,end_s,scenes[]}, visual_format{type,cut_rhythm,production_level}}, scenes[{id,start_s,end_s,visual,camera,on_screen_text,product_visible,audio{voiceover,sfx}}], audio{voice,music,music_mood}, cta{start_s,end_s,text}}.${revision}` },
    ],
  }, VideoSpec);
}

function attachmentsNote(L: Loaded): string {
  const parts: string[] = [];
  parts.push(L.hasPhotos ? 'The user will attach the product photo: refer to it as "the attached product photo".' : 'There is NO product photo: do not refer to any attached image; describe any product element in words.');
  parts.push(L.hasLogo ? 'The user will attach the logo: refer to it as "the attached logo".' : `There is NO logo: set logo.required=false and do not ask for any logo, seal or badge. If a brand name must appear, use the text "${L.product.name}".`);
  parts.push('Every piece of on-image text must be written out EXACTLY inside the "prompt" field, in quotes, with its position — not only in on_image_text.');
  return parts.join('\n');
}

/**
 * Prompt da incollare in ChatGPT, composto nel codice: la descrizione del modello + il testo esatto da scrivere
 * sull'immagine + istruzioni su logo e allegati. Così nessun testo o marchio viene lasciato all'invenzione.
 */
export function composeImagePrompt(spec: any, L: Pick<Loaded, 'hasLogo' | 'hasPhotos' | 'product'>): string {
  const lines = [String(spec.prompt ?? '').trim(), '', 'Square 1:1 image.'];
  const texts = (spec.on_image_text ?? []) as { text: string; position: string; style: string }[];
  if (texts.length) {
    lines.push('', 'Render EXACTLY this text on the image, spelled exactly as written, no other text:');
    for (const t of texts) lines.push(`- "${t.text}" — ${t.position}${t.style ? `; ${t.style}` : ''}`);
  } else {
    lines.push('', 'No text on the image.');
  }
  if (L.hasLogo && spec.logo?.required) lines.push('', `Place the attached logo ${spec.logo.position}${spec.logo.variant ? ` (${spec.logo.variant})` : ''}. Do not alter it.`);
  else lines.push('', `Do not add any logo, seal, badge, watermark or brand name${texts.some((t) => t.text.includes(L.product.name)) ? ` other than the text "${L.product.name}" above` : ''}.`);
  if (L.hasPhotos) lines.push('Use the attached product photo as the exact product reference.');
  if (spec.avoid?.length) lines.push('', `Avoid: ${spec.avoid.join('; ')}.`);
  return lines.join('\n');
}

type Round = {
  round: number;
  score: number;
  dims: Record<string, number>;
  decision: GateResult['decision'];
  reasons: string[];
  warnings: string[];
  spec: any;
};

const DECISION_RANK = { pass: 2, review: 1, reject: 0 } as const;
const better = (a: Round, b: Round) => DECISION_RANK[a.decision] - DECISION_RANK[b.decision] || a.score - b.score;

/** Controllo (conformità) + qualità di una versione. */
async function evaluate(L: Loaded, outputId: string, spec: any, th: Thresholds): Promise<{ round: Omit<Round, 'round'>; gate: GateResult; distance: Distance; stage: 'prompt' | 'output'; vec: number[] }> {
  const { kind, product, project, concept, playbook } = L;
  const text = specText(kind, spec);
  const vec = await embedOne(text, 'embed:output', project.id);
  const distance = distanceCheck(vec, await sourceVectors(concept), await historyVectors(product.id, outputId, concept.id), th);
  const rules = brandRules(project, product);
  const fidelity = await judge({ type: 'output', id: outputId }, 'product_fidelity', buildState({ product_sheet: fidelitySheet(product, concept.dna), prompt: text }), PRODUCT_FIDELITY, project.id);
  let answers: Answers;
  let stage: 'prompt' | 'output';
  if (kind === 'image') {
    stage = 'prompt';
    answers = await judge({ type: 'output', id: outputId }, 'prompt_gate', buildState({ brand_rules: rules, prompt: text }), PROMPT_GATE, project.id);
  } else {
    stage = 'output';
    const state = buildState({ brand_rules: rules, description: text });
    answers = {
      ...(await judge({ type: 'output', id: outputId }, 'output_gate', state,
        project.tone.trim() ? TEXT_OUTPUT_GATE : Object.fromEntries(Object.entries(TEXT_OUTPUT_GATE).filter(([k]) => k !== 'tone_match')), project.id)),
      ...(await judge({ type: 'output', id: outputId }, 'policy', state, POLICY_QUESTIONS, project.id)),
    };
  }
  const gate = route({ ...answers, ...fidelity }, distance, th);
  const { dims, score } = await effectiveness(L, outputId, text, 'quality');
  return { round: { score, dims, decision: gate.decision, reasons: gate.reasons, warnings: gate.warnings, spec }, gate, distance, stage, vec };
}

/**
 * Efficacia secondo Jev, misurata rispetto ai vincenti e perdenti del corpus.
 * dims: 0..1 per dimensione; score: media pesata (QUALITY_WEIGHTS).
 */
async function effectiveness(L: Loaded, outputId: string, output: string, set: string) {
  const { product } = L;
  const en = await englishSheet(product, fidelitySheet(product, L.concept.dna));
  const q = await judge({ type: 'output', id: outputId }, set, buildState({
    audience: en.audience || '(not specified)',
    offer: en.sheet.slice(0, 5000),
    output,
  }, {
    winning_ads: L.winners.winning.length ? L.winners.winning : ['(no reference ads yet)'],
    losing_ads: L.winners.losing.length ? L.winners.losing : ['(no reference ads yet)'],
  }), OUTPUT_QUALITY, L.project.id);
  const dims = Object.fromEntries(Object.entries(q).map(([k, a]) => [k, Number(qualityValue(k, a).toFixed(3))]));
  const score = Object.entries(QUALITY_WEIGHTS).reduce((sum, [k, w]) => sum + w * (dims[k] ?? 0), 0);
  return { dims, score };
}

/** Cosa chiedere di correggere: dimensioni di efficacia deboli + motivi del controllo (non gli avvisi informativi). */
function feedbackFor(r: Omit<Round, 'round'>): string[] {
  const weak = Object.entries(r.dims).filter(([, v]) => v < 0.7).sort((a, b) => a[1] - b[1]);
  return [
    ...weak.map(([k, v]) => `${QUALITY_LABEL[k] ?? k} ${Math.round(v * 100)}/100 — ${QUALITY_FIX[k] ?? ''}`),
    ...r.reasons.map((x) => `Compliance check: ${x}`),
  ];
}

const needsWork = (r: Omit<Round, 'round'>, th: Thresholds) => r.score < th.outputQuality || r.decision !== 'pass';

const statusFor = (kind: Kind, decision: GateResult['decision']) =>
  decision === 'reject' ? 'rejected' : decision === 'review' ? 'review' : kind === 'image' ? 'awaiting_upload' : 'ready';

/**
 * Crea l'output e lo migliora: scrive → Jev valuta (controllo + qualità) → se la qualità è sotto soglia o il controllo
 * segnala problemi, Claude riscrive seguendo il giudizio. Al massimo `refineRounds` giri; si tiene la versione migliore.
 */
export async function createOutput(conceptId: string, opts: OutputOpts, jobId?: string) {
  const L = await loadContext(conceptId, opts.language, opts);
  const th = await getThresholds();

  await progress(jobId, `Scrittura della specifica ${L.kind}`);
  let spec = await writeSpec(L, opts);
  const row = must(await db().from('jev_outputs').insert({
    batch_id: opts.batchId ?? L.concept.batch_id ?? null,
    code: code(), concept_id: conceptId, product_id: L.product.id, kind: L.kind, language: opts.language,
    spec: { product_id: L.product.id, concept_id: conceptId, language: opts.language, genotype: L.concept.genotype, ...spec }, status: 'draft',
  }).select('id').single()) as { id: string };

  const rounds: Round[] = [];
  let best: { r: Round; gate: GateResult; distance: Distance; stage: 'prompt' | 'output'; vec: number[] } | null = null;
  for (let i = 0; i <= th.refineRounds; i++) {
    await progress(jobId, i === 0 ? 'Valutazione Jev' : `Miglioramento ${i}/${th.refineRounds}`);
    if (i > 0) spec = await writeSpec(L, opts, { previous: stripRefs(best!.r.spec), feedback: feedbackFor(best!.r) });
    const e = await evaluate(L, row.id, spec, th);
    const r: Round = { round: i + 1, ...e.round };
    rounds.push(r);
    if (!best || better(r, best.r) > 0) best = { r, gate: e.gate, distance: e.distance, stage: e.stage, vec: e.vec };
    if (!needsWork(best.r, th) || best.r.decision === 'reject' && best.gate.reject_kind === 'off_brand' && i >= 1) break;
  }
  await saveOutputResult(row.id, L, best!, rounds);
  return { outputId: row.id, decision: best!.r.decision, quality: Number(best!.r.score.toFixed(2)), rounds: rounds.length };
}

const stripRefs = (spec: any) => { const { reference_images: _r, ...rest } = spec ?? {}; return rest; };

async function saveOutputResult(outputId: string, L: Loaded, best: { r: Round; gate: GateResult; distance: Distance; stage: 'prompt' | 'output'; vec: number[] }, rounds: Round[]) {
  await saveGate({ type: 'output', id: outputId }, best.stage, best.gate, best.distance);
  await db().from('jev_outputs').update({
    spec: { product_id: L.product.id, concept_id: L.concept.id, language: L.language, genotype: L.concept.genotype, writer: L.writerModel, family: L.family, ...best.r.spec },
    embedding: toPg(best.vec),
    status: statusFor(L.kind, best.r.decision),
    quality: {
      score: best.r.score, dims: best.r.dims, best_round: best.r.round,
      rounds: rounds.map(({ spec: _s, ...rest }) => rest),
      versions: rounds.map((r) => ({ round: r.round, spec: stripRefs(r.spec) })),
    },
  }).eq('id', outputId);
}

/** "Migliora ancora": un giro in più di riscrittura sull'output esistente; si tiene solo se migliora. */
export async function refineOutput(outputId: string, jobId?: string) {
  const out = must(await db().from('jev_outputs').select('*').eq('id', outputId).single()) as any;
  if (out.spec?.mode === 'template') return (await import('./templateGen')).nextTemplateVersion(outputId, jobId);
  const fam = out.spec?.family ? { ...out.spec.family, memberIds: await (await import('./families')).familyMembers(out.product_id, out.spec.family.kind, out.spec.family.key) } : undefined;
  const L = await loadContext(out.concept_id, out.language, { writerModel: out.spec?.writer, family: fam });
  const th = await getThresholds();
  const variants = out.spec?.variants?.length;
  const prev: Round[] = out.quality?.rounds ?? [];
  const current: Omit<Round, 'round'> = out.quality
    ? { score: out.quality.score, dims: out.quality.dims, decision: prev.find((r) => r.round === out.quality.best_round)?.decision ?? 'review', reasons: prev.find((r) => r.round === out.quality.best_round)?.reasons ?? [], warnings: [], spec: out.spec }
    : (await evaluate(L, outputId, out.spec, th)).round;

  await progress(jobId, 'Riscrittura seguendo il giudizio');
  const img = out.quality?.image;
  const feedback = img
    ? [
        `The image generated from this prompt scored ${Math.round(img.score * 100)}/100 for effectiveness against the winning ads. Fix what made it weaker:`,
        ...Object.entries(img.dims as Record<string, number>).filter(([, v]) => v < 0.7).sort((a, b) => a[1] - b[1]).map(([k, v]) => `${QUALITY_LABEL[k] ?? k} ${Math.round(v * 100)}/100 — ${QUALITY_FIX[k] ?? ''}`),
        ...((img.differences ?? []) as string[]),
      ]
    : feedbackFor(current);
  const spec = await writeSpec(L, { variants }, { previous: stripRefs(out.spec), feedback: feedback.length ? feedback : ['Raise overall quality: sharper hook, clearer single message, more concrete details.'] });
  await progress(jobId, 'Valutazione Jev della nuova versione');
  const e = await evaluate(L, outputId, spec, th);
  const r: Round = { round: prev.length + 1, ...e.round };
  const rounds = [...prev.map((x) => ({ ...x, spec: null })), r] as Round[];
  const improved = better(r, { round: 0, ...current }) > 0;
  if (improved) {
    await saveOutputResult(outputId, L, { r, gate: e.gate, distance: e.distance, stage: e.stage, vec: e.vec }, rounds);
    await db().from('jev_outputs').update({ quality: { score: r.score, dims: r.dims, best_round: r.round, rounds: rounds.map(({ spec: _s, ...rest }) => rest), versions: [...(out.quality?.versions ?? []), { round: r.round, spec: stripRefs(spec) }] } }).eq('id', outputId);
  } else {
    await db().from('jev_outputs').update({ quality: { ...(out.quality ?? {}), rounds: rounds.map(({ spec: _s, ...rest }) => rest), versions: [...(out.quality?.versions ?? []), { round: r.round, spec: stripRefs(spec) }] } }).eq('id', outputId);
  }
  return { improved, before: Number(current.score.toFixed(2)), after: Number(r.score.toFixed(2)), decision: improved ? r.decision : current.decision };
}

/* ---------- Immagine generata in ChatGPT e ricaricata ---------- */

const UploadX = z.object({
  subject: looseString, composition: looseString,
  on_image_text: looseStringArray, dominant_colors_named: looseStringArray,
  logo: z.object({ present: looseBool, position: looseString, color: looseString, intact: looseBool, clear_space_ok: looseBool }),
  product_visible: looseBool, product_treatment: looseString, mood: looseString, description: looseString,
});

export async function analyzeUpload(outputId: string, jobId?: string) {
  const out = must(await db().from('jev_outputs').select('*').eq('id', outputId).single()) as any;
  if (out.spec?.mode === 'template') return (await import('./templateGen')).judgeTemplateUpload(outputId, jobId);
  if (!out.result_path) throw new Error('Nessuna immagine caricata');
  const { product, project } = await loadProduct(out.product_id);
  const th = await getThresholds();
  const buf = await getMedia(out.result_path);
  const url = await signedUrl(out.result_path);

  await progress(jobId, 'Descrizione dell\'immagine caricata');
  // Descrizione guidata dalle regole: domande puntuali, non una descrizione libera
  const d = await chatJson({
    model: env.visionModel, purpose: 'upload:describe', projectId: project.id, temperature: 0.1, maxTokens: 2000,
    messages: [
      { role: 'system', content: 'Describe this ad image literally, for a brand-compliance check. Name colours with plain names. Answer with one JSON object.' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url } },
          { type: 'text', text: `Brand rules to check against:\n${brandRules(project, product)}\n\nReturn JSON: subject, composition, on_image_text[] (exact), dominant_colors_named[], logo{present, position, color, intact (not cropped/distorted/recoloured), clear_space_ok}, product_visible, product_treatment, mood, description.` },
        ] as ContentPart[],
      },
    ],
  }, UploadX);
  const description = `Subject: ${d.subject}\nComposition: ${d.composition}\nOn-image text: ${d.on_image_text.join(' / ') || 'none'}\nDominant colours: ${d.dominant_colors_named.join(', ')}\nLogo: ${d.logo.present ? `${d.logo.position}, ${d.logo.color}, ${d.logo.intact ? 'intact' : 'altered'}, clear space ${d.logo.clear_space_ok ? 'ok' : 'violated'}` : 'absent'}\nProduct: ${d.product_visible ? d.product_treatment : 'not visible'}\nMood: ${d.mood}\n${d.description}`;

  const h = await dhash(buf);
  const concept = must(await db().from('jev_concepts').select('*').eq('id', out.concept_id).single()) as any;
  const srcIds = ((concept.source_refs ?? []) as { creativeId: string }[]).map((r) => r.creativeId);
  const { data: srcs } = await db().from('jev_creatives').select('dhashes').in('id', srcIds.length ? srcIds : ['00000000-0000-0000-0000-000000000000']);
  const allHashes = (srcs ?? []).flatMap((s) => s.dhashes ?? []);
  const imageHamming = allHashes.length ? Math.min(...allHashes.map((x: string) => hamming(h, x))) : null;

  const vec = await embedOne(description, 'embed:upload', project.id);
  const distance: Distance = { ...distanceCheck(vec, await sourceVectors(concept), [], th), imageHamming };

  // Controllo visivo diretto: il modello guarda le immagini insieme, non solo la descrizione
  await progress(jobId, 'Confronto visivo con logo e sorgenti');
  const visual = await visualChecks(url, project.logo_path, srcIds, project.id);
  distance.visualSimilarity = visual.maxSimilarity;

  await progress(jobId, 'Gate sull\'immagine');
  const state = buildState({ brand_rules: brandRules(project, product), description });
  // Si chiede solo ciò che il Brain definisce: senza logo, palette o tono non c'è nulla da confrontare
  const imageGate = Object.fromEntries(Object.entries(IMAGE_OUTPUT_GATE).filter(([k]) =>
    (k !== 'logo_correct' || !!project.logo_path) &&
    (k !== 'palette_on_brand' || project.palette.length > 0) &&
    (k !== 'tone_match' || !!project.tone.trim())));
  const answers = {
    ...(Object.keys(imageGate).length ? await judge({ type: 'output', id: outputId }, 'image_output_gate', state, imageGate, project.id) : {}),
    ...(await judge({ type: 'output', id: outputId }, 'policy', state, POLICY_QUESTIONS, project.id)),
  };
  const r = route(answers, distance, th);
  const toReview = (why: string) => { r.reasons.push(why); if (r.decision === 'pass') r.decision = 'review'; };
  if (visual.maxSimilarity != null && visual.maxSimilarity >= th.visualCopy) {
    r.decision = 'reject'; r.reject_kind = 'copy';
    r.reasons.push(`visivamente quasi uguale a una sorgente (${visual.maxSimilarity.toFixed(2)}): ${visual.similarityNote}`);
  } else if (visual.maxSimilarity != null && visual.maxSimilarity >= th.visualReview) {
    toReview(`molto simile a una sorgente (${visual.maxSimilarity.toFixed(2)}): ${visual.similarityNote}`);
  }
  if (visual.logo) {
    if (!visual.logo.present) toReview('logo assente rispetto al riferimento');
    else if (!visual.logo.same_as_reference || visual.logo.altered) toReview(`logo diverso o alterato rispetto al riferimento: ${visual.logo.note}`);
    else if (!visual.logo.clear_space_ok) toReview(`spazio di rispetto del logo non rispettato: ${visual.logo.note}`);
  } else if (!d.logo.intact && project.logo_rules) {
    toReview('logo non intatto (controllo descrittivo, nessun logo di riferimento caricato)');
  }
  await saveGate({ type: 'output', id: outputId }, 'output', r, distance);

  // Efficacia dell'immagine REALE: Jev sulla descrizione + confronto visivo con le immagini vincenti
  await progress(jobId, 'Efficacia dell\'immagine rispetto ai vincenti');
  const famUp = out.spec?.family ? { ...out.spec.family, memberIds: await (await import('./families')).familyMembers(out.product_id, out.spec.family.kind, out.spec.family.key) } : undefined;
  const L = await loadContext(out.concept_id, out.language, { family: famUp });
  const image = await judgeImageEffectiveness(L, outputId, url);
  await db().from('jev_outputs').update({
    visual_features: image.features,
    quality: { ...(out.quality ?? {}), image: { ...image.result, judged_at: new Date().toISOString() } },
  }).eq('id', outputId);

  // Ciclo: se l'immagine reale resta sotto la soglia, si prepara in automatico la versione successiva del prompt
  const generation = Number(out.spec?.generation ?? 1);
  const { count: children } = await db().from('jev_outputs').select('id', { count: 'exact', head: true }).eq('spec->>parent_id', outputId);
  if (image.result.score < th.imageTarget && generation < th.imageRounds && !children) {
    const { enqueue } = await import('../jobs');
    await enqueue('next_from_image', { outputId }, project.id);
  }

  await db().from('jev_outputs').update({
    result_description: d, result_dhash: h,
    status: r.decision === 'reject' ? 'rejected' : r.decision === 'review' ? 'review' : 'ready',
  }).eq('id', outputId);
  return { decision: r.decision };
}

/* ---------- Controlli visivi con le immagini a confronto ---------- */

const LogoCheck = z.object({
  present: z.boolean(), same_as_reference: z.boolean(), altered: z.boolean(),
  clear_space_ok: z.boolean(), note: z.string(),
});
const SimilarityCheck = z.object({
  sources: z.array(z.object({
    index: z.number(), same_composition: z.boolean(), same_subject_and_pose: z.boolean(),
    same_text_layout: z.boolean(), overall_similarity: z.number().min(0).max(1), note: z.string(),
  })),
});

/**
 * - Logo: l'immagine generata viene messa accanto al logo di riferimento (presente, identico, non alterato, spazio di rispetto).
 * - Copia: l'immagine generata viene messa accanto alle immagini sorgente (o al fotogramma dei video sorgente).
 */
async function visualChecks(uploadUrl: string, logoPath: string | null, sourceIds: string[], projectId: string) {
  let logo: z.infer<typeof LogoCheck> | null = null;
  if (logoPath) {
    logo = await chatJson({
      model: env.visionModel, purpose: 'upload:logo', projectId, temperature: 0, maxTokens: 800,
      messages: [
        { role: 'system', content: 'You check brand logo usage in an ad image against the reference logo. Be strict: a redrawn, misspelled, recoloured, distorted or cropped logo is altered. Answer with one JSON object.' },
        { role: 'user', content: [
          { type: 'text', text: 'Image 1 = the reference logo. Image 2 = the ad to check.' },
          { type: 'image_url', image_url: { url: await signedUrl(logoPath) } },
          { type: 'image_url', image_url: { url: uploadUrl } },
          { type: 'text', text: 'Return JSON: present (is the logo in the ad), same_as_reference (same mark and wording), altered (distorted, cropped, recoloured or redrawn), clear_space_ok (enough empty space around it), note.' },
        ] as ContentPart[] },
      ],
    }, LogoCheck).catch(() => null);
  }

  const { data: srcs } = await db().from('jev_creatives').select('media_type, media_paths, poster_path').in('id', sourceIds.length ? sourceIds : ['00000000-0000-0000-0000-000000000000']);
  const images = (srcs ?? []).flatMap((c) => (c.media_type === 'video' ? (c.poster_path ? [c.poster_path] : []) : (c.media_paths ?? []).slice(0, 2))).slice(0, 4);
  let maxSimilarity: number | null = null;
  let similarityNote = '';
  if (images.length) {
    const urls = await Promise.all(images.map((p: string) => signedUrl(p)));
    const sim = await chatJson({
      model: env.visionModel, purpose: 'upload:similarity', projectId, temperature: 0, maxTokens: 1500,
      messages: [
        { role: 'system', content: 'You judge whether a new ad image copies existing ads. Same idea executed differently is NOT a copy; same composition, subject pose, framing and text layout IS a copy. Answer with one JSON object.' },
        { role: 'user', content: [
          { type: 'text', text: `The FIRST image is the new ad. The next ${urls.length} images are source ads (index 1..${urls.length}).` },
          { type: 'image_url', image_url: { url: uploadUrl } },
          ...urls.map((u) => ({ type: 'image_url' as const, image_url: { url: u } })),
          { type: 'text', text: 'Return JSON {sources:[{index, same_composition, same_subject_and_pose, same_text_layout, overall_similarity (0 = unrelated, 1 = practically the same image), note}]}.' },
        ] as ContentPart[] },
      ],
    }, SimilarityCheck).catch(() => null);
    const top = sim?.sources.sort((a, b) => b.overall_similarity - a.overall_similarity)[0];
    if (top) { maxSimilarity = top.overall_similarity; similarityNote = top.note; }
  }
  return { logo, maxSimilarity, similarityNote };
}

/**
 * Efficacia dell'immagine reale, votata da JEV:
 * 1) Gemini compila una scheda neutra di caratteristiche visive per l'immagine nuova (e per vincenti/perdenti, in cache)
 * 2) Jev confronta le schede con domande piccole, con esempi dei vincenti nei livelli
 * 3) punteggio = media pesata nel codice; le correzioni nascono dalle dimensioni più deboli
 */
export async function judgeImageEffectiveness(L: Loaded, outputId: string, imageUrl: string) {
  const en = await englishSheet(L.product, fidelitySheet(L.product, L.concept.dna));
  const features = await describeVisual(imageUrl, L.project.id, en.audience);
  const winF = (await Promise.all(L.winners.winnerIds.slice(0, 5).map((id) => creativeFeatures(id, L.project.id, en.audience)))).filter((f): f is VisualFeatures => !!f);
  const losF = (await Promise.all(L.winners.loserIds.slice(0, 3).map((id) => creativeFeatures(id, L.project.id, en.audience)))).filter((f): f is VisualFeatures => !!f);
  const styleOf = (f: VisualFeatures) => [
    `format ${f.format}`, `reads as ${f.reads_as}`, `colour intensity ${f.color_intensity}`,
    f.patriotic_elements.length ? `patriotic: ${f.patriotic_elements.join(', ')}` : '',
    f.authority_elements.length ? `authority: ${f.authority_elements.join(', ')}` : '',
    f.fake_ui_elements.length ? `ui: ${f.fake_ui_elements.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  const questions = imageEffectivenessQuestions({
    firstSeen: winF.map((f) => f.first_thing_seen),
    headlines: winF.map((f) => f.headline.text),
    styles: winF.map(styleOf),
  });
  const q = await judge({ type: 'output', id: outputId }, 'image_effectiveness', buildState({
    audience: en.audience || '(not specified)',
    product_offer: en.sheet.slice(0, 4000),
    new_ad: JSON.stringify(compactFeatures(features)),
  }, {
    winning_ads: winF.length ? winF.map((f) => JSON.stringify(compactFeatures(f))) : ['(no reference ads yet)'],
    losing_ads: losF.length ? losF.map((f) => JSON.stringify(compactFeatures(f))) : ['(no reference ads yet)'],
  }), questions, L.project.id);
  const dims = Object.fromEntries(Object.entries(q).map(([k, a]) => [k, Number(qualityValue(k, a).toFixed(3))]));
  const score = Object.entries(IMAGE_QUALITY_WEIGHTS).reduce((s, [k, w]) => s + w * (dims[k] ?? 0), 0);
  const confidence = Object.fromEntries(Object.entries(q).map(([k, a]) => [k, Number(a.p.toFixed(2))]));

  // differenze concrete rispetto ai vincenti, per spiegare il voto e guidare la riscrittura
  const common = (xs: string[]) => [...new Set(xs)].filter((x) => xs.filter((y) => y === x).length >= Math.ceil(winF.length / 2));
  const winnerFormats = common(winF.map((f) => f.format));
  const diffs: string[] = [];
  if (winnerFormats.length && !winnerFormats.includes(features.format)) diffs.push(`Format: winners mostly use ${winnerFormats.join(' / ')}, this is ${features.format}.`);
  const avgH = winF.length ? winF.reduce((s, f) => s + (f.headline.height_share || 0), 0) / winF.length : 0;
  if (avgH && features.headline.height_share < avgH * 0.7) diffs.push(`Headline smaller than the winners (${Math.round(features.headline.height_share * 100)}% vs ~${Math.round(avgH * 100)}% of the height).`);
  const winPatriotic = winF.filter((f) => f.patriotic_elements.length).length;
  if (winPatriotic >= Math.ceil(winF.length / 2) && !features.patriotic_elements.length) diffs.push('Winners use patriotic elements; this has none.');
  const winUi = winF.filter((f) => f.fake_ui_elements.length).length;
  if (winUi >= Math.ceil(winF.length / 2) && !features.fake_ui_elements.length) diffs.push('Winners use interface elements (buttons, notifications, chat); this has none.');
  const avgWords = winF.length ? winF.reduce((s, f) => s + (f.text_amount.words || 0), 0) / winF.length : 0;
  if (avgWords && features.text_amount.words > avgWords * 1.6) diffs.push(`Much more text than the winners (${features.text_amount.words} words vs ~${Math.round(avgWords)}).`);

  const weak = Object.entries(dims).filter(([, v]) => v < 0.7).sort((a, b) => a[1] - b[1]);
  return {
    features,
    result: {
      score, dims, confidence, judged_by: 'jev', winners_compared: winF.length,
      differences: diffs,
      fix: [...weak.slice(0, 3).map(([k]) => QUALITY_FIX[k]).filter(Boolean), ...diffs],
    },
  };
}

/**
 * Versione successiva del prompt a partire dal giudizio di Jev sull'IMMAGINE REALE generata dalla versione
 * precedente. Crea un nuovo output collegato (v2, v3…): si genera l'immagine, si carica, viene rigiudicata.
 */
export async function nextFromImage(outputId: string, jobId?: string) {
  const out = must(await db().from('jev_outputs').select('*').eq('id', outputId).single()) as any;
  if (out.spec?.mode === 'template') return (await import('./templateGen')).nextTemplateVersion(outputId, jobId);
  const img = out.quality?.image;
  if (!img) throw new Error('Nessun giudizio sull\'immagine: carica prima il risultato.');
  const fam = out.spec?.family ? { ...out.spec.family, memberIds: await (await import('./families')).familyMembers(out.product_id, out.spec.family.kind, out.spec.family.key) } : undefined;
  const L = await loadContext(out.concept_id, out.language, { writerModel: out.spec?.writer, family: fam });
  const th = await getThresholds();
  const generation = Number(out.spec?.generation ?? 1) + 1;

  const dims = img.dims as Record<string, number>;
  const strong = Object.entries(dims).filter(([, v]) => v >= 0.85).map(([k]) => QUALITY_LABEL[k] ?? k);
  const feedback = [
    `The image generated from the previous prompt scored ${Math.round(img.score * 100)}/100 for effectiveness against the winning ads.`,
    strong.length ? `KEEP what works: ${strong.join(', ')}.` : '',
    ...Object.entries(dims).filter(([, v]) => v < 0.7).sort((a, b) => a[1] - b[1]).map(([k, v]) => `FIX ${QUALITY_LABEL[k] ?? k} (${Math.round(v * 100)}/100): ${QUALITY_FIX[k] ?? ''}`),
    ...((img.differences ?? []) as string[]).map((d) => `FIX vs winners: ${d}`),
    out.result_description?.on_image_text?.length ? `Text actually rendered in the previous image: ${JSON.stringify(out.result_description.on_image_text)}` : '',
  ].filter(Boolean);

  await progress(jobId, `Scrittura della versione ${generation} dal giudizio dell'immagine`);
  const spec = await writeSpec(L, { variants: out.spec?.variants?.length }, { previous: stripRefs(out.spec), feedback });
  const row = must(await db().from('jev_outputs').insert({
    batch_id: out.batch_id ?? null,
    code: code(), concept_id: out.concept_id, product_id: out.product_id, kind: out.kind, language: out.language,
    spec: { ...spec, generation, parent_id: out.id, parent_code: out.code }, status: 'draft',
  }).select('id').single()) as { id: string };

  await progress(jobId, 'Controllo della nuova versione');
  const e = await evaluate(L, row.id, spec, th);
  const r = { round: 1, ...e.round };
  await saveOutputResult(row.id, L, { r, gate: e.gate, distance: e.distance, stage: e.stage, vec: e.vec }, [r]);
  // saveOutputResult riscrive la spec: si rimettono i riferimenti alla versione precedente
  const { data: saved } = await db().from('jev_outputs').select('spec').eq('id', row.id).single();
  await db().from('jev_outputs').update({ spec: { ...(saved?.spec ?? {}), generation, parent_id: out.id, parent_code: out.code, from_image_feedback: feedback } }).eq('id', row.id);
  return { outputId: row.id, generation, parent: out.code, previousImageScore: Math.round(img.score * 100) };
}
