import { db } from '../db';
import { env } from '../env';
import { claudeEngine } from './claude';
import { jevEngine } from './jev';
import type { Answer, Answers, JudgeEngine, QuestionSet, State } from './types';

export * from './types';

/** Contesto massimo di Jev: 32.000 token. Teniamo margine per le domande. */
export const STATE_TOKEN_BUDGET = 26000;
export const approxTokens = (s: string) => Math.ceil(s.length / 3.5);

export function engine(): JudgeEngine {
  return env.judgeEngine === 'claude' ? claudeEngine : jevEngine;
}

/** Assembla lo state con sezioni nominate; le sezioni opzionali vengono tagliate se si supera il budget. */
export function buildState(required: Record<string, string>, optional: Record<string, string[]> = {}): State {
  const state: State = Object.fromEntries(Object.entries(required).map(([k, v]) => [k, v.trim()]));
  for (const [name, items] of Object.entries(optional)) {
    const kept: string[] = [];
    for (const it of items) {
      const trial = { ...state, [name]: [...kept, it].join('\n---\n') };
      if (approxTokens(JSON.stringify(trial)) > STATE_TOKEN_BUDGET) break;
      kept.push(it);
    }
    if (kept.length) state[name] = kept.join('\n---\n');
  }
  return state;
}

/** Chiede e salva le risposte. Con Jev in errore si può ripiegare su Claude impostando JUDGE_ENGINE=claude. */
export async function judge(
  target: { type: string; id: string },
  questionSet: string,
  state: State,
  questions: QuestionSet,
  projectId?: string | null,
): Promise<Answers> {
  const eng = engine();
  const answers = await eng.ask(state, questions, { purpose: `judge:${questionSet}`, projectId });
  const rows = Object.entries(answers).map(([key, a]) => ({
    target_type: target.type,
    target_id: target.id,
    question_set: questionSet,
    key,
    value: a.value,
    p: a.p,
    raw: a,
    engine: eng.name,
  }));
  await db().from('jev_judgments').delete().eq('target_type', target.type).eq('target_id', target.id).eq('question_set', questionSet);
  if (rows.length) await db().from('jev_judgments').insert(rows);
  return answers;
}

/** Punteggio 0..2 normalizzato a 0..1. */
export const norm = (a?: Answer) => (a && typeof a.value === 'number' ? Math.max(0, Math.min(1, a.value / 2)) : 0);

/** Probabilità che la risposta sia "buona" secondo la regola della domanda. */
export function pOk(a: Answer, rule: { goodNoul?: boolean; minScore?: number }): number {
  if (a.type === 'noul') {
    const pTrue = a.pTrue ?? (a.value ? a.p : 1 - a.p);
    return rule.goodNoul === false ? 1 - pTrue : pTrue;
  }
  if (a.type === 'score') {
    const min = rule.minScore ?? 1;
    if (a.probs && Object.keys(a.probs).length) {
      return Object.entries(a.probs).reduce((s, [lvl, p]) => (Number(lvl) >= min ? s + Number(p) : s), 0);
    }
    return Number(a.value) >= min ? a.p : 1 - a.p;
  }
  return a.p;
}
