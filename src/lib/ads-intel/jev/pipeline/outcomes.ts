import Papa from 'papaparse';
import { db, must } from '../db';
import { fetchAdInsights } from '../meta/marketing';
import { getFbToken } from '../settings';
import { DEFAULT_WEIGHTS } from './analyze';

const CODE_RE = /JFC-[0-9a-f]{8}/i;

/** Colonne dell'export di Ads Manager, in italiano e in inglese. */
const COLS: Record<string, string[]> = {
  ad_name: ['nome dell\'inserzione', 'ad name'],
  ad_id: ['id dell\'inserzione', 'ad id'],
  spend: ['importo speso', 'amount spent'],
  impressions: ['impression', 'impressions'],
  clicks: ['clic sul link', 'link clicks'],
  ctr: ['ctr (percentuale di clic sul link)', 'ctr (link click-through rate)', 'ctr'],
  cpa: ['costo per risultato', 'cost per result', 'costo per acquisto', 'cost per purchase'],
  roas: ['roas (ritorno sulla spesa pubblicitaria) degli acquisti', 'purchase roas (return on ad spend)', 'roas'],
  purchases: ['acquisti', 'purchases', 'risultati', 'results'],
  plays3s: ['riproduzioni del video per almeno 3 secondi', '3-second video plays'],
  date_start: ['inizio report', 'reporting starts'],
  date_end: ['fine report', 'reporting ends'],
};

function pickCol(headers: string[], names: string[]): string | undefined {
  const low = headers.map((h) => h.toLowerCase().trim());
  for (const n of names) {
    const i = low.findIndex((h) => h === n || h.startsWith(n));
    if (i >= 0) return headers[i];
  }
  return undefined;
}

const num = (v: unknown) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

async function linkTargets(productId: string, adName: string, adId: string | null) {
  const code = adName.match(CODE_RE)?.[0]?.toUpperCase().replace('JFC-', 'JFC-');
  let output_id: string | null = null;
  let creative_id: string | null = null;
  if (code) {
    const { data } = await db().from('jev_outputs').select('id').ilike('code', code).maybeSingle();
    output_id = data?.id ?? null;
  }
  if (adId) {
    const { data } = await db().from('jev_ads').select('creative_id').eq('library_id', adId).maybeSingle();
    creative_id = data?.creative_id ?? null;
  }
  return { output_id, creative_id };
}

/** Import CSV dall'export di Ads Manager. Collega le righe agli output tramite il codice JFC-xxxxxxxx nel nome dell'ad. */
export async function importOutcomesCsv(productId: string, csv: string) {
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  const headers = parsed.meta.fields ?? [];
  const col = Object.fromEntries(Object.entries(COLS).map(([k, names]) => [k, pickCol(headers, names)]));
  if (!col.ad_name) throw new Error('Colonna "Nome dell\'inserzione" / "Ad name" non trovata nel CSV.');
  let imported = 0, linked = 0;
  for (const r of parsed.data) {
    const adName = r[col.ad_name!] ?? '';
    const adId = col.ad_id ? r[col.ad_id] : null;
    const { output_id, creative_id } = await linkTargets(productId, adName, adId);
    const impressions = num(col.impressions && r[col.impressions]);
    const plays = num(col.plays3s && r[col.plays3s]);
    const row = {
      product_id: productId, output_id, creative_id,
      external_ad_id: adId || adName, ad_name: adName,
      spend: num(col.spend && r[col.spend]), impressions, clicks: num(col.clicks && r[col.clicks]),
      ctr: num(col.ctr && r[col.ctr]), cpa: num(col.cpa && r[col.cpa]), roas: num(col.roas && r[col.roas]),
      purchases: num(col.purchases && r[col.purchases]),
      hook_rate: impressions && plays ? plays / impressions : null,
      date_start: col.date_start ? r[col.date_start] || null : null,
      date_end: col.date_end ? r[col.date_end] || null : null,
      source: 'csv',
    };
    const { error } = await db().from('jev_outcomes').upsert(row, { onConflict: 'external_ad_id,date_start,date_end' });
    if (!error) { imported++; if (output_id || creative_id) linked++; }
  }
  return { rows: parsed.data.length, imported, linked, columns: col };
}

