'use client';

import { useEffect, useMemo, useRef, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useStore } from '@/store/useStore';

interface SupabaseProviderProps {
  children: ReactNode;
}

/**
 * Heuristic: is this error caused by an expired / missing JWT rather
 * than a genuine Supabase outage?
 *
 * We can't rely on a structured status code here because the store
 * stringifies PostgrestError into plain text before storing it. So we
 * sniff the message for the usual suspects (401, JWT, "expired", etc.)
 * and also treat the generic fallback ("Supabase connection error") as
 * suspicious when there's no session at all in localStorage — that's
 * always an auth issue, not a connectivity one.
 */
function looksLikeAuthError(message: string | null): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('jwt') ||
    m.includes('401') ||
    m.includes('unauthorized') ||
    m.includes('expired') ||
    m.includes('invalid token') ||
    m.includes('not authenticated')
  );
}

function hasStoredSession(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem('wasabi_session');
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return !!parsed?.access_token;
  } catch {
    return false;
  }
}

export function SupabaseProvider({ children }: SupabaseProviderProps) {
  const { initializeData, isLoading, error, isInitialized } = useStore();
  const router = useRouter();
  const pathname = usePathname();
  const redirectedRef = useRef(false);

  useEffect(() => {
    initializeData();
  }, [initializeData]);

  // Auth-bounce: if the initial load fails AND the error looks like a
  // dead session (or there is no session in localStorage at all), wipe
  // the stale token and send the user to /login instead of leaving
  // them stranded on the generic "Connection Error" screen.
  //
  // We only do this when we are NOT already on /login (otherwise we'd
  // loop) and we use a ref to make sure we only fire the redirect once
  // per mount, even if React re-renders.
  const shouldBounceToLogin = useMemo(() => {
    if (!error || isInitialized) return false;
    if (pathname?.startsWith('/login')) return false;
    if (looksLikeAuthError(error)) return true;
    // Generic error + no session → almost certainly the session is gone.
    if (!hasStoredSession()) return true;
    return false;
  }, [error, isInitialized, pathname]);

  useEffect(() => {
    if (!shouldBounceToLogin || redirectedRef.current) return;
    redirectedRef.current = true;
    try {
      window.localStorage.removeItem('wasabi_session');
      window.sessionStorage.clear();
    } catch {
      // ignore; redirect below is what matters.
    }
    const target = pathname && pathname !== '/' ? `?next=${encodeURIComponent(pathname)}` : '';
    router.replace(`/login${target}`);
  }, [shouldBounceToLogin, pathname, router]);

  if (!isInitialized && isLoading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500 mx-auto mb-4"></div>
          <p className="text-gray-400">Loading data from Supabase...</p>
        </div>
      </div>
    );
  }

  // While we're mid-redirect to /login, show a neutral spinner instead
  // of the scary "Connection Error" screen. This eliminates the moment
  // where the user sees an alarming red triangle for half a second
  // before the navigation completes.
  if (shouldBounceToLogin) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500 mx-auto mb-4"></div>
          <p className="text-gray-400">Session expired. Redirecting to login...</p>
        </div>
      </div>
    );
  }

  if (error && !isInitialized) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center max-w-md mx-auto p-6">
          <div className="text-red-500 text-6xl mb-4">⚠️</div>
          <h2 className="text-xl font-bold text-white mb-2">Connection Error</h2>
          <p className="text-gray-400 mb-4">{error}</p>
          <p className="text-gray-500 text-sm mb-4">
            Make sure the tables have been created in Supabase.
            <br />
            Check the file <code className="bg-gray-800 px-1 rounded">supabase-schema.sql</code>
          </p>
          <div className="flex gap-2 justify-center">
            <button
              onClick={() => initializeData()}
              className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg transition-colors"
            >
              Retry
            </button>
            <button
              onClick={() => {
                try {
                  window.localStorage.removeItem('wasabi_session');
                  window.sessionStorage.clear();
                } catch { /* ignore */ }
                router.replace('/login');
              }}
              className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
