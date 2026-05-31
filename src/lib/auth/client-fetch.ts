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

import { supabase } from '@/lib/supabase';

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
 */
async function tryRefreshToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const stored = readStoredSession();
  if (!stored?.refresh_token) return null;
  try {
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: stored.refresh_token,
    });
    if (error || !data?.session?.access_token || !data?.session?.refresh_token) {
      console.warn('[authFetch] refreshSession failed:', error?.message || 'no session returned');
      return null;
    }
    // Persisti la nuova sessione nel nostro storage SOTTO LA STESSA CHIAVE
    // che usano sia `useCurrentUser` (lettura iniziale) sia questo modulo.
    try {
      window.localStorage.setItem(
        'wasabi_session',
        JSON.stringify({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          user_id: data.session.user.id,
          email: data.session.user.email ?? stored.email,
          expires_at: data.session.expires_at,
        }),
      );
    } catch {
      // localStorage pieno o disabilitato: non blocchiamo, almeno il nuovo
      // token viene usato per questa richiesta.
    }
    return data.session.access_token;
  } catch (err) {
    console.warn('[authFetch] refreshSession threw:', err);
    return null;
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
