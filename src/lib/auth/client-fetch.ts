/**
 * Client-side `fetch` wrapper that injects the current Supabase access
 * token as `Authorization: Bearer ...`.
 *
 * Use this for any call to an `/api/...` route that runs `requireAuth()`
 * server-side. Falls back to a plain `fetch` if Supabase isn't configured
 * (dev / missing env vars) so the call still goes through and the server
 * returns a clean 401.
 *
 * Token-refresh behaviour
 * ───────────────────────
 * Supabase access_token dura 1h. Senza refresh proattivo, dopo un'ora di
 * inattivita' tutte le chiamate cominciano a tornare 401 "unauthorized"
 * (es. crei un utente dalla pagina /admin/users e ricevi 401, anche se la
 * GET dello stesso endpoint era andata bene mezz'ora prima).
 *
 * Fix: se la risposta del server e' 401, proviamo UNA VOLTA a fare
 * refresh via `supabase.auth.refreshSession({ refresh_token })`, aggiorniamo
 * `wasabi_session` in localStorage, e riproviamo la stessa richiesta con
 * il nuovo access_token. Se anche dopo il refresh torna 401 — o se il
 * refresh stesso fallisce (refresh_token revocato / scaduto) — ritorniamo
 * la 401 originale e l'AuthGate mandera' l'utente al login.
 */

'use client';

interface StoredSession {
  access_token: string;
  refresh_token: string;
  user_id: string;
  email?: string;
  expires_at?: number;
}

function readStoredSession(): StoredSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem('wasabi_session');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.access_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function getAccessToken(): string | null {
  return readStoredSession()?.access_token ?? null;
}

/**
 * Tenta refresh del token. Ritorna il nuovo access_token o null se il
 * refresh e' fallito (refresh_token revocato / scaduto). Non lancia mai.
 *
 * IMPORTANTE: facciamo una chiamata REST DIRETTA all'endpoint token di
 * Supabase invece di usare `supabase.auth.refreshSession()` dell'SDK.
 * L'SDK avvolge le operazioni auth in `navigator.locks`, e quella lock
 * resta ORFANA dopo un redirect soft di Next (es. AuthGate fa
 * router.replace('/login') senza full reload): ogni refresh successivo
 * aspetterebbe quella lock per sempre → spinner infinito / utente bloccato
 * fuori. Una fetch diretta non tocca navigator.locks e ha un timeout
 * hard, quindi non puo' mai deadlockare. Vedi supabase-browser.ts.
 */
async function tryRefreshToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const stored = readStoredSession();
  if (!stored?.refresh_token) return null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    console.warn('[authFetch] missing Supabase env — cannot refresh');
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ refresh_token: stored.refresh_token }),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[authFetch] token refresh HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
      user?: { id?: string; email?: string | null };
    };
    if (!data?.access_token || !data?.refresh_token) {
      console.warn('[authFetch] token refresh: response missing tokens');
      return null;
    }
    // Persisti la nuova sessione SOTTO LA STESSA CHIAVE usata da
    // useCurrentUser (lettura iniziale) e da questo modulo.
    try {
      window.localStorage.setItem(
        'wasabi_session',
        JSON.stringify({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          user_id: data.user?.id ?? stored.user_id,
          email: data.user?.email ?? stored.email,
          expires_at: data.expires_at,
        }),
      );
    } catch {
      // localStorage pieno/disabilitato: il nuovo token viene comunque usato
      // per questa richiesta.
    }
    return data.access_token;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      console.warn('[authFetch] token refresh aborted (timeout)');
    } else {
      console.warn('[authFetch] token refresh threw:', err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Garantisce un solo refresh concorrente: se piu' chiamate tornano 401
// nello stesso millisecondo, riusano la stessa Promise di refresh invece
// di farne N in parallelo (Supabase invalida i refresh_token consumati,
// quindi N richieste parallele si invalidano a vicenda).
let _inflightRefresh: Promise<string | null> | null = null;
async function refreshSingleflight(): Promise<string | null> {
  if (_inflightRefresh) return _inflightRefresh;
  _inflightRefresh = (async () => {
    try {
      return await tryRefreshToken();
    } finally {
      // Lascia uno spiraglio temporale prima di permettere un nuovo
      // refresh, cosi' un burst di 401 non sfora il rate-limit Supabase.
      setTimeout(() => { _inflightRefresh = null; }, 1000);
    }
  })();
  return _inflightRefresh;
}

export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = getAccessToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status !== 401) return res;

  // 401 -> tenta refresh. Se va, riprova UNA VOLTA con il nuovo token.
  // Non ritentiamo all'infinito: se anche il nuovo token e' 401, e' un
  // vero problema di permessi e l'AuthGate gestira'.
  const newToken = await refreshSingleflight();
  if (!newToken) return res;

  const retryHeaders = new Headers(init.headers || {});
  retryHeaders.set('Authorization', `Bearer ${newToken}`);
  return fetch(input, { ...init, headers: retryHeaders });
}
