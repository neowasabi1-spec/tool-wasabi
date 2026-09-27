import { env } from '../env';
import { logUsage } from '../usage';
import { fetchRetry, HttpError } from '../retry';
import type { Answers, JudgeEngine, QuestionSet } from './types';

/**
 * Jev (TypeSafe). Formato della richiesta: { model, state, questions } — non il formato chat.
 * Risposta: answers[key] = { type, noul } | { type, choice, probabilities, confidence } | { type, score, probabilities, confidence }.
 */
export const jevEngine: JudgeEngine = {
  name: 'jev',
  async ask(state, questions, meta) {
    const res = await fetchRetry(env.jevEndpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.openrouterKey}`, 'Content-Type': 'application/json', 'X-Title': 'jev-facebook-creative' },
      body: JSON.stringify({ model: env.jevModel, state, questions }),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(`Jev ${res.status}: ${text.slice(0, 400)}`, res.status);
    const data = JSON.parse(text);
    await logUsage({ projectId: meta.projectId, provider: 'jev', model: env.jevModel, purpose: meta.purpose, usage: data.usage });

    const out: Answers = {};
    for (const [key, q] of Object.entries(questions)) {
      const a = data.answers?.[key];
      if (!a) throw new Error(`Jev: risposta mancante per ${key}`);
      if (q.type === 'noul') {
        const pTrue = Number(a.noul);
        out[key] = { type: 'noul', value: pTrue >= 0.5, pTrue, p: pTrue >= 0.5 ? pTrue : 1 - pTrue };
      } else if (q.type === 'choice') {
        const probs = a.probabilities ?? {};
        out[key] = { type: 'choice', value: a.choice, probs, p: Number(probs[a.choice] ?? a.confidence ?? 0) };
      } else {
        out[key] = { type: 'score', value: Number(a.score), probs: a.probabilities ?? {}, p: Number(a.confidence ?? 0) };
      }
    }
    return out;
  },
};
