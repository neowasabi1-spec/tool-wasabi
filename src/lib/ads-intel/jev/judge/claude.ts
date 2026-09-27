import { env } from '../env';
import { chat, parseJsonLoose } from '../openrouter';
import type { Answers, JudgeEngine, QuestionSet } from './types';

/**
 * Ripiego: Claude con tool schema forzato. Le probabilità sono dichiarate dal modello,
 * NON calibrate: le soglie vanno tenute separate da quelle di Jev.
 */
export const claudeEngine: JudgeEngine = {
  name: 'claude',
  async ask(state, questions, meta) {
    const props: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(questions)) {
      const probsFor = q.type === 'noul' ? ['true', 'false'] : q.type === 'choice' ? Object.keys(q.criteria) : ['0', '1', '2'];
      props[key] = {
        type: 'object',
        properties: {
          probabilities: {
            type: 'object',
            properties: Object.fromEntries(probsFor.map((k) => [k, { type: 'number', minimum: 0, maximum: 1 }])),
            required: probsFor,
          },
        },
        required: ['probabilities'],
      };
    }
    const questionText = Object.entries(questions)
      .map(([key, q]) => {
        const fmt = (c: unknown) => (typeof c === 'string' ? c : JSON.stringify(c));
        const crit = q.type === 'score'
          ? q.criteria.map((c, i) => `  ${i}: ${fmt(c)}`).join('\n')
          : Object.entries(q.criteria).map(([k, c]) => `  ${k}: ${fmt(c)}`).join('\n');
        return `- ${key} (${q.type}): ${fmt(q.instructions)}\n${crit}`;
      })
      .join('\n');

    const { toolCalls, content } = await chat({
      model: env.writerModel,
      purpose: meta.purpose,
      projectId: meta.projectId,
      temperature: 0,
      maxTokens: 3000,
      messages: [
        { role: 'system', content: 'Sei un valutatore. Per ogni domanda assegna una distribuzione di probabilità sulle opzioni (somma 1). Non scrivere altro.' },
        { role: 'user', content: `STATE:\n${Object.entries(state).map(([k, v]) => `## ${k}\n${v}`).join('\n\n')}\n\nDOMANDE:\n${questionText}` },
      ],
      tools: [{ type: 'function', function: { name: 'answer', description: 'Risposte tipizzate', parameters: { type: 'object', properties: props, required: Object.keys(questions) } } }],
      toolChoice: { type: 'function', function: { name: 'answer' } },
    });
    const raw = (toolCalls[0] ? JSON.parse(toolCalls[0].arguments) : parseJsonLoose(content)) as Record<string, { probabilities: Record<string, number> }>;

    const out: Answers = {};
    for (const [key, q] of Object.entries(questions)) {
      const probs = raw[key]?.probabilities ?? {};
      if (q.type === 'noul') {
        const pTrue = Number(probs.true ?? 0);
        out[key] = { type: 'noul', value: pTrue >= 0.5, pTrue, p: Math.max(pTrue, 1 - pTrue) };
      } else if (q.type === 'choice') {
        const [best, p] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
        out[key] = { type: 'choice', value: best, probs, p };
      } else {
        const score = [0, 1, 2].reduce((s, i) => s + i * Number(probs[String(i)] ?? 0), 0);
        const p = Math.max(...[0, 1, 2].map((i) => Number(probs[String(i)] ?? 0)));
        out[key] = { type: 'score', value: score, probs, p };
      }
    }
    return out;
  },
};
