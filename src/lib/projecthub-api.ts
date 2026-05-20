'use client';

/**
 * Shim for `@workspace/api-client-react` from the projecthub package.
 *
 * Provides the same hook signatures used by the ported project-detail page
 * and section components, but backed by tool-wasabi's own Next.js API
 * routes under `/api/projecthub/...` (which in turn use Supabase).
 *
 * This lets us copy projecthub components with minimal source-level edits
 * (just changing the import path).
 *
 * Hooks not yet implemented for sections beyond General Brief return
 * undefined data + isLoading=false so components render an empty state
 * instead of crashing.
 */

import {
  useQuery,
  useMutation,
  type UseQueryOptions,
  type UseMutationOptions,
} from '@tanstack/react-query';

const API_BASE = '/api/projecthub';

// ─── Query key helpers (used for cache invalidation by components) ────────

export function getListProjectsQueryKey(params?: {
  search?: string;
}): readonly unknown[] {
  return ['projecthub', 'projects', 'list', params || {}];
}

export function getGetProjectQueryKey(id: string | number): readonly unknown[] {
  return ['projecthub', 'projects', 'detail', String(id)];
}

export function getGetProjectStatsQueryKey(
  id: string | number,
): readonly unknown[] {
  return ['projecthub', 'projects', 'stats', String(id)];
}

export function getListFunnelStepsQueryKey(
  id: string | number,
): readonly unknown[] {
  return ['projecthub', 'projects', String(id), 'funnel-steps'];
}

export function getGetFunnelStepChatQueryKey(
  id: string | number,
  stepId: number | string,
): readonly unknown[] {
  return [
    'projecthub',
    'projects',
    String(id),
    'funnel-steps',
    String(stepId),
    'chat',
  ];
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface PhProject {
  id: string;
  name: string;
  thumbnail_path?: string | null;
  product_brief_sections?: string;
  created_at: string;
  files?: PhProjectFile[];
}

export interface PhProjectFile {
  id: number;
  project_id: string;
  file_type: string;
  file_path: string;
  original_name: string;
  created_at: string;
}

// ─── Implemented hooks ────────────────────────────────────────────────────

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const r = await fetch(input, init);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`${r.status}: ${text || r.statusText}`);
  }
  return (await r.json()) as T;
}

type QueryOpts<T> = {
  query?: Partial<UseQueryOptions<T, Error, T, readonly unknown[]>> & {
    enabled?: boolean;
    queryKey?: readonly unknown[];
  };
};

type MutationOpts<TData, TVars> = {
  mutation?: Partial<UseMutationOptions<TData, Error, TVars>>;
};

export function useListProjects(
  params?: { search?: string },
  opts?: QueryOpts<PhProject[]>,
) {
  const queryKey = opts?.query?.queryKey || getListProjectsQueryKey(params);
  return useQuery<PhProject[], Error, PhProject[], readonly unknown[]>({
    queryKey,
    queryFn: () => {
      const qs = params?.search
        ? `?search=${encodeURIComponent(params.search)}`
        : '';
      return fetchJson<PhProject[]>(`${API_BASE}/projects${qs}`);
    },
    enabled: opts?.query?.enabled ?? true,
  });
}

export function useGetProject(
  id: string | number | undefined,
  opts?: QueryOpts<PhProject>,
) {
  const queryKey =
    opts?.query?.queryKey || (id ? getGetProjectQueryKey(id) : ['projecthub', 'project', 'noop']);
  return useQuery<PhProject, Error, PhProject, readonly unknown[]>({
    queryKey,
    queryFn: () => fetchJson<PhProject>(`${API_BASE}/projects/${id}`),
    enabled: (opts?.query?.enabled ?? true) && !!id,
  });
}

export function useCreateProject(
  opts?: MutationOpts<PhProject, FormData | Record<string, unknown>>,
) {
  return useMutation<PhProject, Error, FormData | Record<string, unknown>>({
    ...opts?.mutation,
    mutationFn: async (vars) => {
      if (vars instanceof FormData) {
        const r = await fetch(`${API_BASE}/projects`, { method: 'POST', body: vars });
        if (!r.ok) throw new Error(await r.text().catch(() => r.statusText));
        return r.json();
      }
      return fetchJson<PhProject>(`${API_BASE}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vars),
      });
    },
  });
}

export function useUpdateProject(
  opts?: MutationOpts<PhProject, { id: string; data: Partial<PhProject> }>,
) {
  return useMutation({
    ...opts?.mutation,
    mutationFn: ({ id, data }) =>
      fetchJson<PhProject>(`${API_BASE}/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
  });
}

export function useDeleteProject(
  opts?: MutationOpts<{ success: true }, { id: string }>,
) {
  return useMutation({
    ...opts?.mutation,
    mutationFn: ({ id }) =>
      fetchJson<{ success: true }>(`${API_BASE}/projects/${id}`, {
        method: 'DELETE',
      }),
  });
}

// ─── Stub hooks (return empty data so components render gracefully) ───────
//
// These will be implemented in subsequent commits as we port each section.

const emptyQuery = <T,>(): {
  data: T | undefined;
  isLoading: false;
  isError: false;
  error: null;
  refetch: () => Promise<{ data: T | undefined }>;
} => ({
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  refetch: async () => ({ data: undefined }),
});

const noopMutation = <TData, TVars>() => ({
  mutate: (_: TVars) => {
    console.warn('[projecthub-api] mutation not implemented yet');
  },
  mutateAsync: async (_: TVars): Promise<TData> => {
    throw new Error('Mutation not implemented yet (port pending)');
  },
  isPending: false,
  isError: false,
  isSuccess: false,
  data: undefined,
  error: null,
  reset: () => {},
});

export function useListFunnelSteps(_id: string | number | undefined, _opts?: unknown) {
  return emptyQuery<unknown[]>();
}
export function useCreateFunnelStep<TVars = unknown>(_opts?: unknown) {
  return noopMutation<unknown, TVars>();
}
export function useUpdateFunnelStep<TVars = unknown>(_opts?: unknown) {
  return noopMutation<unknown, TVars>();
}
export function useDeleteFunnelStep<TVars = unknown>(_opts?: unknown) {
  return noopMutation<unknown, TVars>();
}
export function useGetFunnelStepChat(
  _id: string | number | undefined,
  _stepId: number | string | undefined,
  _opts?: unknown,
) {
  return emptyQuery<unknown[]>();
}