/** Sincronizza gli esiti dalla Marketing API (se il token ha ads_read sull'account). */
export async function syncMarketing(productId: string) {
  const tok = await getFbToken();
  if (!tok?.adAccountId) throw new Error('Imposta l\'ID dell\'account pubblicitario nelle Impostazioni.');
  const rows = await fetchAdInsights(tok.adAccountId);
  let linked = 0;
  for (const r of rows) {
    const { output_id, creative_id } = await linkTargets(productId, r.ad_name, r.ad_id);
    if (!output_id && !creative_id) continue;
    linked++;
    await db().from('jev_outcomes').upsert({
      product_id: productId, output_id, creative_id, external_ad_id: r.ad_id, ad_name: r.ad_name,
      spend: r.spend, impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, cpa: r.cpa, roas: r.roas,
      purchases: r.purchases, hook_rate: r.hook_rate, date_start: r.date_start, date_end: r.date_stop, source: 'marketing_api',
    }, { onConflict: 'external_ad_id,date_start,date_end' });
  }
  return { fetched: rows.length, linked };
}

type Sample = { x: Record<string, number>; y: number };

/** Correlazione punto-biseriale di ogni criterio con l'esito; i pesi sono le correlazioni positive normalizzate. */
export function correlationWeights(samples: Sample[], keys: string[]): { weights: Record<string, number>; corr: Record<string, number> } {
  const corr: Record<string, number> = {};
  for (const k of keys) {
    const pairs = samples.map((s) => [s.x[k], s.y] as const).filter(([v]) => Number.isFinite(v));
    if (pairs.length < 3) { corr[k] = 0; continue; }
    const mx = pairs.reduce((a, [v]) => a + v, 0) / pairs.length;
    const my = pairs.reduce((a, [, t]) => a + t, 0) / pairs.length;
    const cov = pairs.reduce((a, [v, t]) => a + (v - mx) * (t - my), 0);
    const sx = Math.sqrt(pairs.reduce((a, [v]) => a + (v - mx) ** 2, 0));
    const sy = Math.sqrt(pairs.reduce((a, [, t]) => a + (t - my) ** 2, 0));
    corr[k] = sx && sy ? cov / (sx * sy) : 0;
  }
  // ogni criterio tiene un minimo, così nessuno sparisce del tutto per pochi dati
  const pos = Object.fromEntries(keys.map((k) => [k, Math.max(corr[k], 0.05)]));
  const sum = Object.values(pos).reduce((a, v) => a + v, 0);
  return { weights: Object.fromEntries(keys.map((k) => [k, Number((pos[k] / sum).toFixed(3))])), corr };
}

const MIN_SAMPLES = 10;
const MIN_HOOK_RATE_SAMPLES = 8;

/**
 * Ricalibra i pesi della classifica per gruppo (ad intera, hook, messaggio, formato).
 * - Ad, messaggio, formato: esito vincente/perdente del corpus.
 * - Hook: se ci sono abbastanza nostre ads con hook rate, si usa quello (segnale precoce: hook rate sopra la mediana);
 *   altrimenti l'esito del corpus.
 * Un gruppo senza abbastanza dati mantiene i pesi attuali.
 */
