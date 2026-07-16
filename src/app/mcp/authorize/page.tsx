'use client';

import { useEffect, useState, useCallback } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { Shield, Loader2, AlertCircle, Check } from 'lucide-react';

interface AuthzParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  state: string;
}

function readParams(): AuthzParams {
  const q = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  return {
    response_type: q.get('response_type') || '',
    client_id: q.get('client_id') || '',
    redirect_uri: q.get('redirect_uri') || '',
    code_challenge: q.get('code_challenge') || '',
    code_challenge_method: q.get('code_challenge_method') || 'S256',
    scope: q.get('scope') || 'mcp:use',
    state: q.get('state') || '',
  };
}

export default function McpAuthorizePage() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'submitting'>('loading');
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [params, setParams] = useState<AuthzParams | null>(null);

  useEffect(() => {
    const p = readParams();
    setParams(p);

    if (p.response_type !== 'code' || !p.client_id || !p.redirect_uri || !p.code_challenge) {
      setError('Invalid authorization request (missing or unsupported parameters).');
      setStatus('error');
      return;
    }

    (async () => {
      const supabase = getSupabaseBrowser();
      if (!supabase) {
        setError('Supabase is not configured on this site.');
        setStatus('error');
        return;
      }

      // Rehydrate the session the tool stores in localStorage on login, then
      // let the SDK refresh it if needed so we hand the API a valid token.
      try {
        const raw = localStorage.getItem('wasabi_session');
        if (raw) {
          const s = JSON.parse(raw) as { access_token?: string; refresh_token?: string };
          if (s.access_token && s.refresh_token) {
            await supabase.auth.setSession({
              access_token: s.access_token,
              refresh_token: s.refresh_token,
            });
          }
        }
      } catch {
        /* ignore — fall through to getSession */
      }

      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session?.access_token || !session.user) {
        const returnTo = window.location.pathname + window.location.search;
        window.location.href = `/login?redirect=${encodeURIComponent(returnTo)}`;
        return;
      }

      setEmail(session.user.email || '');
      setAccessToken(session.access_token);
      setStatus('ready');
    })();
  }, []);

  const approve = useCallback(async () => {
    if (!params) return;
    setStatus('submitting');
    setError('');
    try {
      const res = await fetch('/api/mcp/oauth/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          supabaseAccessToken: accessToken,
          client_id: params.client_id,
          redirect_uri: params.redirect_uri,
          code_challenge: params.code_challenge,
          code_challenge_method: params.code_challenge_method,
          scope: params.scope,
          state: params.state,
        }),
      });
      const json = (await res.json()) as { redirect?: string; error_description?: string; error?: string };
      if (!res.ok || !json.redirect) {
        throw new Error(json.error_description || json.error || 'Authorization failed.');
      }
      window.location.href = json.redirect;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Authorization failed.');
      setStatus('ready');
    }
  }, [params, accessToken]);

  const deny = useCallback(() => {
    if (!params?.redirect_uri) return;
    try {
      const url = new URL(params.redirect_uri);
      url.searchParams.set('error', 'access_denied');
      if (params.state) url.searchParams.set('state', params.state);
      window.location.href = url.toString();
    } catch {
      setError('Access denied.');
      setStatus('error');
    }
  }, [params]);

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-purple-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <Shield className="w-8 h-8 text-purple-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">Connect to Claude</h1>
          <p className="text-gray-500 text-sm mt-1">Authorize your Claude to use this tool</p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
          {status === 'loading' && (
            <div className="flex items-center justify-center gap-2 text-gray-400 py-8">
              <Loader2 className="w-5 h-5 animate-spin" /> Checking your session…
            </div>
          )}

          {status === 'error' && (
            <div className="flex items-start gap-2 text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {(status === 'ready' || status === 'submitting') && (
            <>
              {error && (
                <div className="flex items-start gap-2 text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
              <p className="text-gray-300 text-sm">
                Signed in as <span className="text-white font-medium">{email || 'your account'}</span>.
              </p>
              <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-3 text-sm text-gray-300">
                Claude will be able to use this tool on your behalf:
                <ul className="list-disc list-inside mt-2 text-gray-400 space-y-1">
                  <li>Clone landing pages</li>
                  <li>Extract and rewrite their copy</li>
                  <li>Generate the final page</li>
                </ul>
              </div>
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={deny}
                  disabled={status === 'submitting'}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-200 font-medium py-2.5 rounded-lg transition-colors"
                >
                  Deny
                </button>
                <button
                  type="button"
                  onClick={approve}
                  disabled={status === 'submitting'}
                  className="flex-1 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {status === 'submitting' ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4" />
                  )}
                  Authorize
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
