import { supabase } from './supabase';

const OPENCLAW_DEFAULTS = {
  baseUrl: 'https://articles-meeting-shown-pools.trycloudflare.com',
  apiKey: 'a353475b70538480030b744771524d183521a46ab8db7b02a2846d1103bc5734',
  model: 'openclaw:neo',
};

let _cachedConfig: typeof OPENCLAW_DEFAULTS | null = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute cache

export async function getOpenClawConfig() {
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
