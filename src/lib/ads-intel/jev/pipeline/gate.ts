import { db } from '../db';
import { pOk, type Answers } from '../judge';
import { BLOCKING_RULES, INFORMATIVE } from '../judge/questions';
import type { Thresholds } from '../settings';
import { cosine } from '../vectors';

export type Distance = {
  status: 'ok' | 'copy' | 'lost' | 'unknown';
  toSource: number | null;   // somiglianza massima con le creatività sorgente
  toHistory: number | null;  // somiglianza massima con ciò che abbiamo già prodotto
  toBatch?: number | null;
  imageHamming?: number | null;
  visualSimilarity?: number | null;
  note?: string;
};

export function distanceCheck(vec: number[], sources: number[][], history: number[][], th: Thresholds): Distance {
  const max = (xs: number[][]) => (xs.length ? Math.max(...xs.map((x) => cosine(vec, x))) : null);
  const toSource = max(sources);
  const toHistory = max(history);
  let status: Distance['status'] = 'ok';
  let note: string | undefined;
  if (toSource != null && toSource >= th.copySimilarity) { status = 'copy'; note = `troppo simile alla sorgente (${toSource.toFixed(2)})`; }
  else if (toHistory != null && toHistory >= th.copySimilarity) { status = 'copy'; note = `ripete un output già prodotto (${toHistory.toFixed(2)})`; }
  else if (toSource != null && toSource < th.lostSimilarity) { status = 'lost'; note = `lontano dalla sorgente (${toSource.toFixed(2)}): il meccanismo potrebbe essersi perso`; }
  else if (toSource == null) status = 'unknown';
  return { status, toSource, toHistory, note };
}

export type GateResult = {
  decision: 'pass' | 'review' | 'reject';
  reasons: string[];
  warnings: string[];
  reject_kind: 'off_brand' | 'copy' | 'weak' | null;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Instradamento a tre fasce. Claim e policy sono solo avvisi: non bloccano mai. */
type Rule = { goodNoul?: boolean; minScore?: number; hardReject?: boolean; reviewOnly?: boolean };

/** `overrides` cambia la regola di singole domande per uno stadio (es. i concept sono brief, non prompt finiti). */
export function route(answers: Answers, distance: Distance | null, th: Thresholds, overrides: Record<string, Rule> = {}): GateResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let decision: GateResult['decision'] = 'pass';
  let reject_kind: GateResult['reject_kind'] = null;
  const worse = (d: GateResult['decision']) => {
    const order = { pass: 0, review: 1, reject: 2 };
    if (order[d] > order[decision]) decision = d;
  };

  for (const [key, a] of Object.entries(answers)) {
    if (INFORMATIVE.has(key)) {
      const flagged = a.type === 'noul' ? (a.pTrue ?? 0) >= 0.5 : a.type === 'score' ? Number(a.value) >= 1.5 : false;
      if (flagged) warnings.push(`${key}: ${a.type === 'noul' ? `sì (${pct(a.pTrue ?? 0)})` : `livello ${Number(a.value).toFixed(1)}`}`);
      continue;
    }
    const rule = overrides[key] ?? BLOCKING_RULES[key];
    if (!rule) continue;
    const ok = pOk(a, rule);
    if (rule.reviewOnly) {
      if (ok < th.pass) { worse('review'); reasons.push(`${key}: da verificare (${pct(ok)} di esito positivo)`); }
      continue;
    }
    if (rule.hardReject && 1 - ok > th.pass) {
      worse('reject'); reject_kind = 'off_brand';
      reasons.push(`${key}: conflitto con le regole del brand (${pct(1 - ok)})`);
    } else if (ok < th.review) {
      worse('reject'); reject_kind ??= key === 'brief_completeness' ? 'weak' : 'off_brand';
      reasons.push(`${key}: ${pct(ok)} di esito positivo`);
    } else if (ok < th.pass) {
      worse('review');
      reasons.push(`${key}: incerto (${pct(ok)})`);
    }
  }

  if (distance?.status === 'copy') { worse('reject'); reject_kind = 'copy'; reasons.push(distance.note ?? 'copia'); }
  if (distance?.status === 'lost') { worse('review'); reasons.push(distance.note ?? 'meccanismo perso'); }
  if (distance?.imageHamming != null && distance.imageHamming <= th.dhashCopy) {
    worse('reject'); reject_kind = 'copy'; reasons.push(`immagine quasi identica alla sorgente (Hamming ${distance.imageHamming})`);
  }
  return { decision, reasons, warnings, reject_kind };
}

export async function saveGate(target: { type: 'concept' | 'output'; id: string }, stage: 'prompt' | 'output', r: GateResult, distance: Distance | null) {
  await db().from('jev_gate_results').insert({
    target_type: target.type, target_id: target.id, stage,
    decision: r.decision, reasons: r.reasons, warnings: r.warnings, reject_kind: r.reject_kind, distance,
  });
}
