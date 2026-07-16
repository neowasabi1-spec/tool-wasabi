/**
 * Persistence for the OAuth authorization server: registered clients (DCR),
 * short-lived authorization codes, and refresh tokens.
 *
 * Backed by Netlify Blobs in production (shared across serverless
 * invocations), with an in-process Map fallback for plain `next dev`.
 *
 * Access tokens are NOT stored here — they are stateless signed JWTs.
 */

type NetlifyStore = {
  get: (key: string, opts?: { type?: 'json' | 'text' }) => Promise<unknown>;
  setJSON: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

const memory: Record<string, Map<string, unknown>> = {};

async function store(namespace: string): Promise<
  | { kind: 'blob'; s: NetlifyStore }
  | { kind: 'mem'; s: Map<string, unknown> }
> {
  try {
    const mod = await import(/* webpackIgnore: true */ '@netlify/blobs');
    return { kind: 'blob', s: mod.getStore(namespace) as unknown as NetlifyStore };
  } catch {
    if (!memory[namespace]) memory[namespace] = new Map();
    return { kind: 'mem', s: memory[namespace] };
  }
}

async function put(namespace: string, key: string, value: unknown): Promise<void> {
  const st = await store(namespace);
  if (st.kind === 'blob') await st.s.setJSON(key, value);
  else st.s.set(key, value);
}

async function read<T>(namespace: string, key: string): Promise<T | null> {
  const st = await store(namespace);
  if (st.kind === 'blob') return ((await st.s.get(key, { type: 'json' })) as T) ?? null;
  return (st.s.get(key) as T) ?? null;
}

async function remove(namespace: string, key: string): Promise<void> {
  const st = await store(namespace);
  if (st.kind === 'blob') await st.s.delete(key);
  else st.s.delete(key);
}

const NS_CLIENTS = 'mcp-oauth-clients';
const NS_CODES = 'mcp-oauth-codes';
const NS_REFRESH = 'mcp-oauth-refresh';

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  tokenEndpointAuthMethod: 'none';
  createdAt: number;
}

export interface AuthCodeData {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256' | 'plain';
  userId: string;
  scope: string;
  exp: number;
}

export interface RefreshData {
  clientId: string;
  userId: string;
  scope: string;
  exp: number;
}

// ── Clients ────────────────────────────────────────────────────────────
export async function saveClient(client: OAuthClient): Promise<void> {
  await put(NS_CLIENTS, client.clientId, client);
}
export async function getClient(clientId: string): Promise<OAuthClient | null> {
  return read<OAuthClient>(NS_CLIENTS, clientId);
}

// ── Authorization codes (single-use) ───────────────────────────────────
export async function saveCode(code: string, data: AuthCodeData): Promise<void> {
  await put(NS_CODES, code, data);
}
export async function takeCode(code: string): Promise<AuthCodeData | null> {
  const data = await read<AuthCodeData>(NS_CODES, code);
  if (!data) return null;
  await remove(NS_CODES, code);
  if (data.exp < Math.floor(Date.now() / 1000)) return null;
  return data;
}

// ── Refresh tokens ─────────────────────────────────────────────────────
export async function saveRefresh(token: string, data: RefreshData): Promise<void> {
  await put(NS_REFRESH, token, data);
}
export async function getRefresh(token: string): Promise<RefreshData | null> {
  const data = await read<RefreshData>(NS_REFRESH, token);
  if (!data) return null;
  if (data.exp < Math.floor(Date.now() / 1000)) {
    await remove(NS_REFRESH, token);
    return null;
  }
  return data;
}
export async function deleteRefresh(token: string): Promise<void> {
  await remove(NS_REFRESH, token);
}
