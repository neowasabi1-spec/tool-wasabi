import { db } from './db';

export type Usage = { input_tokens?: number; output_tokens?: number; cost?: number };

export async function logUsage(e: { projectId?: string | null; provider: string; model: string; purpose: string; usage?: Usage }) {
  await db().from('jev_usage_log').insert({
    project_id: e.projectId ?? null,
    provider: e.provider,
    model: e.model,
    purpose: e.purpose,
    input_tokens: e.usage?.input_tokens ?? null,
    output_tokens: e.usage?.output_tokens ?? null,
    cost: e.usage?.cost ?? null,
  });
}
