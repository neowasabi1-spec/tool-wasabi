import { createHmac, timingSafeEqual } from 'node:crypto';
import { signingSecret, ACCESS_TOKEN_TTL, oauthConfig } from './config';

/**
 * Minimal HS256 JWT sign/verify (no external dependency) for MCP access
 * tokens. Stateless: validation is a signature + expiry check, no DB read.
 */

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export interface AccessTokenClaims {
  iss: string;
  sub: string; // Supabase user id
  aud: string; // resource
  cid: string; // client_id
  scope: string;
  iat: number;
  exp: number;
}

export function signAccessToken(params: {
  userId: string;
  clientId: string;
  scope: string;
}): { token: string; expiresIn: number } {
  const cfg = oauthConfig();
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = {
    iss: cfg.issuer,
    sub: params.userId,
    aud: cfg.resource,
    cid: params.clientId,
    scope: params.scope,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL,
  };
  const header = { alg: 'HS256', typ: 'JWT' };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = b64url(createHmac('sha256', signingSecret()).update(signingInput).digest());
  return { token: `${signingInput}.${sig}`, expiresIn: ACCESS_TOKEN_TTL };
}

export function verifyAccessToken(token: string): AccessTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const signingInput = `${h}.${p}`;
  const expected = createHmac('sha256', signingSecret()).update(signingInput).digest();
  let provided: Buffer;
  try {
    provided = fromB64url(s);
  } catch {
    return null;
  }
  if (expected.length !== provided.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;

  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(fromB64url(p).toString('utf8')) as AccessTokenClaims;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now) return null;
  if (!claims.sub) return null;
  return claims;
}
