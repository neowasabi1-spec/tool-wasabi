/**
 * Temporary probe: reports, to the function logs only, which AI credentials this
 * deploy actually receives at runtime.
 *
 * The dashboard lists the keys as scoped to Functions, yet a background function
 * reads REPLICATE_API_TOKEN as empty and OpenAI rejects the injected key as
 * coming from the wrong issuer. Only the running process can settle that, so
 * this prints presence, length and the first few characters — never a value —
 * and returns an empty response so triggering it reveals nothing.
 */
export default async () => {
  const names = [
    'OPENAI_API_KEY', 'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'GEMINI_API_KEY', 'GOOGLE_GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL',
    'NETLIFY_AI_GATEWAY_BASE_URL', 'NETLIFY_AI_GATEWAY_KEY',
    'REPLICATE_API_TOKEN', 'APIFY_KEY',
    'SUPABASE_SERVICE_ROLE_KEY', 'DASHBOARD_API_SECRET',
  ];
  const log = (...a: unknown[]) => console.log('[ai-probe]', ...a);
  log('context:', process.env.CONTEXT, '| branch:', process.env.BRANCH, '| deploy:', process.env.DEPLOY_ID);
  for (const n of names) {
    const v = process.env[n];
    log(n, v ? `set len=${v.length} head=${v.slice(0, 6)}` : 'EMPTY');
  }

  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (key) {
    // Which endpoint accepts this key tells us whether it is a real OpenAI key
    // or a gateway token that only works against the gateway base URL.
    const targets: [string, string][] = [
      ['api.openai.com', 'https://api.openai.com/v1/models'],
    ];
    const base = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
    if (base) targets.push(['gateway', `${base}/models`]);
    for (const [label, url] of targets) {
      try {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
        log(`GET ${label} -> ${r.status} ${(await r.text()).slice(0, 120).replace(/\s+/g, ' ')}`);
      } catch (e) {
        log(`GET ${label} -> failed ${(e as Error).message}`);
      }
    }
  }

  const rep = (process.env.REPLICATE_API_TOKEN || '').trim();
  if (rep) {
    try {
      const r = await fetch('https://api.replicate.com/v1/account', {
        headers: { Authorization: `Bearer ${rep}` },
      });
      log(`GET replicate -> ${r.status} ${(await r.text()).slice(0, 120).replace(/\s+/g, ' ')}`);
    } catch (e) {
      log(`GET replicate -> failed ${(e as Error).message}`);
    }
  }

  return new Response(null, { status: 204 });
};
