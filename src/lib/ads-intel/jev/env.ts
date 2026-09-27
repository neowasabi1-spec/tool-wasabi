/** Env for Jev port — reads Wasabi process.env */
function req(name: string, fallback = ''): string {
  return (process.env[name] || fallback).trim();
}

export const env = {
  get supabaseUrl() { return req('NEXT_PUBLIC_SUPABASE_URL') || req('SUPABASE_URL'); },
  get supabaseKey() { return req('SUPABASE_SERVICE_ROLE_KEY'); },
  get openrouterKey() { return req('OPENROUTER_API_KEY'); },
  get jevModel() { return req('JEV_MODEL', 'typesafe/jev-1.13'); },
  get jevEndpoint() { return req('JEV_ENDPOINT', 'https://openrouter.ai/api/alpha/decisions'); },
  get judgeEngine() { return (req('JUDGE_ENGINE', 'jev') === 'claude' ? 'claude' : 'jev') as 'jev' | 'claude'; },
  get writerModel() { return req('WRITER_MODEL', 'anthropic/claude-sonnet-5'); },
  get visualWriterModel() { return req('VISUAL_WRITER_MODEL', 'anthropic/claude-opus-5.5'); },
  get visionModel() { return req('VISION_MODEL', 'google/gemini-2.5-flash'); },
  get embeddingModel() { return req('EMBEDDING_MODEL', 'baai/bge-m3'); },
  get imageEmbeddingModel() { return req('IMAGE_EMBEDDING_MODEL', 'voyage/voyage-multimodal-3'); },
  get imageModel() { return req('IMAGE_MODEL', 'openai/gpt-image-2'); },
  get graphVersion() { return req('META_GRAPH_VERSION', 'v23.0'); },
  get appSecret() {
    return req('META_TOKEN_ENCRYPTION_KEY') || req('DASHBOARD_API_SECRET') || req('APP_SECRET') || 'dev-insecure';
  },
};
