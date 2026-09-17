'use client';

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from '@/components/ui/toaster';
import { useLiveReload } from '@/lib/live-refresh';

function QueryLiveInvalidator() {
  const queryClient = useQueryClient();
  useLiveReload(() => {
    void queryClient.invalidateQueries();
  });
  return null;
}

/**
 * Wraps any projecthub-derived UI tree with:
 *  - a dedicated React Query client (separate from the rest of the app)
 *  - the `.projecthub-theme` class scope, which pins the shadcn HSL tokens to
 *    the light palette and paints the surface white behind them
 *  - the shadcn `<Toaster />` so toast notifications render
 */
export function ProjectHubProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: true,
            refetchInterval: 20_000,
            refetchIntervalInBackground: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <QueryLiveInvalidator />
      <div className="projecthub-theme min-h-screen">
        {children}
        <Toaster />
      </div>
    </QueryClientProvider>
  );
}
