import { env } from '../env';
import { getFbToken } from '../settings';
import { fetchRetry } from '../retry';
import { envSpikeToken } from '@/lib/ads-intel/meta/graph';

export async function fbToken(): Promise<string> {
  try {
    const t = await getFbToken();
    if (t?.token) return t.token;
  } catch {
    /* fall through */
  }
  const spike = envSpikeToken();
  if (spike) return spike;
  throw new Error('Facebook token not configured (OAuth connect or META_ACCESS_TOKEN).');
}

export async function graphGet(path: string, params: Record<string, string>, token?: string): Promise<any> {
  const tok = token ?? (await fbToken());
  const url = path.startsWith('http')
    ? new URL(path)
    : new URL(`https://graph.facebook.com/${env.graphVersion}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', tok);
  const res = await fetchRetry(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Graph ${path}: ${data.error?.message ?? res.status}`);
  return data;
}

export async function debugToken(token: string): Promise<{ valid: boolean; expiresAt: string | null; error?: string }> {
  try {
    const d = await graphGet('debug_token', { input_token: token }, token);
    const exp = d.data?.expires_at;
    return { valid: !!d.data?.is_valid, expiresAt: exp ? new Date(exp * 1000).toISOString() : null };
  } catch (e) {
    return { valid: false, expiresAt: null, error: e instanceof Error ? e.message : String(e) };
  }
}
