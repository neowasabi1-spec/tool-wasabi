/**
 * Thin OpenRouter client for ads-intel (Jev judge / writers / vision).
 * Does not replace Anthropic/Gemini used elsewhere in Wasabi.
 */

const BASE = 'https://openrouter.ai/api/v1';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type OrMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
};

function openrouterKey(): string {
  return (process.env.OPENROUTER_API_KEY || '').trim();
}

export function hasOpenRouter(): boolean {
  return Boolean(openrouterKey());
}

export function jevModel(): string {
  return (process.env.JEV_MODEL || 'typesafe/jev-1.13').trim();
}

export function visionModel(): string {
  return (process.env.VISION_MODEL || 'google/gemini-2.5-flash').trim();
}

export function writerModel(): string {
  return (process.env.WRITER_MODEL || 'anthropic/claude-sonnet-4').trim();
}

export function judgeEngine(): 'jev' | 'claude' {
  return process.env.JUDGE_ENGINE === 'claude' ? 'claude' : 'jev';
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const key = openrouterKey();
  if (!key) throw new Error('OPENROUTER_API_KEY is not configured');

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'tool-wasabi-ads-intel',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenRouter ${path} ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export async function openrouterChat(opts: {
  model: string;
  messages: OrMessage[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const data = await post('/chat/completions', {
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 4000,
    temperature: opts.temperature ?? 0.4,
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
  });
  const choices = data.choices as { message?: { content?: string } }[] | undefined;
  const content = choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

export async function jevDecide(opts: {
  state: string;
  questions: { id: string; text: string }[];
}): Promise<{ answers: Record<string, unknown>; raw: unknown }> {
  const endpoint =
    (process.env.JEV_ENDPOINT || 'https://openrouter.ai/api/alpha/decisions').trim();
  const key = openrouterKey();
  if (!key) throw new Error('OPENROUTER_API_KEY is not configured');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'tool-wasabi-ads-intel',
    },
    body: JSON.stringify({
      model: jevModel(),
      state: opts.state,
      questions: opts.questions,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Jev Decisions ${res.status}: ${text.slice(0, 400)}`);
  }
  const raw = JSON.parse(text) as Record<string, unknown>;
  const answers =
    (raw.answers as Record<string, unknown>) ||
    (raw.result as Record<string, unknown>) ||
    raw;
  return { answers, raw };
}

export function parseJsonLoose(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[\[{]/);
  if (start < 0) throw new Error('No JSON in model response');
  const open = raw[start];
  const close = open === '{' ? '}' : ']';
  const end = raw.lastIndexOf(close);
  return JSON.parse(raw.slice(start, end + 1));
}
