const version = () => (process.env.META_GRAPH_VERSION || 'v23.0').trim();

export async function graphGet(
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<any> {
  const url = path.startsWith('http')
    ? new URL(path)
    : new URL(`https://graph.facebook.com/${version()}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
  const res = await fetch(url.toString());
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Graph ${path}: ${data.error?.message ?? res.status}`);
  }
  return data;
}

export function metaAppId(): string {
  return (process.env.META_APP_ID || '').trim();
}

export function metaAppSecret(): string {
  return (process.env.META_APP_SECRET || '').trim();
}

/** Prefer user connection token; fall back to env spike for local autonomy. */
export function envSpikeToken(): string {
  return (process.env.META_ACCESS_TOKEN || '').trim();
}

export function envSpikeAdAccount(): string {
  const a = (process.env.META_AD_ACCOUNT_ID || '').trim();
  if (!a) return '';
  return a.startsWith('act_') ? a : `act_${a}`;
}
