import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../db';
import { env } from '../env';
import { progress } from '../jobs';
import { chatJson, embedImages, looseString } from '../openrouter';
import { getSetting, getThresholds, setSetting } from '../settings';
import sharp from 'sharp';
import { getMedia } from '../storage';
import { cosine, parseVector, toPg } from '../vectors';
import { creativeFeatures, type VisualFeatures } from './visual';

/**
 * Famiglie di stile: raggruppano le creatività che "parlano la stessa lingua visiva", così che generazione
 * e confronto di Jev non mischino stili incompatibili.
 * - Immagini: dalla scheda visiva (formato, "sembra un…", elementi patriottici / ufficiali / interfacce finte).
 * - Video: famiglia di FORMATO (non si mischiano UGC e chat finta) e, a parte, famiglia di HOOK (sostituibile).
 * Il raggruppamento è deterministico nel codice: stesso input → stesse famiglie.
 */

export type Family = {
  key: string;
  label: string;
  kind: 'image' | 'video_format' | 'video_hook';
  members: { id: string; impression_rank: number | null; impression_pct: number | null; score: number | null; media_type: string; thumb: string | null }[];
  impressionShare: number;  // quota delle posizioni "alte" (1 - pct) sul totale del prodotto
  bestRank: number | null;
};

const FORMAT_IT: Record<string, string> = {
  bold_text_graphic: 'Grafica con titolo grande', fake_notification: 'Notifica finta', fake_chat: 'Chat finta',
  fake_approval_or_certificate: 'Approvazione / certificato finto', official_notice_style: 'Avviso in stile ufficiale',
  social_post_screenshot: 'Screenshot di post', ugc_photo: 'Foto UGC', lifestyle_photo: 'Foto lifestyle',
  product_photo: 'Foto prodotto', meme: 'Meme', infographic: 'Infografica', collage: 'Collage', other: 'Altro',
  // formati video (domanda FORMAT_QUESTIONS di Jev)
  broll_montage: 'Montaggio B-roll con sottotitoli', narrative_broll: 'Storia su scene di repertorio o recitate', screen_ui: 'Registrazione di schermo (chat, notifica, form)',
  ugc_talking_head: 'UGC: persona che parla in camera', demo: 'Dimostrazione', before_after: 'Prima / dopo',
  green_screen: 'Green screen', slideshow: 'Slideshow', skit: 'Sketch recitato', animation: 'Animazione',
  static_product: 'Statica prodotto', static_ugc: 'Statica UGC', text_only: 'Solo testo',
};
const HOOK_IT: Record<string, string> = {
  question: 'Domanda', pattern_interrupt: 'Interruzione', bold_claim: 'Affermazione forte', problem_callout: 'Nomina il problema',
  demo: 'Dimostrazione subito', face_to_camera: 'Persona in camera', story_open: 'Storia / confessione', social_proof: 'Prova sociale', other: 'Altro',
};

/**
 * Macro-famiglia di un'immagine. I tratti (patriottico, ufficiale…) sono quasi sempre presenti in questa categoria
 * e non distinguono: conta il formato, raggruppato in tre linguaggi visivi.
 */
const IMAGE_MACRO: Record<string, { key: string; label: string }> = {
  bold_text_graphic: { key: 'text_notice', label: 'Avviso / grafica testuale' },
  fake_approval_or_certificate: { key: 'text_notice', label: 'Avviso / grafica testuale' },
  official_notice_style: { key: 'text_notice', label: 'Avviso / grafica testuale' },
  infographic: { key: 'text_notice', label: 'Avviso / grafica testuale' },
  fake_notification: { key: 'ui_native', label: 'Interfaccia nativa (post, notifica, chat)' },
  fake_chat: { key: 'ui_native', label: 'Interfaccia nativa (post, notifica, chat)' },
  social_post_screenshot: { key: 'ui_native', label: 'Interfaccia nativa (post, notifica, chat)' },
  meme: { key: 'ui_native', label: 'Interfaccia nativa (post, notifica, chat)' },
  ugc_photo: { key: 'photo_people', label: 'Foto con persone (UGC, lifestyle, collage)' },
  lifestyle_photo: { key: 'photo_people', label: 'Foto con persone (UGC, lifestyle, collage)' },
  collage: { key: 'photo_people', label: 'Foto con persone (UGC, lifestyle, collage)' },
  product_photo: { key: 'photo_people', label: 'Foto con persone (UGC, lifestyle, collage)' },
};

