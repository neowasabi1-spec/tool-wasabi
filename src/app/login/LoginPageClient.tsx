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
    if (loading) return; // Double-submit guard (Enter pressed twice)
    setLoading(true);
    setError('');

    // Defensive sanitisation. The most common cause of intermittent
    // "Invalid login credentials" errors is paste-with-whitespace
    // (newline/space at the end of email or password) and case
    // variations on the email. Supabase treats emails as
    // case-insensitive but stores the original casing, and any
    // whitespace will make the credential check fail outright.
    const cleanEmail = email.trim().toLowerCase();
    const cleanPassword = password; // password — DO NOT trim or lowercase

    try {
      const supabase = getSupabaseBrowser();
      if (!supabase) {
        throw new Error(
          'Missing Supabase variables: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in Netlify (Site settings → Environment variables), then redeploy.',
        );
      }

      // Wipe any stale local session BEFORE signing in. Without this,
      // the SDK's autoRefreshToken can race with the new sign-in: it
      // tries to refresh an expired token in the background, the
      // refresh fails, and the failure handler clobbers the brand-new
      // session that signInWithPassword just produced. The user sees
      // a successful auth that then mysteriously dumps them back to
      // login on the next page. `scope: 'local'` only clears the
      // browser-side storage, no network call.
      try {
        await supabase.auth.signOut({ scope: 'local' });
      } catch {
        /* ignore — best-effort cleanup */
      }
      try {
        localStorage.removeItem('wasabi_session');
      } catch {
        /* ignore */
      }

      if (mode === 'magic_link') {
        const { error } = await supabase.auth.signInWithOtp({
          email: cleanEmail,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        if (error) throw error;
        setMagicLinkSent(true);
      } else {
        // Retry exactly ONCE on transient failures (5xx, network drop,
        // 429 rate limit). We deliberately do NOT retry on 400/401/422
        // (real credential rejection) — retrying those would just look
        // like account enumeration and accumulate rate-limit hits.
        const attemptSignIn = async () =>
          supabase.auth.signInWithPassword({ email: cleanEmail, password: cleanPassword });

        let { data, error: authErr } = await attemptSignIn();
        if (authErr) {
          const status = (authErr as { status?: number }).status;
          const isTransient =
            !status ||
            status === 0 ||
            status === 408 ||
            status === 429 ||
            (status >= 500 && status < 600);
          if (isTransient) {
            await new Promise((r) => setTimeout(r, 800));
            const retry = await attemptSignIn();
            data = retry.data;
            authErr = retry.error;
          }
        }
        if (authErr) {
          const status = (authErr as { status?: number }).status;
          // Surface a more actionable message when Supabase says
          // "invalid credentials" — the user usually thinks our app
          // is broken, but the real culprit is almost always paste
          // whitespace, browser autofill or caps-lock.
          if (status === 400 || /invalid login credentials/i.test(authErr.message)) {
            throw new Error(
              'Wrong email or password. Common causes: trailing space in the pasted email/password, browser autofill picking the wrong saved entry, or Caps Lock. Try typing them manually.',
            );
          }
          if (status === 429) {
            throw new Error(
              'Too many login attempts. Wait ~30 seconds and try again.',
            );
          }
          throw authErr;
        }
        if (!data?.session?.access_token || !data?.session?.refresh_token) {
          throw new Error(
            'Login succeeded but the session was not created. Check that the browser allows localStorage for this domain.',
          );
        }
        // Save the session under OUR OWN key so we don't depend on the
        // SDK's internal storage logic (which has been flaky across
        // Next.js soft navigations / multiple tabs / locked refreshes).
        // useCurrentUser reads this same key on mount and rehydrates
        // the SDK via `supabase.auth.setSession()`.
        try {
          localStorage.setItem('wasabi_session', JSON.stringify({
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token,
            user_id: data.session.user.id,
            email: data.session.user.email,
            expires_at: data.session.expires_at,
          }));
        } catch {
          throw new Error(
            'Unable to save the session in localStorage. Exit incognito mode or enable storage for this domain.',
          );
        }
        const redirect = new URLSearchParams(window.location.search).get('redirect') || '/';
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
