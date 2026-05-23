/**
 * Client-side auth + permission gate that wraps every page under (main).
 *
 * Responsibilities:
 *   1. If no session → redirect to /login (preserving the original path
 *      as ?redirect=...)
 *   2. If session but no permission to view the current section →
 *      redirect to /no-access
 *   3. Otherwise render the children
 *
 * The route home `/` is always allowed for any logged-in user — the
 * landing page handles its own redirect to the first allowed section.
 *
 * IMPORTANT: this only gates the UI. API routes are independently
 * protected by `requireAuth()` / `requireMaster()` in src/lib/auth/
 * server-guard.ts — never assume the AuthGate is the only line of
 * defense.
 */

'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { findSectionByPath, canAccessSection } from '@/lib/auth/sections';
import { Loader2 } from 'lucide-react';

// Paths under (main) that any logged-in user can view regardless of
// per-section permissions (the landing page handles its own redirect,
// and /no-access is the "you don't have permission" screen itself).
const ALWAYS_ALLOWED = new Set(['/', '/no-access']);

export default function AuthGate({ children }: { children: ReactNode }) {
  const { user, permissions, loading } = useCurrentUser();
  const pathname = usePathname() || '/';
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    // No session → /login with ?redirect= so they bounce back after auth.
    if (!user) {
      const search = pathname !== '/' ? `?redirect=${encodeURIComponent(pathname)}` : '';
      router.replace(`/login${search}`);
      return;
    }

    // Always-allowed paths (landing, no-access) skip the section check.
    if (ALWAYS_ALLOWED.has(pathname)) return;

    // Find the section that owns this path. Unknown paths (no matching
    // section) are allowed by default to avoid bricking ad-hoc pages.
    const section = findSectionByPath(pathname);
    if (!section) return;

    if (!canAccessSection(permissions, section.id)) {
      router.replace('/no-access');
    }
  }, [loading, user, permissions, pathname, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
      </div>
    );
  }

  // While the effect above redirects to /login, render nothing so the
  // dashboard data-loading hooks don't start firing requests with no
  // session attached.
  if (!user) return null;

  // Same idea for the per-section block: while we redirect to /no-access,
  // don't render the actual page. (The /no-access page itself reaches
  // here because it's in ALWAYS_ALLOWED.)
  if (!ALWAYS_ALLOWED.has(pathname)) {
    const section = findSectionByPath(pathname);
    if (section && !canAccessSection(permissions, section.id)) return null;
  }

  return <>{children}</>;
}