export function imageStyleKey(f: VisualFeatures): { key: string; label: string } {
  return IMAGE_MACRO[f.format] ?? { key: 'other', label: 'Altro' };
}

const merit = (m: { score: number | null; impression_pct: number | null }) =>
  0.5 * (m.score ?? 0) + 0.5 * (m.impression_pct == null ? 0.5 : 1 - m.impression_pct);

function finalize(groups: Map<string, { label: string; kind: Family['kind']; members: Family['members'] }>): Family[] {
  const total = [...groups.values()].flatMap((g) => g.members).reduce((s, m) => s + (m.impression_pct == null ? 0.5 : 1 - m.impression_pct), 0) || 1;
  return [...groups.entries()].map(([key, g]) => {
    const members = g.members.sort((a, b) => merit(b) - merit(a));
    const ranks = members.map((m) => m.impression_rank).filter((r): r is number => r != null);
    return {
      key, label: g.label, kind: g.kind, members,
      impressionShare: members.reduce((s, m) => s + (m.impression_pct == null ? 0.5 : 1 - m.impression_pct), 0) / total,
      bestRank: ranks.length ? Math.min(...ranks) : null,
    };
  }).sort((a, b) => b.impressionShare - a.impressionShare);
}

/**
 * Clustering gerarchico con collegamento medio: si uniscono i gruppi finché la somiglianza media tra i loro
 * membri resta sopra la soglia. Deterministico dato l'input.
 */
export function averageLinkage(vecs: number[][], threshold: number): number[][] {
  const n = vecs.length;
  const sim = vecs.map((a) => vecs.map((b) => cosine(a, b)));
  let clusters = vecs.map((_, i) => [i]);
  for (;;) {
    let best = -1, bi = -1, bj = -1;
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        let sum = 0;
        for (const x of clusters[a]) for (const y of clusters[b]) sum += sim[x][y];
        const avg = sum / (clusters[a].length * clusters[b].length);
        if (avg > best) { best = avg; bi = a; bj = b; }
      }
    }
    if (bi < 0 || best < threshold || n < 2) break;
    clusters = [...clusters.filter((_, k) => k !== bi && k !== bj), [...clusters[bi], ...clusters[bj]]];
  }
  return clusters;
}

const clusterKey = (ids: string[]) => 'v_' + crypto.createHash('sha256').update([...ids].sort().join(',')).digest('hex').slice(0, 10);

/**
 * Stili delle immagini: schede visive (servono a Jev e al nome del gruppo) + embedding visivo dell'immagine
 * + raggruppamento per somiglianza del template grafico. Il risultato viene salvato (creatives.style_family).
 */
