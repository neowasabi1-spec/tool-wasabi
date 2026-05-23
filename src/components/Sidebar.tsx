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
  Brain,
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

const menuItems: MenuItem[] = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard, sectionId: null },
  { name: 'Strategist', href: '/strategist', icon: Brain, sectionId: null },
  { name: 'Clone / Swipe', href: '/front-end-funnel', icon: Copy, sectionId: 'front-end-funnel' },
  { name: 'Clone / Swipe Quiz', href: '/quiz-swipe', icon: HelpCircle, sectionId: 'quiz-swipe' },
  { name: 'My Archive', href: '/templates', icon: FileCode, sectionId: 'templates' },
  { name: 'Catalogue', href: '/products', icon: ShoppingBag, sectionId: 'products' },
  { name: 'My Projects', href: '/projects', icon: FolderOpen, sectionId: 'projects' },
  { name: 'Checkpoint', href: '/checkpoint', icon: ClipboardCheck, sectionId: 'checkpoint' },
  { name: 'Protocollo Valchiria', href: '/protocollo-valchiria', icon: Swords, sectionId: 'protocollo-valchiria' },
  { name: 'API Keys', href: '/api-keys', icon: KeyRound, sectionId: 'api-keys' },
  { name: 'Spesa API', href: '/api-usage', icon: DollarSign, sectionId: 'api-usage' },
  { name: 'Users', href: '/admin/users', icon: Users, sectionId: 'admin-users', masterOnly: true },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, permissions, loading } = useCurrentUser();

  const visibleItems = menuItems.filter(item => {
    if (item.sectionId === null) return true; // dashboard etc. — always visible
    if (item.masterOnly && permissions?.role !== 'master') return false;
    return canAccessSection(permissions, item.sectionId);
  });

  async function handleSignOut() {
    const supabase = getSupabaseBrowser();
    if (supabase) await supabase.auth.signOut();
    router.replace('/login');
  }

  return (
    <aside className="w-56 bg-gray-900 text-white min-h-screen flex flex-col">
      {/* Logo */}
      <div className="p-4 border-b border-gray-800">
        <h1 className="text-base font-bold flex items-center gap-2">
          <Layers className="w-5 h-5 text-blue-400" />
          Funnel Swiper
        </h1>
        <p className="text-gray-400 text-xs mt-0.5">Dashboard Operations</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-3">
        <ul className="space-y-1">
          {visibleItems.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                    isActive
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1 truncate">{item.name}</span>
                  {isActive && <ChevronRight className="w-3 h-3 shrink-0" />}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-gray-800 space-y-2">
        {!loading && user && (
          <div className="bg-gray-800 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2 min-w-0">
              <Shield className={`w-3.5 h-3.5 shrink-0 ${permissions?.role === 'master' ? 'text-amber-400' : 'text-gray-400'}`} />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-white truncate" title={user.email || ''}>
                  {user.email}
                </p>
                <p className="text-[10px] text-gray-400 uppercase tracking-wider">
                  {permissions?.role || 'user'}
                </p>
              </div>
            </div>
            <button
              onClick={handleSignOut}
              className="w-full flex items-center justify-center gap-1.5 text-[11px] text-gray-300 hover:text-white bg-gray-900 hover:bg-gray-700 rounded-md py-1.5 transition-colors"
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
          className="block text-xs text-gray-400 hover:text-amber-400 transition-colors"
        >
          API Diagnostics
        </a>
      </div>
    </aside>
  );
}
