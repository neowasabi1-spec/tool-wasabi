/**
 * Temporary, secret-gated probe of what AI credentials this deploy actually has.
 *
 * The CLI cannot list platform-injected variables, so the only way to know
 * whether the AI Gateway is wiring OpenAI/Gemini/Anthropic here — and which
 * endpoints it will answer on — is to ask from inside a running function.
 * Reports presence and shape only, never a value.
 */
export default async (req: Request) => {
  const secret = process.env.DASHBOARD_API_SECRET || '';
  if (!secret || req.headers.get('x-probe-secret') !== secret) {
    return new Response('not found', { status: 404 });
  }

  const shape = (v?: string) =>
    v ? { set: true, len: v.length, head: v.slice(0, 8) } : { set: false };

  const env: Record<string, unknown> = {};
  for (const k of [
    'OPENAI_API_KEY', 'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
    'GEMINI_API_KEY', 'GOOGLE_GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL',
    'NETLIFY_AI_GATEWAY_BASE_URL', 'NETLIFY_AI_GATEWAY_KEY',
    'REPLICATE_API_TOKEN', 'APIFY_KEY',
  ]) env[k] = shape(process.env[k]);

  const tries: Record<string, unknown> = {};
  const probe = async (name: string, url: string, init: RequestInit) => {
    try {
      const r = await fetch(url, init);
      const body = await r.text();
      tries[name] = { status: r.status, body: body.slice(0, 220) };
    } catch (e) {
      tries[name] = { error: (e as Error).message };
    }
  };

  const oKey = process.env.OPENAI_API_KEY || '';
  const oBase = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
  const json = { 'Content-Type': 'application/json' };
  const chat = (model: string) => JSON.stringify({
    model, max_tokens: 5, messages: [{ role: 'user', content: 'say ok' }],
  });

  if (oBase) {
    await probe('openai_chat_via_gateway', `${oBase}/chat/completions`,
      { method: 'POST', headers: { ...json, Authorization: `Bearer ${oKey}` }, body: chat('gpt-4o-mini') });
    await probe('openai_tts_via_gateway', `${oBase}/audio/speech`, {
      method: 'POST', headers: { ...json, Authorization: `Bearer ${oKey}` },
      body: JSON.stringify({ model: 'tts-1', voice: 'alloy', input: 'hi', response_format: 'mp3' }),
    });
  }

  const gBase = (process.env.GOOGLE_GEMINI_BASE_URL || '').replace(/\/$/, '');
  const gKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || '';
  if (gBase) {
    await probe('gemini_via_gateway', `${gBase}/v1beta/models/gemini-2.5-flash:generateContent`, {
      method: 'POST',
      headers: { ...json, 'x-goog-api-key': gKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'say ok' }] }] }),
    });
  }

  return new Response(JSON.stringify({ env, tries }, null, 2), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};