export async function buildImageFeatures(productId: string, jobId?: string) {
  const th = await getThresholds();
  const { data } = await db().from('jev_creatives').select('id, project_id, media_paths, visual_features, image_embedding, impression_rank, ranking')
    .eq('product_id', productId).in('media_type', ['image', 'carousel']);
  const rows = (data ?? []).filter((c) => c.media_paths?.length && !c.ranking?.excluded);
  const noFeat = rows.filter((c) => !c.visual_features);
  for (const [i, c] of noFeat.entries()) {
    await progress(jobId, `Schede visive ${i + 1}/${noFeat.length}`);
    await creativeFeatures(c.id, c.project_id);
  }
  const noEmb = rows.filter((c) => !c.image_embedding);
  let skipped = 0;
  // a gruppi: si scaricano poche immagini alla volta dallo Storage (niente raffiche di richieste) e si inviano in base64
  for (let i = 0; i < noEmb.length; i += 8) {
    const group = noEmb.slice(i, i + 8);
    await progress(jobId, `Embedding visivi ${Math.min(i + 8, noEmb.length)}/${noEmb.length}`);
    const dataUrls: string[] = [];
    for (const c of group) {
      const small = await sharp(await getMedia(c.media_paths[0])).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
      dataUrls.push(`data:image/jpeg;base64,${small.toString('base64')}`);
    }
    const vecs = await embedImages(dataUrls, rows[0]?.project_id);
    for (const [k, c] of group.entries()) {
      if (vecs[k]) await db().from('jev_creatives').update({ image_embedding: toPg(vecs[k]!) }).eq('id', c.id);
      else skipped++;
    }
  }

  await progress(jobId, 'Raggruppamento per somiglianza visiva');
  const { data: fresh } = await db().from('jev_creatives').select('id, image_embedding, visual_features, impression_rank').in('id', rows.map((c) => c.id));
  const items = (fresh ?? []).map((c) => ({ ...c, vec: parseVector(c.image_embedding) })).filter((c): c is typeof c & { vec: number[] } => !!c.vec);
  const clusters = averageLinkage(items.map((c) => c.vec), th.styleSimilarity);

  // nome leggibile di ogni gruppo, dalle schede visive dei membri (solo un'etichetta: il raggruppamento resta nel codice)
  const labels: Record<string, string> = {};
  for (const [k, cl] of clusters.entries()) {
    const members = cl.map((x) => items[x]);
    const key = clusterKey(members.map((m) => m.id));
    for (const m of members) await db().from('jev_creatives').update({ style_family: key }).eq('id', m.id);
    await progress(jobId, `Nome del gruppo ${k + 1}/${clusters.length}`);
    const feats = members.slice(0, 5).map((m) => {
      const f = m.visual_features as VisualFeatures | null;
      return f ? { format: f.format, headline: f.headline.text, first_seen: f.first_thing_seen, ui: f.fake_ui_elements, authority: f.authority_elements, people: f.people.description } : null;
    }).filter(Boolean);
    const r = await chatJson({
      model: env.writerModel, purpose: 'style:name', projectId: rows[0]?.project_id, temperature: 0, maxTokens: 200,
      messages: [
        { role: 'system', content: 'You name a family of ad images that share the same graphic template. Answer with one JSON object {name} — an Italian name of 3 to 7 words describing the template (layout and key elements), no brand names.' },
        { role: 'user', content: JSON.stringify(feats) },
      ],
    }, z.object({ name: looseString })).catch(() => ({ name: 'Stile senza nome' }));
    labels[key] = r.name;
  }
  await setSetting(`style_labels_${productId}`, labels);
  return { images: items.length, skipped, families: clusters.length, sizes: clusters.map((c) => c.length).sort((a, b) => b - a) };
}

export async function imageFamilies(productId: string): Promise<Family[]> {
  const { data } = await db().from('jev_creatives')
    .select('id, media_type, media_paths, impression_rank, impression_pct, ranking, visual_features, style_family')
    .eq('product_id', productId).in('media_type', ['image', 'carousel']).not('visual_features', 'is', null);
  const labels = await getSetting<Record<string, string>>(`style_labels_${productId}`, {});
  const groups = new Map<string, { label: string; kind: Family['kind']; members: Family['members'] }>();
  for (const c of data ?? []) {
    if (c.ranking?.excluded) continue;
    // senza raggruppamento visivo (non ancora calcolato) si ripiega sulla macro-famiglia di formato
    const { key, label } = c.style_family ? { key: c.style_family, label: labels[c.style_family] ?? 'Stile' } : imageStyleKey(c.visual_features as VisualFeatures);
    const g = groups.get(key) ?? { label, kind: 'image' as const, members: [] };
    g.members.push({ id: c.id, impression_rank: c.impression_rank, impression_pct: c.impression_pct, score: c.ranking?.score ?? null, media_type: c.media_type, thumb: c.media_paths?.[0] ?? null });
    groups.set(key, g);
  }
  return finalize(groups);
}

