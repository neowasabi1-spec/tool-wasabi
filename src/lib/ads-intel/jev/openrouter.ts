import { z } from 'zod';
import { env } from './env';
import { logUsage } from './usage';
import { fetchRetry, HttpError } from './retry';

const BASE = 'https://openrouter.ai/api/v1';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string } };

export type Message = { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] };

export type ChatOpts = {
  model: string;
  messages: Message[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  tools?: unknown[];
  toolChoice?: unknown;
  purpose: string;
  projectId?: string | null;
};

type ChatResult = { content: string; toolCalls: { name: string; arguments: string }[]; finishReason: string | null };

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetchRetry(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.openrouterKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'jev-facebook-creative',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(`OpenRouter ${path} ${res.status}: ${text.slice(0, 500)}`, res.status);
  return JSON.parse(text);
}

export async function chat(o: ChatOpts): Promise<ChatResult> {
  const data = await post('/chat/completions', {
    model: o.model,
    messages: o.messages,
    max_tokens: o.maxTokens ?? 4000,
    temperature: o.temperature ?? 0.7,
    ...(o.json ? { response_format: { type: 'json_object' } } : {}),
    ...(o.tools ? { tools: o.tools, tool_choice: o.toolChoice ?? 'auto' } : {}),
    usage: { include: true },
  });
  await logUsage({
    projectId: o.projectId,
    provider: 'openrouter',
    model: o.model,
    purpose: o.purpose,
    usage: { input_tokens: data.usage?.prompt_tokens, output_tokens: data.usage?.completion_tokens, cost: data.usage?.cost },
  });
  const msg = data.choices?.[0]?.message ?? {};
  return {
    finishReason: data.choices?.[0]?.finish_reason ?? data.choices?.[0]?.native_finish_reason ?? null,
    content: typeof msg.content === 'string' ? msg.content : '',
    toolCalls: (msg.tool_calls ?? []).map((t: any) => ({ name: t.function?.name, arguments: t.function?.arguments ?? '{}' })),
  };
}

/** Estrae il primo oggetto JSON da una risposta, anche se avvolto in ```json. */
export function parseJsonLoose(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[\[{]/);
  if (start < 0) throw new Error('Nessun JSON nella risposta');
  const open = raw[start];
  const close = open === '{' ? '}' : ']';
  const end = raw.lastIndexOf(close);
  return JSON.parse(raw.slice(start, end + 1));
}

/** Chat con output JSON validato; un secondo tentativo passa al modello l'errore di validazione. */
export async function chatJson<T>(o: ChatOpts, schema: z.ZodType<T>): Promise<T> {
  let messages = o.messages;
  let maxTokens = o.maxTokens ?? 4000;
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const { content, finishReason } = await chat({ ...o, messages, maxTokens, json: true });
    try {
      return schema.parse(parseJsonLoose(content));
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      console.warn(`[${o.purpose}] JSON non valido (finish_reason=${finishReason}): ${lastErr.slice(0, 160)}`);
      if (finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'MAX_TOKENS') {
        // risposta tagliata per lunghezza: stessa richiesta con più spazio, non una correzione
        lastErr = `risposta troncata (finish_reason=${finishReason}, max_tokens=${maxTokens})`;
        console.warn(`[${o.purpose}] ${lastErr}: riprovo con più spazio`);
        maxTokens = Math.min(maxTokens * 2, 32000);
        continue;
      }
      messages = [
        ...o.messages,
        { role: 'assistant', content },
        { role: 'user', content: `Il JSON non è valido: ${lastErr.slice(0, 1500)}\nRestituisci SOLO il JSON corretto.` },
      ];
    }
  }
  throw new Error(`Output JSON non valido dopo 3 tentativi: ${lastErr.slice(0, 500)}`);
}

export async function embed(texts: string[], purpose = 'embedding', projectId?: string | null): Promise<number[][]> {
  if (!texts.length) return [];
  const data = await post('/embeddings', { model: env.embeddingModel, input: texts.map((t) => t.slice(0, 20000)) });
  await logUsage({ projectId, provider: 'openrouter', model: env.embeddingModel, purpose, usage: { input_tokens: data.usage?.prompt_tokens, cost: data.usage?.cost } });
  return (data.data as { embedding: number[]; index: number }[]).sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embedOne(text: string, purpose?: string, projectId?: string | null) {
  return (await embed([text], purpose, projectId))[0];
}

/**
 * Campi tolleranti per gli schemi di estrazione: i modelli a volte restituiscono una lista dove ci si aspetta testo
 * (o viceversa). Si normalizza invece di rifiutare l'intera risposta.
 */
export const looseString = z.preprocess(
  (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ') : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)),
  z.string(),
);
export const looseStringArray = z.preprocess(
  (v) => (v == null ? [] : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [String(v)]),
  z.array(z.string()),
);
export const looseNumber = z.preprocess((v) => (v == null || v === '' ? 0 : typeof v === 'string' ? Number(v.replace(',', '.')) : v), z.number());
export const looseBool = z.preprocess((v) => (v == null ? false : typeof v === 'string' ? /^(true|yes|sì|si|1)$/i.test(v.trim()) : Boolean(v)), z.boolean());

/** Genera un'immagine quadrata 1:1 dal prompt (endpoint immagini di OpenRouter). */
export async function generateImage(prompt: string, o: { purpose: string; projectId?: string | null; model?: string }): Promise<Buffer> {
  const model = o.model ?? env.imageModel;
  const data = await post('/images/generations', { model, prompt, size: '1024x1024', n: 1, quality: 'high' });
  await logUsage({
    projectId: o.projectId,
    provider: 'openrouter',
    model,
    purpose: o.purpose,
    usage: { input_tokens: data.usage?.prompt_tokens, output_tokens: data.usage?.completion_tokens, cost: data.usage?.cost },
  });
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error(`Nessuna immagine nella risposta di ${model}`);
  return Buffer.from(b64, 'base64');
}

/**
 * Embedding visivo di immagini passate come data URL (base64): il modello non deve scaricare nulla, quindi non
 * dipende dallo Storage. Un gruppo che fallisce viene ritentato immagine per immagine; quelle non valide → null.
 */
export async function embedImages(dataUrls: string[], projectId?: string | null, batchSize = 8): Promise<(number[] | null)[]> {
  const call = async (batch: string[]) => {
    const data = await post('/embeddings', { model: env.imageEmbeddingModel, input: batch.map((url) => ({ content: [{ type: 'image_url', image_url: { url } }] })), encoding_format: 'float' });
    await logUsage({ projectId, provider: 'openrouter', model: env.imageEmbeddingModel, purpose: 'embed:image', usage: { input_tokens: data.usage?.prompt_tokens, cost: data.usage?.cost } });
    return (data.data as { embedding: number[]; index: number }[]).sort((a, b) => a.index - b.index).map((d) => d.embedding);
  };
  const out: (number[] | null)[] = [];
  for (let i = 0; i < dataUrls.length; i += batchSize) {
    const batch = dataUrls.slice(i, i + batchSize);
    try {
      out.push(...(await call(batch)));
    } catch (e) {
      console.warn(`[embed:image] gruppo fallito, riprovo una per una: ${e instanceof Error ? e.message.slice(0, 160) : e}`);
      for (const u of batch) out.push(await call([u]).then((r) => r[0]).catch(() => null));
    }
  }
  return out;
}
