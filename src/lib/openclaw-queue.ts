const OPENCLAW_BASE_URL = process.env.OPENCLAW_BASE_URL || 'https://makes-continues-identify-uniform.trycloudflare.com';
const OPENCLAW_API_KEY = process.env.OPENCLAW_API_KEY || 'a353475b70538480030b744771524d183521a46ab8db7b02a2846d1103bc5734';
const OPENCLAW_MODEL = process.env.OPENCLAW_MODEL || 'merlino';

/**
 * Call OpenClaw directly via HTTP (OpenAI-compatible API).
 * Drop-in replacement for the old Supabase queue approach.
 */
export async function queueAndWait(
  userMessage: string,
  opts: {
    systemPrompt?: string;
    section?: string;
    chatHistory?: { role: string; content: string }[];
    timeoutMs?: number;
  } = {},
): Promise<string> {
  if (!OPENCLAW_BASE_URL) {
    throw new Error('OPENCLAW_BASE_URL not configured');
  }

  const messages: { role: string; content: string }[] = [];

  if (opts.systemPrompt) {
    messages.push({ role: 'system', content: opts.systemPrompt });
  }

  if (opts.chatHistory && opts.chatHistory.length > 0) {
    for (const h of opts.chatHistory) {
      messages.push({ role: h.role, content: h.content });
    }
  }

  messages.push({ role: 'user', content: userMessage });

  const url = `${OPENCLAW_BASE_URL.replace(/\/$/, '')}/v1/chat/completions`;
  const timeout = opts.timeoutMs ?? 120_000;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENCLAW_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENCLAW_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenClaw HTTP ${res.status}: ${body.substring(0, 300)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';

  if (!content) {
    throw new Error('OpenClaw returned empty response');
  }

  return content;
}
