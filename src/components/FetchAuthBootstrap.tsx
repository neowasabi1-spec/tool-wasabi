/**
 * Mounts once at the top of the (main) layout to install the global
 * `window.fetch` auth interceptor. See `lib/auth/install-fetch-interceptor.ts`
 * for the rationale.
 *
 * Rendered as a sibling of `AuthGate` so the interceptor is in place BEFORE
 * any page-level data fetching starts — otherwise the first React Query
 * call after login would race the install and hit the API unauthenticated.
 */

'use client';

import { useEffect } from 'react';
import { installAuthFetchInterceptor } from '@/lib/auth/install-fetch-interceptor';
import { startSessionAutoRefresh } from '@/lib/auth/session-refresh';

export default function FetchAuthBootstrap() {
  useEffect(() => {
    installAuthFetchInterceptor();
    // Keep the Supabase session alive: without this the access token
    // silently expires (~30-60 min) and the user is bounced to /login.
    startSessionAutoRefresh();
  }, []);
  return null;
}
