'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  ShoppingBag,
  Layers,
  ChevronRight,
  FileCode,
  HelpCircle,
  Copy,
  KeyRound,
  Swords,
  FolderOpen,
  ClipboardCheck,
  DollarSign,
  Users,
  LogOut,
  Shield,
} from 'lucide-react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { canAccessSection } from '@/lib/auth/sections';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

interface MenuItem {
  name: string;
  href: string;
  icon: typeof LayoutDashboard;
  /** Section id from `app_user_permissions.sections`. `null` means the
   *  item is visible to any logged-in user (e.g. the landing dashboard). */
  sectionId: string | null;
  /** Only show to masters even if the section id is also granted to
   *  regular users. Currently only used for the Users admin panel. */
  masterOnly?: boolean;
}

interface MenuGroup {
  /** Optional small heading shown above the group. */
  label?: string;
  items: MenuItem[];
}

// Grouped by workflow stage so the sidebar reads as a journey instead of a
// flat list. Hrefs/sectionId/masterOnly are unchanged — grouping is purely
// presentational.
const menuGroups: MenuGroup[] = [
  {
    items: [
      { name: 'Dashboard', href: '/', icon: LayoutDashboard, sectionId: null },
    ],
  },
  {
    label: 'Crea',
    items: [
      { name: 'Clone / Swipe', href: '/front-end-funnel', icon: Copy, sectionId: 'front-end-funnel' },
      { name: 'Clone / Swipe Quiz', href: '/quiz-swipe', icon: HelpCircle, sectionId: 'quiz-swipe' },
    ],
  },
  {
    label: 'Libreria',
    items: [
      { name: 'My Archive', href: '/templates', icon: FileCode, sectionId: 'templates' },
      { name: 'Catalogue', href: '/products', icon: ShoppingBag, sectionId: 'products' },
      { name: 'My Projects', href: '/projects', icon: FolderOpen, sectionId: 'projects' },
    ],
  },
  {
    label: 'Operazioni',
    items: [
      { name: 'Checkpoint', href: '/checkpoint', icon: ClipboardCheck, sectionId: 'checkpoint' },
      { name: 'Protocollo Valchiria', href: '/protocollo-valchiria', icon: Swords, sectionId: 'protocollo-valchiria' },
    ],
  },
  {
    label: 'Impostazioni',
    items: [
      { name: 'API Keys', href: '/api-keys', icon: KeyRound, sectionId: 'api-keys' },
      { name: 'Spesa API', href: '/api-usage', icon: DollarSign, sectionId: 'api-usage' },
      { name: 'Users', href: '/admin/users', icon: Users, sectionId: 'admin-users', masterOnly: true },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, permissions, loading } = useCurrentUser();

  const isVisible = (item: MenuItem): boolean => {
    // masterOnly wins over everything else — even items without a sectionId
    // (e.g. Strategist) must be hidden to non-masters.
    if (item.masterOnly && permissions?.role !== 'master') return false;
    if (item.sectionId === null) return true; // dashboard etc. — always visible
    return canAccessSection(permissions, item.sectionId);
  };

  const visibleGroups = menuGroups
    .map((g) => ({ ...g, items: g.items.filter(isVisible) }))
    .filter((g) => g.items.length > 0);

  async function handleSignOut() {
    const supabase = getSupabaseBrowser();
    // Multi-tenancy hygiene: when a different user logs in on the same
    // browser, none of the previous user's cached data must leak into
    // their view. We aggressively wipe ALL client-side state:
    //   - the wasabi_session shim
    //   - the entire Zustand store (products, projects, funnel pages,
    //     archived funnels — anything persisted via persist())
    //   - any IndexedDB / cache keys we might own
    //   - all auth tokens (sb-*, supabase.auth.token)
    // The router.replace('/login') below triggers a fresh page load
    // anyway, which clears in-memory React Query caches.
    try { localStorage.removeItem('wasabi_session'); } catch { /* ignore */ }
    try {
      const keysToClear: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (
          k.startsWith('wasabi') ||
          k.startsWith('sb-') ||
          k.startsWith('supabase.') ||
          k === 'funnel-app-store' /* persist key for useStore */
        ) {
          keysToClear.push(k);
        }
      }
      for (const k of keysToClear) localStorage.removeItem(k);
    } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
    if (supabase) await supabase.auth.signOut().catch(() => {});
    // Hard reload — ensures every in-memory store/query/state resets,
    // not just the keys we know to clear.
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    } else {
      router.replace('/login');
    }
  }

  return (
    <aside className="w-60 bg-gradient-to-b from-slate-900 to-slate-950 text-white min-h-screen flex flex-col border-r border-white/5">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-white/5">
        <h1 className="text-base font-bold flex items-center gap-2.5">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-900/40">
            <Layers className="w-4 h-4 text-white" />
          </span>
          <span className="flex flex-col leading-tight">
            <span className="tracking-tight">Funnel Swiper</span>
            <span className="text-[10px] font-medium text-slate-400 tracking-wide">Dashboard Operations</span>
          </span>
        </h1>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-3 overflow-y-auto">
        <div className="space-y-6">
          {visibleGroups.map((group, gi) => (
            <div key={group.label || `group-${gi}`}>
              {group.label && (
                <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                  {group.label}
                </p>
              )}
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const isActive = pathname === item.href;
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={`group relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                          isActive
                            ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-lg shadow-indigo-900/30'
                            : 'text-slate-300 hover:bg-white/5 hover:text-white'
                        }`}
                      >
                        {isActive && (
                          <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-r-full bg-white/80" />
                        )}
                        <Icon className={`w-[18px] h-[18px] shrink-0 transition-colors ${isActive ? 'text-white' : 'text-slate-400 group-hover:text-white'}`} />
                        <span className="flex-1 truncate">{item.name}</span>
                        {isActive && <ChevronRight className="w-3.5 h-3.5 shrink-0 opacity-80" />}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-white/5 space-y-2">
        {!loading && user && (
          <div className="bg-white/5 ring-1 ring-white/5 rounded-xl p-3 space-y-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full shrink-0 text-xs font-bold uppercase ${permissions?.role === 'master' ? 'bg-amber-500/15 text-amber-300' : 'bg-indigo-500/15 text-indigo-300'}`}>
                {(user.email || '?').charAt(0)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-white truncate" title={user.email || ''}>
                  {user.email}
                </p>
                <p className="text-[10px] text-slate-400 uppercase tracking-wider flex items-center gap-1">
                  <Shield className={`w-3 h-3 ${permissions?.role === 'master' ? 'text-amber-400' : 'text-slate-500'}`} />
                  {permissions?.role || 'user'}
                </p>
              </div>
            </div>
            <button
              onClick={handleSignOut}
              className="w-full flex items-center justify-center gap-1.5 text-[11px] text-slate-300 hover:text-white bg-slate-950/60 hover:bg-slate-800 rounded-lg py-2 transition-colors"
            >
              <LogOut className="w-3 h-3" />
              Sign out
            </button>
          </div>
        )}
        <a
          href="/api/health"
          target="_blank"
          rel="noopener noreferrer"
          className="block text-center text-[11px] text-slate-500 hover:text-indigo-300 transition-colors"
        >
          API Diagnostics
        </a>
      </div>
    </aside>
  );
}
