'use client';

import { useState } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { Shield, LogIn, AlertCircle, Loader2 } from 'lucide-react';

export default function LoginPageClient() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'login' | 'magic_link'>('login');
  const [magicLinkSent, setMagicLinkSent] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const supabase = getSupabaseBrowser();
      if (!supabase) {
        throw new Error(
          'Variabili Supabase mancanti: imposta NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY in Netlify (Site settings → Environment variables), poi rifai deploy.',
        );
      }
      if (mode === 'magic_link') {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        if (error) throw error;
        setMagicLinkSent(true);
      } else {
        // Login via REST DIRETTO all'endpoint token di Supabase invece di
        // supabase.auth.signInWithPassword(). L'SDK avvolge le operazioni
        // auth in navigator.locks: dopo una navigazione soft di Next la lock
        // puo' restare orfana e signInWithPassword resta in attesa per
        // sempre → pulsante "Sign In" con rotellina infinita. Una fetch
        // diretta con timeout non tocca le lock e non puo' deadlockare.
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
        const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
        if (!url || !anonKey) {
          throw new Error(
            'Variabili Supabase mancanti: imposta NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY in Netlify, poi rifai deploy.',
          );
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let session: {
          access_token?: string;
          refresh_token?: string;
          expires_at?: number;
          user?: { id?: string; email?: string | null };
        };
        try {
          const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: anonKey,
              Authorization: `Bearer ${anonKey}`,
            },
            body: JSON.stringify({ email, password }),
            cache: 'no-store',
            signal: controller.signal,
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            const msg =
              (payload as { error_description?: string; msg?: string; error?: string })
                ?.error_description ||
              (payload as { msg?: string })?.msg ||
              (payload as { error?: string })?.error ||
              'Email o password non corretti.';
            throw new Error(msg);
          }
          session = payload as typeof session;
        } catch (e) {
          if ((e as { name?: string })?.name === 'AbortError') {
            throw new Error('Timeout durante il login. Controlla la connessione e riprova.');
          }
          throw e;
        } finally {
          clearTimeout(timer);
        }

        if (!session?.access_token || !session?.refresh_token) {
          throw new Error(
            'Login riuscito ma la sessione non è stata creata. Controlla che il browser permetta localStorage per questo dominio.',
          );
        }
        // Save the session under OUR OWN key so we don't depend on the
        // SDK's internal storage logic (which has been flaky across
        // Next.js soft navigations / multiple tabs / locked refreshes).
        // useCurrentUser reads this same key on mount.
        try {
          localStorage.setItem('wasabi_session', JSON.stringify({
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            user_id: session.user?.id,
            email: session.user?.email,
            expires_at: session.expires_at,
          }));
        } catch {
          throw new Error(
            'Impossibile salvare la sessione in localStorage. Esci dalla modalità in incognito o abilita lo storage per questo dominio.',
          );
        }
        const redirect = new URLSearchParams(window.location.search).get('redirect') || '/';
        // Full reload (non soft nav): rigenera il documento e libera
        // qualsiasi navigator.lock orfana lasciata da una sessione bloccata.
        window.location.href = redirect;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  if (magicLinkSent) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="max-w-sm w-full bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
          <div className="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <Shield className="w-8 h-8 text-green-400" />
          </div>
          <h2 className="text-xl font-bold text-white mb-2">Check your email</h2>
          <p className="text-gray-400 text-sm">
            A secure login link has been sent to <span className="text-white font-medium">{email}</span>.
            Click the link to access the dashboard.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="max-w-sm w-full">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-purple-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <Shield className="w-8 h-8 text-purple-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">Funnel Swiper</h1>
          <p className="text-gray-500 text-sm mt-1">SOC 2 Protected Dashboard</p>
        </div>

        <form onSubmit={handleLogin} className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
          {error && (
            <div className="flex items-center gap-2 text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:border-purple-500 transition-colors"
              placeholder="your@email.com"
            />
          </div>

          {mode === 'login' && (
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-1.5">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:border-purple-500 transition-colors"
                placeholder="••••••••"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <LogIn className="w-4 h-4" />
            )}
            {mode === 'magic_link' ? 'Send Magic Link' : 'Sign In'}
          </button>

          <div className="text-center">
            <button
              type="button"
              onClick={() => setMode(mode === 'login' ? 'magic_link' : 'login')}
              className="text-sm text-purple-400 hover:text-purple-300 transition-colors"
            >
              {mode === 'login' ? 'Use magic link instead' : 'Use password instead'}
            </button>
          </div>
        </form>

        <p className="text-center text-gray-600 text-xs mt-6">
          Protected by Supabase Auth &middot; SOC 2 Compliant
        </p>
      </div>
    </div>
  );
}
