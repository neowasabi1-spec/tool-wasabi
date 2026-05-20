'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from '@/components/ui/toaster';

/**
 * Wraps any projecthub-derived UI tree with:
 *  - a dedicated React Query client (separate from the rest of the app)
 *  - the `.dark` + `.projecthub-theme` class scope so shadcn HSL tokens
 *    resolve to dark values inside this subtree
 *  - the shadcn `<Toaster />` so toast notifications render
 */
export function ProjectHubProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <div className="dark projecthub-theme min-h-screen">
        {children}
        <Toaster />
      </div>
    </QueryClientProvider>
  );
}
