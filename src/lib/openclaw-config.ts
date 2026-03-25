import { supabase } from './supabase';

const OPENCLAW_DEFAULTS = {
  baseUrl: 'https://articles-meeting-shown-pools.trycloudflare.com',
  apiKey: 'a353475b70538480030b744771524d183521a46ab8db7b02a2846d1103bc5734',
  model: 'openclaw:neo',
};

let _cachedConfig: typeof OPENCLAW_DEFAULTS | null = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000;

export async function getOpenClawConfig() {
  if (_cachedConfig && Date.now() - _cacheTime < CACHE_TTL) {
    return _cachedConfig;
  }

  // Priority 1: Environment variables (always win — set in .env.local or Vercel)
  const envUrl = process.env.OPENCLAW_BASE_URL;
  const envKey = process.env.OPENCLAW_API_KEY;
  const envModel = process.env.OPENCLAW_MODEL;

  if (envUrl && envKey) {
    _cachedConfig = {
      baseUrl: envUrl.replace(/\/+$/, ''),
      apiKey: envKey,
      model: envModel || OPENCLAW_DEFAULTS.model,
    };
    _cacheTime = Date.now();
    console.log(`[openclaw-config] Using ENV vars → ${_cachedConfig.baseUrl}`);
    return _cachedConfig;
  }

  // Priority 2: Supabase settings table
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
      console.log(`[openclaw-config] Using Supabase settings → ${_cachedConfig.baseUrl}`);
      return _cachedConfig;
    }
  } catch {
    // Supabase not available or table doesn't exist
  }

  // Priority 3: Hardcoded defaults
  console.log(`[openclaw-config] Using hardcoded defaults → ${OPENCLAW_DEFAULTS.baseUrl}`);
  return OPENCLAW_DEFAULTS;
}