export async function recalibrateWeights(productId: string) {
  const { data: refs } = await db().from('jev_reference_ads').select('creative_id, outcome').eq('product_id', productId).in('outcome', ['win', 'loss']);
  const outcome = new Map((refs ?? []).map((r) => [r.creative_id, r.outcome === 'win' ? 1 : 0]));
  const { data: cs } = await db().from('jev_creatives').select('id, ranking').eq('product_id', productId).not('ranking', 'is', null);
  const rank = new Map((cs ?? []).map((c) => [c.id, c.ranking as Record<string, number>]));
  const { data: secs } = await db().from('jev_creative_sections').select('creative_id, section, ranking').in('creative_id', [...rank.keys()].length ? [...rank.keys()] : ['00000000-0000-0000-0000-000000000000']);
  const sec = (cid: string, name: string) => (secs ?? []).find((s) => s.creative_id === cid && s.section === name)?.ranking as Record<string, number> | undefined;

  const { data: hr } = await db().from('jev_outcomes').select('creative_id, hook_rate').eq('product_id', productId).not('creative_id', 'is', null).not('hook_rate', 'is', null);
  const hookRate = new Map<string, number>();
  for (const o of hr ?? []) hookRate.set(o.creative_id, Math.max(hookRate.get(o.creative_id) ?? 0, Number(o.hook_rate)));
  const hrVals = [...hookRate.values()].sort((a, b) => a - b);
  const hrMedian = hrVals[Math.floor(hrVals.length / 2)];

  const product = must(await db().from('jev_products').select('weights').eq('id', productId).single()) as { weights: Record<string, number> };
  const weights: Record<string, number> = { ...DEFAULT_WEIGHTS, ...product.weights };
  const report: Record<string, unknown> = {};

  const labeled = [...outcome.keys()].filter((id) => rank.has(id));
  const fit = (group: string, samples: Sample[], keys: string[], target: string) => {
    if (samples.length < MIN_SAMPLES && !(target === 'hook_rate' && samples.length >= MIN_HOOK_RATE_SAMPLES)) {
      report[group] = { skipped: `servono almeno ${MIN_SAMPLES} esempi (ora ${samples.length})` };
      return;
    }
    const r = correlationWeights(samples, keys);
    Object.assign(weights, r.weights);
    report[group] = { samples: samples.length, target, correlations: r.corr, weights: r.weights };
  };

  fit('ad', labeled.map((id) => ({ x: { ad_angle: rank.get(id)!.angle_strength, ad_fit: rank.get(id)!.positioning_fit, ad_repro: rank.get(id)!.reproducibility }, y: outcome.get(id)! })), ['ad_angle', 'ad_fit', 'ad_repro'], 'corpus');

  const hookIds = [...rank.keys()].filter((id) => sec(id, 'hook'));
  const withHr = hookIds.filter((id) => hookRate.has(id));
  const hookSample = (id: string, y: number): Sample => ({ x: { hook_stop: sec(id, 'hook')!.stop_power, hook_corpus: sec(id, 'hook')!.corpus_score, hook_fit: sec(id, 'hook')!.fit }, y });
  if (withHr.length >= MIN_HOOK_RATE_SAMPLES) fit('hook', withHr.map((id) => hookSample(id, hookRate.get(id)! >= hrMedian ? 1 : 0)), ['hook_stop', 'hook_corpus', 'hook_fit'], 'hook_rate');
  else fit('hook', hookIds.filter((id) => outcome.has(id)).map((id) => hookSample(id, outcome.get(id)!)), ['hook_stop', 'hook_corpus', 'hook_fit'], 'corpus');

  fit('message', labeled.filter((id) => sec(id, 'message')).map((id) => ({ x: { message_angle: sec(id, 'message')!.angle_strength, message_fit: sec(id, 'message')!.positioning_fit }, y: outcome.get(id)! })), ['message_angle', 'message_fit'], 'corpus');
  fit('format', labeled.filter((id) => sec(id, 'visual_format')).map((id) => ({ x: { format_repro: sec(id, 'visual_format')!.reproducibility, format_corpus: sec(id, 'visual_format')!.corpus_score }, y: outcome.get(id)! })), ['format_repro', 'format_corpus'], 'corpus');

  await db().from('jev_products').update({ weights }).eq('id', productId);
  return { weights, report };
}


/** Manual Win / Loss / Neutral label for a generated output (feeds learning). */
export async function recordManualOutcome(
  outputId: string,
  label: 'win' | 'loss' | 'unknown',
): Promise<{ ok: true; outputId: string; label: string }> {
  const out = must(await db().from('jev_outputs').select('id, product_id, concept_id').eq('id', outputId).single()) as {
    id: string; product_id: string; concept_id: string;
  };
  await db().from('jev_labels').insert({
    kind: 'manual_outcome',
    target_id: outputId,
    value: { label, source: 'review_ui' },
  });
  // Soft status hint on output
  const status = label === 'win' ? 'ready' : label === 'loss' ? 'rejected' : 'review';
  await db().from('jev_outputs').update({ status }).eq('id', outputId);
  // Gate human override when decisive
  if (label === 'win' || label === 'loss') {
    await db().from('jev_gate_results').insert({
      target_type: 'output',
      target_id: outputId,
      stage: 'output',
      decision: label === 'win' ? 'pass' : 'reject',
      human_override: label === 'win' ? 'approve' : 'reject',
      override_reason: 'manual_review',
      reasons: [],
      warnings: [],
    });
  }
  return { ok: true, outputId, label };
}
