/**
 * Sticky banner shown while a master is impersonating another user. Makes the
 * impersonated identity unmistakable and offers a one-click way back to the
 * master's own view. Renders nothing when not impersonating.
 */

'use client';

import { useEffect, useState } from 'react';
import { UserCog, X } from 'lucide-react';
import {
  getImpersonation,
  clearImpersonation,
  type ImpersonationTarget,
} from '@/lib/auth/impersonation-client';

export default function ImpersonationBanner() {
  const [target, setTarget] = useState<ImpersonationTarget | null>(null);

  // Read on mount (and on cross-tab storage changes) — avoids SSR mismatch.
  useEffect(() => {
    setTarget(getImpersonation());
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'wasabi_impersonate') setTarget(getImpersonation());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  if (!target) return null;

  const label = target.email || target.userId;

  return (
    <div className="sticky top-0 z-[100] flex items-center justify-center gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-amber-950 shadow-md">
      <UserCog className="h-4 w-4 flex-shrink-0" />
      <span className="truncate">
        You are impersonating <strong>{label}</strong> — you see exactly what they see.
      </span>
      <button
        onClick={clearImpersonation}
        className="inline-flex items-center gap-1 rounded-md bg-amber-950/15 px-2.5 py-1 text-xs font-semibold text-amber-950 transition-colors hover:bg-amber-950/25"
      >
        <X className="h-3.5 w-3.5" />
        Exit impersonation
      </button>
    </div>
  );
}