/** Famiglie video: per formato (dalla sezione visual_format) e per hook (dalla sezione hook). */
export async function videoFamilies(productId: string): Promise<{ formats: Family[]; hooks: Family[] }> {
  const { data: cs } = await db().from('jev_creatives')
    .select('id, media_type, poster_path, impression_rank, impression_pct, ranking')
    .eq('product_id', productId).eq('media_type', 'video').not('ranking', 'is', null);
  const ids = (cs ?? []).map((c) => c.id);
  const { data: secs } = await db().from('jev_creative_sections').select('creative_id, section, ranking').in('creative_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  const sec = (id: string, s: string) => secs?.find((x) => x.creative_id === id && x.section === s)?.ranking ?? {};
  const fmt = new Map<string, { label: string; kind: Family['kind']; members: Family['members'] }>();
  const hk = new Map<string, { label: string; kind: Family['kind']; members: Family['members'] }>();
  for (const c of cs ?? []) {
    if (c.ranking?.excluded) continue;
    const m = { id: c.id, impression_rank: c.impression_rank, impression_pct: c.impression_pct, score: c.ranking?.score ?? null, media_type: 'video', thumb: c.poster_path };
    const f = String(sec(c.id, 'visual_format').format ?? 'other');
    const h = String(sec(c.id, 'hook').hook_type ?? 'other');
    const gf = fmt.get(f) ?? { label: FORMAT_IT[f] ?? f, kind: 'video_format' as const, members: [] };
    gf.members.push(m); fmt.set(f, gf);
    const gh = hk.get(h) ?? { label: HOOK_IT[h] ?? h, kind: 'video_hook' as const, members: [] };
    gh.members.push({ ...m }); hk.set(h, gh);
  }
  return { formats: finalize(fmt), hooks: finalize(hk) };
}

/** Le creatività di una famiglia (per generare e per il confronto di Jev). */
export async function familyMembers(productId: string, kind: Family['kind'], key: string): Promise<string[]> {
  const fams = kind === 'image' ? await imageFamilies(productId) : (await videoFamilies(productId))[kind === 'video_format' ? 'formats' : 'hooks'];
  return fams.find((f) => f.key === key)?.members.map((m) => m.id) ?? [];
}

/** Rigiudica solo la sezione "formato visivo" dei video (dopo aver ampliato le opzioni di formato). */
export async function rejudgeVideoFormats(productId: string, jobId?: string) {
  const { buildState, judge } = await import('../judge');
  const { FORMAT_QUESTIONS } = await import('../judge/questions');
  const { data: cs } = await db().from('jev_creatives').select('id, project_id, description_en').eq('product_id', productId).eq('media_type', 'video');
  let n = 0;
  for (const c of cs ?? []) {
    const { data: s } = await db().from('jev_creative_sections').select('id, text, ranking').eq('creative_id', c.id).eq('section', 'visual_format').maybeSingle();
    if (!s) continue;
    await progress(jobId, `Formato video ${++n}/${cs?.length}`);
    const a = await judge({ type: 'section', id: s.id }, 'format_only', buildState({ ad: `${s.text}\n\n(Full ad)\n${String(c.description_en ?? '').slice(0, 4000)}` }), { format: FORMAT_QUESTIONS.format }, c.project_id);
    await db().from('jev_creative_sections').update({ ranking: { ...(s.ranking ?? {}), format: a.format.value } }).eq('id', s.id);
  }
  return { rejudged: n };
}
