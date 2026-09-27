/** Un criterio può essere testo o un oggetto strutturato (what / not_for / examples), come da documentazione TypeSafe. */
export type Criterion = string | { what: string; not_for?: string; examples?: string[] };
export type Instructions = string | { question: string; focus?: string };

export type Question =
  | { type: 'score'; instructions: Instructions; criteria: [Criterion, Criterion, Criterion] }
  | { type: 'noul'; instructions: Instructions; criteria: { true: Criterion; false: Criterion } }
  | { type: 'choice'; instructions: Instructions; criteria: Record<string, Criterion> };

export type QuestionSet = Record<string, Question>;

/**
 * Risposta normalizzata.
 * - noul:   value = true/false, pTrue = probabilità di "true"
 * - choice: value = opzione scelta, probs = probabilità per opzione
 * - score:  value = punteggio 0..2 (può essere decimale), probs per livello "0","1","2"
 * p = fiducia sulla risposta data.
 */
export type Answer = {
  type: Question['type'];
  value: boolean | string | number;
  p: number;
  pTrue?: number;
  probs?: Record<string, number>;
};

export type Answers = Record<string, Answer>;

/** State: oggetto con sezioni nominate, citate nelle domande tra backtick (es. `ad`, `brand_rules`). */
export type State = Record<string, string>;

export interface JudgeEngine {
  name: 'jev' | 'claude';
  ask(state: State, questions: QuestionSet, meta: { purpose: string; projectId?: string | null }): Promise<Answers>;
}
