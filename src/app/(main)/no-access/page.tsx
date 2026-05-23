'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { ShieldOff, LogOut, Loader2 } from 'lucide-react';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { DASHBOARD_SECTIONS } from '@/lib/auth/sections';

export default function NoAccessPage() {
  const { user, permissions, loading } = useCurrentUser();
  const router = useRouter();

  // If the user got here AFTER being granted some sections (e.g. master
  // toggled a checkbox in another tab), auto-bounce them to the first
  // allowed one.
  useEffect(() => {
    if (loading || !permissions) return;
    if (permissions.role === 'master') {
      router.replace('/');
      return;
    }
    if (permissions.sections.length > 0) {
      const first = DASHBOARD_SECTIONS.find(s => permissions.sections.includes(s.id));
      if (first) router.replace(first.path);
    }
  }, [loading, permissions, router]);

  async function handleSignOut() {
    const supabase = getSupabaseBrowser();
    try { localStorage.removeItem('wasabi_session'); } catch { /* ignore */ }
    if (supabase) await supabase.auth.signOut().catch(() => {});
    router.replace('/login');
  }

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-6">
      <div className="max-w-md w-full bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
        <div className="w-16 h-16 bg-amber-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
          <ShieldOff className="w-8 h-8 text-amber-400" />
        </div>
        <h1 className="text-xl font-bold text-white mb-2">Nessun accesso</h1>
        <p className="text-gray-400 text-sm mb-2">
          Il tuo account <span className="text-white font-medium">{user?.email || 'corrente'}</span> non ha
          ancora i permessi per vedere questa sezione.
        </p>
        <p className="text-gray-500 text-xs mb-6">
          Contatta l&apos;admin del workspace per abilitare le sezioni
          che ti servono.
        </p>
        <button
          onClick={handleSignOut}
          className="inline-flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-lg transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Esci e cambia account
        </button>
      </div>
    </div>
  );
}
