import crypto from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { brandRules, loadProduct, modeInstructions } from '../brain';
import { createBatch } from '../batches';
import { db, must } from '../db';
import { env } from '../env';
import { buildState, judge } from '../judge';
import {
  ANGLES, imageEffectivenessQuestions, OUTPUT_QUALITY, POLICY_QUESTIONS, PRODUCT_FIDELITY, QUALITY_FIX, QUALITY_LABEL,
  QUALITY_WEIGHTS, qualityValue,
} from '../judge/questions';
import { enqueue, progress } from '../jobs';
import { chatJson, embed, generateImage, looseBool, looseNumber, looseString, looseStringArray, type ContentPart } from '../openrouter';
import { pool } from '../pool';
import { getThresholds, type Thresholds } from '../settings';
import { putMedia } from '../storage';
import { mmr, toPg } from '../vectors';
import { fidelitySheet } from './concepts';
import { ensureCorpus, winnersFor } from './corpus';
import { route, saveGate } from './gate';
import { buildTemplates, imageDataUrl, loadTemplate, pickDiverseTemplates, templateGroups, type TemplateGroup, type TemplateSpec } from './templates';
import { compactFeatures, creativeFeatures, describeVisual, englishSheet, type VisualFeatures } from './visual';

/**
 * Creatività da template: la grafica è fissa (una ad vincente), cambiano solo i testi.
 * La varietà nasce tra le immagini (template diversi × messaggi con angoli diversi), mai dentro la stessa immagine.
 *
 * 1. template migliori per merito (posizione per impression + giudizio di Jev), uno per gruppo
 * 2. per ogni template: Opus e Sonnet scrivono i testi degli spazi con angoli diversi; Jev li vota; restano i migliori
 *    e diversi tra loro (MMR); i deboli vengono riscritti una volta seguendo il giudizio
 * 3. prompt composto nel codice dalla scheda del template → immagine
 * 4. Gemini confronta l'immagine con la ad di riferimento (fedeltà e testi esatti): se non va, si rigenera con le correzioni
 * 5. Jev vota l'efficacia dell'immagine; sotto soglia si prepara una versione migliorata dei testi
 */

export type TemplateRunOpts = {
  templates: number;       // quanti template usare (i migliori), se non se ne sceglie uno
  perTemplate: number;     // creatività per template
  language: string;
  groupKey?: string;       // un template scelto dall'utente
  images: boolean;         // genera anche le immagini (altrimenti solo i prompt per ChatGPT)
};

const ANGLE_KEYS = Object.keys(ANGLES).filter((k) => k !== 'other');
const code = () => `JFC-${crypto.randomBytes(4).toString('hex')}`;

/** Pesi dell'efficacia dell'immagine in modalità template: lo stile lo misura la fedeltà al template, non Jev. */
export const TEMPLATE_IMAGE_WEIGHTS: Record<string, number> = {
  thumb_stop: 0.2, audience_callout: 0.15, offer_clarity: 0.15, offer_desirability: 0.15, vs_winners: 0.15, cta_urgency: 0.1, readability: 0.1,
};

/* ---------- Contesto comune a una generazione ---------- */

async function loadRunContext(productId: string) {
  const { product, project } = await loadProduct(productId);
  const th = await getThresholds();
  const sheet = fidelitySheet(product, undefined);
  const en = await englishSheet(product, sheet);
  const winners = await winnersFor(productId, 'image');
  const [winF, losF] = await Promise.all([
    Promise.all(winners.winnerIds.slice(0, 5).map((id) => creativeFeatures(id, project.id, en.audience))),
    Promise.all(winners.loserIds.slice(0, 3).map((id) => creativeFeatures(id, project.id, en.audience))),
  ]);
  // messaggi provati: titoli e promesse delle ads con più impression (per trapiantarli su altri template)
  const { data: top } = await db().from('jev_creatives').select('id, impression_rank, impression_pct, ranking, visual_features, bodies, media_type')
    .eq('product_id', productId).not('impression_rank', 'is', null).order('impression_pct', { ascending: true }).limit(40);
  const proven = (top ?? []).filter((c) => !c.ranking?.excluded).slice(0, 12).map((c) => {
    const f = c.visual_features as VisualFeatures | null;
    const line = f?.headline?.text || String(c.bodies?.[0] ?? '').split('\n')[0];
    return line ? `#${c.impression_rank} (${c.media_type}): ${line.slice(0, 200)}${f?.offer_statement ? ` — promise: ${f.offer_statement.slice(0, 160)}` : ''}` : '';
  }).filter(Boolean);
  return {
    product, project, th, sheet, en, winners, provenMessages: proven,
    winF: winF.filter((f): f is VisualFeatures => !!f), losF: losF.filter((f): f is VisualFeatures => !!f),
  };
}
type RunCtx = Awaited<ReturnType<typeof loadRunContext>>;

