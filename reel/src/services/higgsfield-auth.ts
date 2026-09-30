/**
 * Higgsfield OAuth 2.0 PKCE flow + refresh token storage.
 *
 * Flow:
 *   1. Genera code_verifier + code_challenge (PKCE)
 *   2. Avvia server locale su porta random per callback
 *   3. Apre browser su URL di autorizzazione Higgsfield
 *   4. Utente autorizza → browser redirect a localhost:port/callback?code=...
 *   5. Server riceve code, scambia per access_token + refresh_token
 *   6. Salva tokens in ~/.config/ai-clienti/higgsfield-token.json (chmod 600)
 *
 * Refresh:
 *   - ensureValidAccessToken() carica i token, se expires_at vicino (<60s)
 *     rinnova via refresh_token grant. Salva i nuovi.
 *   - Se refresh_token è scaduto/invalido → throw con istruzione a rieseguire
 *     l'auth flow.
 *
 * Endpoint Higgsfield (estratti dal flow OAuth del pilot 2026-05-27):
 *   - Authorize: https://mcp.higgsfield.ai/oauth2/authorize
 *   - Token:     https://mcp.higgsfield.ai/oauth2/token
 *   - Resource:  https://mcp.higgsfield.ai/
 *   - Scope:     openid email offline_access
 *   - Client ID: vFtt5iafzgMWU6QE (Higgsfield MCP standard client, public)
 */

import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const AUTH_URL = "https://mcp.higgsfield.ai/oauth2/authorize";
const TOKEN_URL = "https://mcp.higgsfield.ai/oauth2/token";
const CLIENT_ID = process.env.HIGGSFIELD_CLIENT_ID ?? "vFtt5iafzgMWU6QE";
const SCOPES = "openid email offline_access";
const RESOURCE = "https://mcp.higgsfield.ai/";

const TOKEN_FILE = join(
  homedir(),
  ".config",
  "ai-clienti",
  "higgsfield-token.json"
);

interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix ms
  token_type: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(
    createHash("sha256").update(verifier).digest()
  );
  return { verifier, challenge };
}

async function loadTokens(): Promise<TokenSet | null> {
  try {
    const data = await readFile(TOKEN_FILE, "utf8");
    const parsed = JSON.parse(data) as TokenSet;
    if (!parsed.access_token || !parsed.refresh_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveTokens(tokens: TokenSet): Promise<void> {
  await mkdir(dirname(TOKEN_FILE), { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), "utf8");
  await chmod(TOKEN_FILE, 0o600);
}

async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("Failed to allocate free port"));
      }
    });
    srv.on("error", reject);
  });
}

/**
 * Esegue l'OAuth flow completo (browser + callback locale) e salva i token.
 * Chiamare da uno script CLI dedicato (pnpm higgsfield:auth).
 */
export async function startAuthFlow(): Promise<TokenSet> {
  const { verifier, challenge } = generatePKCE();
  const state = base64UrlEncode(randomBytes(16));
  const port = await findFreePort();
  const redirectUri = `http://localhost:${port}/callback`;

  const codePromise = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Authorization error</h1><pre>${error}</pre>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>State mismatch</h1>`);
        server.close();
        reject(new Error("OAuth state mismatch (possible CSRF)"));
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Missing code</h1>`);
        server.close();
        reject(new Error("OAuth response missing 'code'"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<!DOCTYPE html><html><head><title>Higgsfield Authorized</title><style>body{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}div{text-align:center}h1{color:#6ee7b7}</style></head><body><div><h1>Authorization complete</h1><p>You can close this window and return to the terminal.</p></div></body></html>`
      );
      server.close();
      resolve(code);
    });
    server.listen(port);
    setTimeout(
      () => {
        server.close();
        reject(new Error("OAuth timeout (5 min)"));
      },
      5 * 60 * 1000
    );
  });

  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    state,
    scope: SCOPES,
    prompt: "consent",
    resource: RESOURCE,
  });
  const authUrl = `${AUTH_URL}?${authParams.toString()}`;

  console.log("\n🔐 Higgsfield OAuth — apro browser per autorizzazione…");
  console.log(`   Se il browser non si apre, copia questo URL:\n   ${authUrl}\n`);

  try {
    await execFileAsync("open", [authUrl]);
  } catch {
    // platform fallback handled by manual paste
  }

  const code = await codePromise;
  console.log("   ✅ Code ricevuto, scambio per tokens…");

  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const errBody = await tokenResponse.text();
    throw new Error(
      `Token exchange fallito: ${tokenResponse.status} ${tokenResponse.statusText}\n${errBody}`
    );
  }

  const tokens = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    token_type?: string;
  };

  const tokenSet: TokenSet = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    token_type: tokens.token_type ?? "Bearer",
  };
  await saveTokens(tokenSet);
  console.log(`   ✅ Tokens salvati in ${TOKEN_FILE}`);
  return tokenSet;
}

async function refreshAccessToken(currentTokens: TokenSet): Promise<TokenSet> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: currentTokens.refresh_token,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Token refresh fallito: ${response.status}`);
  }
  const tokens = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };
  const newSet: TokenSet = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? currentTokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    token_type: tokens.token_type ?? "Bearer",
  };
  await saveTokens(newSet);
  return newSet;
}

/**
 * Carica il token salvato e lo rinnova se sta per scadere (<60s).
 * Throw se non c'è token salvato o se il refresh fallisce.
 */
export async function ensureValidAccessToken(): Promise<string> {
  let tokens = await loadTokens();
  if (!tokens) {
    throw new Error(
      "Higgsfield non autenticato. Esegui: pnpm higgsfield:auth"
    );
  }
  if (Date.now() >= tokens.expires_at - 60_000) {
    try {
      tokens = await refreshAccessToken(tokens);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Higgsfield refresh token fallito (${msg}). Riesegui: pnpm higgsfield:auth`
      );
    }
  }
  return tokens.access_token;
}

export function tokenFilePath(): string {
  return TOKEN_FILE;
}
