'use client';

import { useEffect, useRef } from 'react';

/** Fired by LiveRefreshHost so every mounted section can refetch quietly. */
export const LIVE_REFRESH_EVENT = 'wasabi:live-refresh';

export function emitLiveRefresh(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(LIVE_REFRESH_EVENT));
}

/**
 * Re-run `reload` whenever the app broadcasts a live refresh (tab focus,
 * visibility, or a route change). The callback should be silent:
 * update state, do not flip full-page loading spinners.
 */
export function useLiveReload(reload: () => void | Promise<void>): void {
  const ref = useRef(reload);
  ref.current = reload;
  useEffect(() => {
    const run = () => {
      void ref.current();
    };
    window.addEventListener(LIVE_REFRESH_EVENT, run);
    return () => window.removeEventListener(LIVE_REFRESH_EVENT, run);
  }, []);
}