/* ---------- Testi degli spazi ---------- */

const Copy = z.object({
  variants: z.array(z.object({ angle: looseString, slots: z.record(z.string(), looseString), why: looseString })),
});
type Candidate = { angle: string; slots: Record<string, string>; why: string; writer: string };

const WRITER_SYSTEM = 'You write the on-image text for a proven ad template. The design is fixed and will be rebuilt exactly: you only fill its text slots. ' +
  'Keep each slot\'s role, casing and length (within about 30% of its current word count); a button stays a short button label. ' +
  'The first text the eye reads must name or unmistakably signal the audience. Every product fact must come from OUR PRODUCT SHEET. ' +
  'The words must be true: the interface-style design is fine, but never state something about the viewer\'s own status, account or application that is not true (e.g. that their application is incomplete or approved). ' +
  'Each variant uses a different persuasion angle; variants must not be rewordings of each other. Answer with one JSON object.';

function templateBrief(t: TemplateSpec, rank: number | null) {
  return [
    `TEMPLATE (fixed design, from the ad ranked #${rank ?? '?'} by impressions): ${t.name_it || t.template_name} — ${t.genre}`,
    `Recognisable features: ${t.must_keep.join('; ')}`,
    `TEXT SLOTS (name · role · current text · words · casing)\n${t.slots.map((s) => `- ${s.slot} · ${s.role} · "${s.current_text}" · ${s.words} words · ${s.casing}`).join('\n')}`,
  ].join('\n');
}

