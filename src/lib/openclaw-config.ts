import { supabase } from './supabase';

const OPENCLAW_DEFAULTS = {
  baseUrl: 'https://lol-jacket-firefox-kinds.trycloudflare.com',
  apiKey: '76d0f4b9c277c5e457d64d908fc51fe0a2e8a93664b30806',
  model: 'openclaw:neo',
};

let _cachedConfig: typeof OPENCLAW_DEFAULTS | null = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute cache

export async function getOpenClawConfig() {
  // Check env vars first
  if (process.env.OPENCLAW_API_KEY && process.env.OPENCLAW_BASE_URL) {
    return {
      baseUrl: process.env.OPENCLAW_BASE_URL,
      apiKey: process.env.OPENCLAW_API_KEY,
      model: process.env.OPENCLAW_MODEL || OPENCLAW_DEFAULTS.model,
    };
  }

  // Return cache if fresh
  if (_cachedConfig && Date.now() - _cacheTime < CACHE_TTL) {
    return _cachedConfig;
  }

  // Try Supabase
  try {
    const { data } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'openclaw_config')
      .single();

    if (data?.value) {
      const config = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
      _cachedConfig = {
        baseUrl: config.baseUrl || OPENCLAW_DEFAULTS.baseUrl,
        apiKey: config.apiKey || OPENCLAW_DEFAULTS.apiKey,
        model: config.model || OPENCLAW_DEFAULTS.model,
      };
      _cacheTime = Date.now();
      return _cachedConfig;
    }
  } catch {
    // Supabase not available or table doesn't exist
  }

  return OPENCLAW_DEFAULTS;
}