async function writeCandidates(ctx: RunCtx, t: TemplateSpec, rank: number | null, n: number, language: string, avoidAngles: string[]): Promise<Candidate[]> {
  const { product, project } = ctx;
  // due direttori creativi con angoli diversi: Opus parte dal meccanismo provato del template, Sonnet esplora
  const opusAngles = ANGLE_KEYS.filter((_, i) => i % 2 === 0);
  const sonnetAngles = ANGLE_KEYS.filter((_, i) => i % 2 === 1);
  const plan = [
    { model: env.visualWriterModel, count: Math.ceil(n / 2), angles: opusAngles, first: 'Variant 1 keeps the persuasion mechanism of the template\'s current text (it is a proven winner), made true for our product.' },
    { model: env.writerModel, count: Math.floor(n / 2), angles: sonnetAngles, first: 'You may transplant one of the PROVEN MESSAGES onto this template.' },
  ].filter((p) => p.count > 0);
  const runs = await Promise.all(plan.map((p) => chatJson({
    model: p.model, purpose: 'template:copy', projectId: project.id, temperature: 0.85, maxTokens: 5000,
    messages: [
      { role: 'system', content: WRITER_SYSTEM },
      { role: 'user', content: [
        `BRAND RULES\n${brandRules(project, product)}`,
        `OUR PRODUCT SHEET (the only source of product facts)\n${ctx.sheet}`,
        modeInstructions(product),
        templateBrief(t, rank),
        ctx.provenMessages.length ? `PROVEN MESSAGES (ads with the most delivery; their mechanism can be reused, facts must stay true)\n${ctx.provenMessages.join('\n')}` : '',
        `ANGLES to use (one per variant, in this order of preference): ${p.angles.filter((a) => !avoidAngles.includes(a)).concat(p.angles.filter((a) => avoidAngles.includes(a))).map((a) => `${a} (${ANGLES[a as keyof typeof ANGLES]})`).join('; ')}`,
        p.first,
        `LANGUAGE of every slot: ${language}`,
        `Return JSON {variants:[{angle, slots{${t.slots.map((s) => s.slot).join(', ')}}, why}]} with ${p.count} variants. Use exactly these slot names.`,
      ].filter(Boolean).join('\n\n') },
    ],
  }, Copy).then((r) => r.variants.map((v) => ({ ...v, writer: p.model }))).catch((e) => {
    console.warn(`[template:copy] ${p.model}: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
    return [] as Candidate[];
  })));
  return runs.flat();
}

async function rewriteSlots(ctx: RunCtx, t: TemplateSpec, rank: number | null, c: Candidate, feedback: string[], language: string): Promise<Candidate> {
  const r = await chatJson({
    model: env.visualWriterModel, purpose: 'template:rewrite', projectId: ctx.project.id, temperature: 0.6, maxTokens: 3000,
    messages: [
      { role: 'system', content: WRITER_SYSTEM },
      { role: 'user', content: [
        `BRAND RULES\n${brandRules(ctx.project, ctx.product)}`,
        `OUR PRODUCT SHEET (the only source of product facts)\n${ctx.sheet}`,
        templateBrief(t, rank),
        `CURRENT TEXT (angle ${c.angle})\n${JSON.stringify(c.slots, null, 1)}`,
        `EVALUATION FEEDBACK (fix these, keep the angle and what already works)\n${feedback.map((f) => `- ${f}`).join('\n')}`,
        `LANGUAGE of every slot: ${language}`,
        `Return JSON {variants:[{angle, slots{${t.slots.map((s) => s.slot).join(', ')}}, why}]} with 1 variant.`,
      ].join('\n\n') },
    ],
  }, Copy);
  const v = r.variants[0];
  return v ? { ...v, angle: c.angle, writer: env.visualWriterModel } : c;
}

const slotText = (t: TemplateSpec, slots: Record<string, string>) =>
  t.slots.map((s) => `${s.role}: "${slots[s.slot] ?? s.current_text}"`).join('\n');

/** Efficacia dei testi secondo Jev, prima di spendere per l'immagine. */
async function messageQuality(ctx: RunCtx, target: { type: 'concept' | 'output'; id: string }, t: TemplateSpec, rank: number | null, slots: Record<string, string>) {
  const q = await judge(target, 'message_quality', buildState({
    audience: ctx.en.audience || '(not specified)',
    offer: ctx.en.sheet.slice(0, 5000),
    output: `Static image ad. Design (fixed, from the ad ranked #${rank ?? '?'} by impressions): ${t.genre} — ${t.template_name}.\nText on the image:\n${slotText(t, slots)}`,
  }, {
    winning_ads: ctx.winners.winning.length ? ctx.winners.winning : ['(no reference ads yet)'],
    losing_ads: ctx.winners.losing.length ? ctx.winners.losing : ['(no reference ads yet)'],
  }), OUTPUT_QUALITY, ctx.project.id);
  const dims = Object.fromEntries(Object.entries(q).map(([k, a]) => [k, Number(qualityValue(k, a).toFixed(3))]));
  const score = Object.entries(QUALITY_WEIGHTS).reduce((s, [k, w]) => s + w * (dims[k] ?? 0), 0);
  return { score, dims };
}

const weakFeedback = (dims: Record<string, number>) => Object.entries(dims).filter(([, v]) => v < 0.7).sort((a, b) => a[1] - b[1])
  .map(([k, v]) => `${QUALITY_LABEL[k] ?? k} ${Math.round(v * 100)}/100 — ${QUALITY_FIX[k] ?? ''}`);

/* ---------- Prompt ---------- */

export function composeFromTemplate(t: TemplateSpec, slots: Record<string, string>, fixes: string[] = []): string {
  const lines = [
    `Square 1:1 social ad image. Design: ${t.genre}. ${t.template_name}.`,
    `Background: ${t.canvas.background}${t.canvas.effects ? `; ${t.canvas.effects}` : ''}.`,
    'Layout, top to bottom:',
    ...[...t.layout].sort((a, b) => a.order - b.order).map((l) => `- ${l.element}: ${l.position}; ${l.size}; ${l.look}`),
    `Typography: ${t.typography}.`,
    t.palette_hex.length ? `Colours: ${t.palette_hex.join(', ')}.` : '',
    t.must_keep.length ? `Keep these defining features: ${t.must_keep.join('; ')}.` : '',
    '',
    'Render EXACTLY this text, spelled exactly as written, and no other text:',
    ...t.slots.map((s) => `- ${s.role} (${s.slot}): "${slots[s.slot] ?? s.current_text}"`),
    '',
    'Do not add any logo, seal, badge, watermark or brand name.',
    ...(fixes.length ? ['', 'Corrections (a previous attempt got these wrong):', ...fixes.map((f) => `- ${f}`)] : []),
  ];
  return lines.filter((x, i, a) => x !== '' || (i > 0 && a[i - 1] !== '')).join('\n');
}

/* ---------- Giudizio dell'immagine ---------- */

const Fidelity = z.object({
  layout_match: looseNumber, style_match: looseNumber,
  missing_elements: looseStringArray, extra_elements: looseStringArray,
  text_exact: looseBool, text_errors: looseStringArray, reference_text_copied: looseBool,
  fix: looseStringArray,
});

async function templateFidelity(ctx: RunCtx, t: TemplateSpec, refUrl: string, newUrl: string, slots: Record<string, string>) {
  const f = await chatJson({
    model: env.visionModel, purpose: 'template:fidelity', projectId: ctx.project.id, temperature: 0, maxTokens: 2000,
    messages: [
      { role: 'system', content: 'You check whether a generated ad image faithfully rebuilds a design template with new text. Compare layout, elements, proportions, colours, typography and interface details — not the words. ' +
        'Then check the text: image 2 must show exactly the expected text (spelling included), no leftover text from image 1 and no extra text. Scores go from 0 (different design) to 1 (same design). Answer with one JSON object.' },
      { role: 'user', content: [
        { type: 'text', text: 'Image 1 = the reference template. Image 2 = the generated ad.' },
        { type: 'image_url', image_url: { url: refUrl } },
        { type: 'image_url', image_url: { url: newUrl } },
        { type: 'text', text: `Defining features of the template: ${t.must_keep.join('; ')}\n\nExpected text on image 2:\n${slotText(t, slots)}\n\n` +
          'Return JSON {layout_match (0-1), style_match (0-1), missing_elements[], extra_elements[], text_exact (bool), text_errors[] (misspelled, missing or extra words), reference_text_copied (bool), fix[] (concrete instructions to make image 2 match the template and the expected text)}.' },
      ] as ContentPart[] },
    ],
  }, Fidelity);
  const score = Math.max(0, Math.min(1, 0.6 * f.layout_match + 0.4 * f.style_match));
  const ok = score >= ctx.th.templateFidelity && f.text_exact && !f.reference_text_copied;
  return { ...f, score: Number(score.toFixed(3)), ok };
}

/** Jev sull'immagine: le schede senza formato ("sembra un…"), che per lo stesso template oscilla e falsava il voto. */
const noFormat = (f: VisualFeatures) => { const { format: _f, reads_as: _r, ...rest } = compactFeatures(f) as any; return rest; };

async function imageEffectiveness(ctx: RunCtx, outputId: string, newUrl: string) {
  const features = await describeVisual(newUrl, ctx.project.id, ctx.en.audience);
  const all = imageEffectivenessQuestions({
    firstSeen: ctx.winF.map((f) => f.first_thing_seen),
    headlines: ctx.winF.map((f) => f.headline.text),
    styles: [],
  });
  const questions = Object.fromEntries(Object.entries(all).filter(([k]) => k in TEMPLATE_IMAGE_WEIGHTS));
  const q = await judge({ type: 'output', id: outputId }, 'template_image', buildState({
    audience: ctx.en.audience || '(not specified)',
    product_offer: ctx.en.sheet.slice(0, 4000),
    new_ad: JSON.stringify(noFormat(features)),
  }, {
    winning_ads: ctx.winF.length ? ctx.winF.map((f) => JSON.stringify(noFormat(f))) : ['(no reference ads yet)'],
    losing_ads: ctx.losF.length ? ctx.losF.map((f) => JSON.stringify(noFormat(f))) : ['(no reference ads yet)'],
  }), questions, ctx.project.id);
  const dims = Object.fromEntries(Object.entries(q).map(([k, a]) => [k, Number(qualityValue(k, a).toFixed(3))]));
  const score = Object.entries(TEMPLATE_IMAGE_WEIGHTS).reduce((s, [k, w]) => s + w * (dims[k] ?? 0), 0);
  return { features, dims, score };
}

async function judgeImage(ctx: RunCtx, outputId: string, t: TemplateSpec, refUrl: string, newUrl: string, slots: Record<string, string>) {
  const [fidelity, eff] = await Promise.all([templateFidelity(ctx, t, refUrl, newUrl, slots), imageEffectiveness(ctx, outputId, newUrl)]);
  return { fidelity, ...eff };
}

const small = async (buf: Buffer) => `data:image/jpeg;base64,${(await sharp(buf).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 90 }).toBuffer()).toString('base64')}`;

type Attempt = { path: string; score: number; fidelity: number; fidelity_ok: boolean; text_errors: string[] };

/** Genera l'immagine di un output; se non rispetta template o testi la rigenera con le correzioni. Si tiene la migliore. */
export async function renderOutput(outputId: string, ctx?: RunCtx) {
  const out = must(await db().from('jev_outputs').select('*').eq('id', outputId).single()) as any;
  ctx ??= await loadRunContext(out.product_id);
  const tpl = await loadTemplate(out.template_id);
  const refUrl = await imageDataUrl(tpl.anchorPath);
  const slots = out.spec.slots as Record<string, string>;
  const attempts: (Attempt & { judged: Awaited<ReturnType<typeof judgeImage>> })[] = [];
  let fixes: string[] = [];
  for (let a = 0; a <= ctx.th.imageAttempts; a++) {
    const prompt = composeFromTemplate(tpl.spec, slots, fixes);
    const buf = await generateImage(prompt, { purpose: 'image:template', projectId: ctx.project.id });
    const path = await putMedia(`${ctx.project.id}/outputs/${out.code}-${a + 1}.png`, buf, 'image/png');
    const judged = await judgeImage(ctx, outputId, tpl.spec, refUrl, await small(buf), slots);
    attempts.push({ path, score: judged.score, fidelity: judged.fidelity.score, fidelity_ok: judged.fidelity.ok, text_errors: judged.fidelity.text_errors, judged });
    if (judged.fidelity.ok) break;
    fixes = [...judged.fidelity.text_errors.map((e) => `Text: ${e}`), ...judged.fidelity.fix].slice(0, 8);
  }
  const best = [...attempts].sort((x, y) => Number(y.fidelity_ok) - Number(x.fidelity_ok) || y.score - x.score)[0];
  await saveImageJudgement(out, best.path, best.judged, attempts.map(({ judged: _j, ...rest }) => rest), ctx.th);
  return { outputId, score: best.score, fidelity: best.fidelity, ok: best.fidelity_ok, attempts: attempts.length };
}

async function saveImageJudgement(out: any, path: string, j: Awaited<ReturnType<typeof judgeImage>>, attempts: Attempt[], th: Thresholds) {
  const weak = Object.entries(j.dims).filter(([, v]) => v < 0.7).sort((a, b) => a[1] - b[1]);
  const status = !j.fidelity.ok ? 'review' : j.score >= th.imageTarget ? 'ready' : 'review';
  await db().from('jev_outputs').update({
    result_path: path,
    visual_features: j.features,
    status: out.status === 'rejected' ? 'rejected' : status,
    quality: {
      ...(out.quality ?? {}),
      image: {
        score: j.score, dims: j.dims, judged_by: 'jev', winners_compared: 5, judged_at: new Date().toISOString(),
        fidelity: { score: j.fidelity.score, ok: j.fidelity.ok, layout: j.fidelity.layout_match, style: j.fidelity.style_match, text_exact: j.fidelity.text_exact, text_errors: j.fidelity.text_errors, missing: j.fidelity.missing_elements, extra: j.fidelity.extra_elements },
        differences: [...j.fidelity.missing_elements.map((m) => `Manca: ${m}`), ...j.fidelity.text_errors.map((e) => `Testo: ${e}`)],
        fix: weak.map(([k]) => QUALITY_FIX[k]).filter(Boolean),
        attempts,
      },
    },
  }).eq('id', out.id);
}

/* ---------- Output ---------- */

async function textGate(ctx: RunCtx, outputId: string, text: string) {
  const answers = {
    ...(await judge({ type: 'output', id: outputId }, 'product_fidelity', buildState({ product_sheet: ctx.sheet, prompt: text }), PRODUCT_FIDELITY, ctx.project.id)),
    ...(await judge({ type: 'output', id: outputId }, 'policy', buildState({ brand_rules: brandRules(ctx.project, ctx.product), description: text }), POLICY_QUESTIONS, ctx.project.id)),
  };
  const r = route(answers, null, ctx.th);
  await saveGate({ type: 'output', id: outputId }, 'prompt', r, null);
  return r;
}

async function insertOutput(ctx: RunCtx, o: {
  batchId: string | null; conceptId: string; tpl: Awaited<ReturnType<typeof loadTemplate>>; group: { key: string; label: string };
  c: Candidate; msg: { score: number; dims: Record<string, number> }; language: string; generation?: number; parent?: { id: string; code: string };
}) {
  const t = o.tpl.spec;
  const prompt = composeFromTemplate(t, o.c.slots);
  const spec = {
    mode: 'template', product_id: ctx.product.id, language: o.language, aspect_ratio: '1:1',
    template_id: o.tpl.id, template_group: o.group.key, template_label: o.group.label, anchor_creative: o.tpl.creative_id, anchor_rank: o.tpl.anchorRank,
    angle: o.c.angle, why: o.c.why, writer: o.c.writer, slots: o.c.slots,
    on_image_text: t.slots.map((s) => ({ text: o.c.slots[s.slot] ?? s.current_text, position: s.role, style: s.casing })),
    prompt, prompt_full: prompt, reference_images: o.tpl.anchorPath ? [o.tpl.anchorPath] : [],
    generation: o.generation ?? 1, ...(o.parent ? { parent_id: o.parent.id, parent_code: o.parent.code } : {}),
  };
  const row = must(await db().from('jev_outputs').insert({
    batch_id: o.batchId, code: code(), concept_id: o.conceptId, product_id: ctx.product.id, kind: 'image', language: o.language,
    template_id: o.tpl.id, spec, status: 'awaiting_upload',
    quality: { score: o.msg.score, dims: o.msg.dims, best_round: 1, rounds: [{ round: 1, score: o.msg.score, decision: 'pass', reasons: [] }] },
  }).select('id, code').single()) as { id: string; code: string };
  const [vec] = await embed([slotText(t, o.c.slots)], 'embed:output', ctx.project.id);
  const gate = await textGate(ctx, row.id, slotText(t, o.c.slots));
  await db().from('jev_outputs').update({
    embedding: toPg(vec),
    status: gate.decision === 'reject' ? 'rejected' : 'awaiting_upload',
    quality: { score: o.msg.score, dims: o.msg.dims, best_round: 1, rounds: [{ round: 1, score: o.msg.score, decision: gate.decision, reasons: gate.reasons }] },
  }).eq('id', row.id);
  return row;
}

/** Testi per un template: candidati da due scrittori → voto di Jev → i migliori e diversi → riscrittura dei deboli. */
async function messagesFor(ctx: RunCtx, tpl: Awaited<ReturnType<typeof loadTemplate>>, k: number, language: string, usedAngles: string[], conceptId: string) {
  const target = { type: 'concept' as const, id: conceptId };
  const t = tpl.spec;
  const cands = await writeCandidates(ctx, t, tpl.anchorRank, k + 2, language, usedAngles);
  if (!cands.length) throw new Error('Nessun testo scritto per il template');
  const scored = await pool(cands, 4, async (c) => ({ c, ...(await messageQuality(ctx, target, t, tpl.anchorRank, c.slots)) }));
  // un candidato per angolo (il migliore), poi i più forti e diversi tra loro
  const perAngle = new Map<string, typeof scored[number]>();
  for (const s of scored) if (!perAngle.has(s.c.angle) || perAngle.get(s.c.angle)!.score < s.score) perAngle.set(s.c.angle, s);
  const distinct = [...perAngle.values()];
  const vecs = await embed(distinct.map((s) => slotText(t, s.c.slots)), 'embed:template_copy', ctx.project.id);
  const picked = mmr(distinct.map((s, i) => ({ item: s, score: s.score, vec: vecs[i] })), k);
  return pool(picked, 3, async (s) => {
    if (s.score >= ctx.th.outputQuality) return s;
    const better = await rewriteSlots(ctx, t, tpl.anchorRank, s.c, weakFeedback(s.dims), language).catch(() => null);
    if (!better) return s;
    const q = await messageQuality(ctx, target, t, tpl.anchorRank, better.slots);
    return q.score > s.score ? { c: better, ...q } : s;
  });
}

async function groupConcept(ctx: RunCtx, batchId: string, g: TemplateGroup, tpl: Awaited<ReturnType<typeof loadTemplate>>) {
  return must(await db().from('jev_concepts').insert({
    batch_id: batchId, product_id: ctx.product.id, kind: 'image', title: `Template: ${g.label}`,
    brief: `${tpl.spec.genre}. Grafica fissa dalla ad #${tpl.anchorRank ?? '?'} per impression; cambiano solo i testi.`,
    dna: { template_id: tpl.id }, source_refs: [{ creativeId: tpl.creative_id }],
    genotype: { format: 'template', template_group: g.key }, mutation: 'none', status: 'approved',
  }).select('id').single()) as { id: string };
}

/** Generazione automatica di creatività da template. */
export async function templateCreatives(productId: string, opts: TemplateRunOpts, jobId?: string) {
  await ensureCorpus(productId, jobId);
  await progress(jobId, 'Schede dei template delle immagini migliori');
  await buildTemplates(productId, jobId, { limit: 60 });
  const groups = await templateGroups(productId);
  const picked = opts.groupKey ? groups.filter((g) => g.key === opts.groupKey) : await pickDiverseTemplates(groups, Math.max(1, opts.templates));
  if (!picked.length) throw new Error(opts.groupKey ? 'Template non trovato: ricalcola i template.' : 'Nessun template: servono immagini analizzate per questo prodotto.');
  const ctx = await loadRunContext(productId);
  const perTemplate = Math.min(6, Math.max(1, opts.perTemplate));
  const batchId = await createBatch(productId, 'template',
    opts.groupKey ? `Template "${picked[0].label}" · ${perTemplate} creatività` : `${picked.length} template migliori × ${perTemplate} creatività`,
    { ...opts, templates: picked.map((g) => ({ key: g.key, label: g.label, anchor: g.anchor.creativeId })) });

  const usedAngles: string[] = [];
  const created: { id: string; code: string }[] = [];
  for (const [i, g] of picked.entries()) {
    await progress(jobId, `Template ${i + 1}/${picked.length} "${g.label}": testi (Opus + Sonnet) e voto di Jev`);
    try {
      const tpl = await loadTemplate(g.anchor.templateId);
      const concept = await groupConcept(ctx, batchId, g, tpl);
      const msgs = await messagesFor(ctx, tpl, perTemplate, opts.language, usedAngles, concept.id);
      for (const m of msgs) {
        usedAngles.push(m.c.angle);
        created.push(await insertOutput(ctx, { batchId, conceptId: concept.id, tpl, group: g, c: m.c, msg: m, language: opts.language }));
      }
    } catch (e) {
      console.warn(`[template] "${g.label}": ${e instanceof Error ? e.message : e}`);
    }
  }
  if (!created.length) throw new Error('Nessuna creatività creata: controlla i template e la scheda prodotto.');
  if (!opts.images) return { templates: picked.length, outputs: created.length, images: 0 };

  // immagini: prima passata, poi una versione migliorata per quelle fedeli ma sotto la soglia di efficacia
  let n = 0;
  const first = await pool(created, 3, async (o) => {
    const r = await renderOutput(o.id, ctx).catch((e) => ({ outputId: o.id, error: e instanceof Error ? e.message : String(e) }));
    await progress(jobId, `Immagini ${++n}/${created.length} (generazione, fedeltà al template, voto di Jev)`);
    return r;
  });
  const weak = first.filter((r): r is Extract<typeof r, { score: number }> => 'score' in r && r.ok && r.score < ctx.th.imageTarget);
  const second = ctx.th.imageRounds > 1 && weak.length
    ? await pool(weak, 3, async (r) => {
        await progress(jobId, `Versione migliorata di ${weak.length} creatività sotto soglia`);
        return nextTemplateVersion(r.outputId, undefined, ctx).catch(() => null);
      })
    : [];
  const { data: final } = await db().from('jev_outputs').select('code, quality, status').eq('batch_id', batchId);
  const scores = (final ?? []).filter((o) => o.quality?.image).map((o) => ({ code: o.code, score: Math.round(o.quality.image.score * 100), fidelity: Math.round((o.quality.image.fidelity?.score ?? 0) * 100), status: o.status }))
    .sort((a, b) => b.score - a.score);
  return {
    templates: picked.length, outputs: created.length, improved: second.filter(Boolean).length,
    errors: first.filter((r) => 'error' in r).map((r) => (r as { error: string }).error),
    winners: scores.filter((s) => s.score >= Math.round(ctx.th.imageTarget * 100) && s.status === 'ready').length,
    best: scores.slice(0, 5),
  };
}

/**
 * Versione successiva di una creatività da template: se sono deboli i testi, li riscrive seguendo il giudizio di Jev;
 * la grafica resta quella del template. Con immagine automatica, genera e giudica subito la nuova versione.
 */
export async function nextTemplateVersion(outputId: string, jobId?: string, ctx?: RunCtx) {
  const out = must(await db().from('jev_outputs').select('*').eq('id', outputId).single()) as any;
  ctx ??= await loadRunContext(out.product_id);
  const tpl = await loadTemplate(out.template_id);
  const img = out.quality?.image;
  const dims: Record<string, number> = img?.dims ?? out.quality?.dims ?? {};
  const feedback = [
    ...(img ? [`The image made with this text scored ${Math.round(img.score * 100)}/100 for effectiveness against the winning ads. Fix what made it weaker:`] : []),
    ...weakFeedback(dims),
  ];
  await progress(jobId, 'Riscrittura dei testi seguendo il giudizio');
  const prev: Candidate = { angle: out.spec.angle, slots: out.spec.slots, why: out.spec.why ?? '', writer: out.spec.writer };
  const next = feedback.length > (img ? 1 : 0) ? await rewriteSlots(ctx, tpl.spec, tpl.anchorRank, prev, feedback, out.language) : prev;
  const msg = await messageQuality(ctx, { type: 'output', id: outputId }, tpl.spec, tpl.anchorRank, next.slots);
  const group = { key: out.spec.template_group, label: out.spec.template_label };
  const row = await insertOutput(ctx, {
    batchId: out.batch_id, conceptId: out.concept_id, tpl, group, c: next, msg, language: out.language,
    generation: Number(out.spec.generation ?? 1) + 1, parent: { id: out.id, code: out.code },
  });
  if (out.result_path) {
    await progress(jobId, 'Immagine della nuova versione');
    await renderOutput(row.id, ctx);
  }
  return { outputId: row.id, code: row.code };
}

/** Immagine caricata dall'utente (fatta in ChatGPT) per una creatività da template: stesso giudizio dell'automatica. */
export async function judgeTemplateUpload(outputId: string, jobId?: string) {
  const out = must(await db().from('jev_outputs').select('*').eq('id', outputId).single()) as any;
  const ctx = await loadRunContext(out.product_id);
  const tpl = await loadTemplate(out.template_id);
  await progress(jobId, 'Fedeltà al template e voto di Jev');
  const j = await judgeImage(ctx, outputId, tpl.spec, await imageDataUrl(tpl.anchorPath), await imageDataUrl(out.result_path), out.spec.slots);
  await saveImageJudgement(out, out.result_path, j, [], ctx.th);
  const { count: children } = await db().from('jev_outputs').select('id', { count: 'exact', head: true }).eq('spec->>parent_id', outputId);
  if (j.fidelity.ok && j.score < ctx.th.imageTarget && Number(out.spec.generation ?? 1) < ctx.th.imageRounds && !children) {
    await enqueue('template_next', { outputId }, ctx.project.id);
  }
  const decision: 'pass' | 'review' = j.fidelity.ok && j.score >= ctx.th.imageTarget ? 'pass' : 'review';
  return { decision, score: Number(j.score.toFixed(2)), fidelity: j.fidelity.score, ok: j.fidelity.ok };
}

