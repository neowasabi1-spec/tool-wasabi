'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveReload } from '@/lib/live-refresh';
import { authFetch } from '@/lib/auth/client-fetch';
import {
  countProductsFromSteps,
  pickerFunnelsFromArchive,
  type PickerFunnel,
  type PickerStep,
} from '@/lib/archive-placement';

export type ChimeraFunnelPick = {
  funnelId: string;
  steps: PickerStep[];
};

function withSteps(f: PickerFunnel, steps: PickerStep[]): PickerFunnel {
  const counts = countProductsFromSteps(steps);
  return {
    ...f,
    steps,
    totalSteps: Math.max(f.totalSteps, steps.length),
    upsells: counts.upsells,
    products: counts.products,
  };
}

export function ChimeraFunnelPicker({
  value,
  onChange,
  disabled,
  id = 'ap-funnel',
  selectClassName = 'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm disabled:opacity-50',
}: {
  value: ChimeraFunnelPick;
  onChange: (pick: ChimeraFunnelPick) => void;
  disabled?: boolean;
  id?: string;
  selectClassName?: string;
}) {
  const [funnels, setFunnels] = useState<PickerFunnel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [stepsLoading, setStepsLoading] = useState(false);
  const [stepsError, setStepsError] = useState<string | null>(null);
  const loadedSteps = useRef<Set<string>>(new Set());
  const funnelsRef = useRef(funnels);
  funnelsRef.current = funnels;

  const mergeList = (rows: unknown[]) => {
    const next = pickerFunnelsFromArchive(rows as Parameters<typeof pickerFunnelsFromArchive>[0]);
    setFunnels((prev) => next.map((f) => {
      const old = prev.find((p) => p.id === f.id);
      if (old?.steps.length && !f.steps.length) return withSteps(f, old.steps);
      return f;
    }));
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch('/api/valchiria/funnels', { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setError((data && data.error) || `Could not load funnels (${res.status})`);
          return;
        }
        const rows = Array.isArray(data?.funnels) ? data.funnels : [];
        mergeList(rows);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message || 'Could not load funnels');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useLiveReload(() => {
    void (async () => {
      try {
        const res = await authFetch('/api/valchiria/funnels', { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (!res.ok || !Array.isArray(data?.funnels)) return;
        mergeList(data.funnels);
      } catch { /* keep last list */ }
    })();
  });

  const selectedFunnel = funnels.find((f) => f.id === value.funnelId) || null;
  const selectedIdx = useMemo(() => new Set(value.steps.map((s) => s.index)), [value.steps]);
  const counts = countProductsFromSteps(value.steps);

  useEffect(() => {
    const funnelId = value.funnelId;
    if (!funnelId || !loaded) return;
    const f = funnelsRef.current.find((x) => x.id === funnelId);
    if (f?.steps.length) {
      loadedSteps.current.add(funnelId);
      return;
    }
    if (loadedSteps.current.has(funnelId)) return;
    loadedSteps.current.add(funnelId);
    let cancelled = false;
    setStepsLoading(true);
    setStepsError(null);
    void (async () => {
      try {
        const res = await authFetch(`/api/valchiria/funnels/${encodeURIComponent(funnelId)}/steps`, {
          cache: 'no-store',
        });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setStepsError((data && data.error) || `Could not load steps (${res.status})`);
          return;
        }
        const steps = Array.isArray(data?.steps) ? (data.steps as PickerStep[]) : [];
        if (!steps.length) {
          setStepsError('This funnel has no steps to swipe.');
          return;
        }
        setFunnels((prev) => prev.map((x) => (x.id === funnelId ? withSteps(x, steps) : x)));
        onChange({ funnelId, steps });
      } catch (e) {
        if (!cancelled) setStepsError((e as Error).message || 'Could not load steps');
      } finally {
        if (!cancelled) setStepsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.funnelId, loaded]);

  const applyFunnel = (funnelId: string) => {
    if (!funnelId) {
      setStepsError(null);
      onChange({ funnelId: '', steps: [] });
      return;
    }
    const f = funnels.find((x) => x.id === funnelId);
    onChange({ funnelId, steps: f?.steps.length ? [...f.steps] : [] });
  };

  const toggleStep = (step: PickerStep) => {
    if (!selectedFunnel) return;
    const next = selectedIdx.has(step.index)
      ? value.steps.filter((s) => s.index !== step.index)
      : [...value.steps, step].sort((a, b) => a.index - b.index);
    onChange({ funnelId: value.funnelId, steps: next });
  };

  const selectAll = () => {
    if (!selectedFunnel) return;
    onChange({ funnelId: value.funnelId, steps: [...selectedFunnel.steps] });
  };

  const selectNone = () => {
    if (!value.funnelId) return;
    onChange({ funnelId: value.funnelId, steps: [] });
  };

  const stepTotal = Math.max(selectedFunnel?.steps.length || 0, selectedFunnel?.totalSteps || 0);

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium leading-none">
        Funnel to build (from templates)
      </label>
      <select
        id={id}
        value={value.funnelId}
        onChange={(e) => applyFunnel(e.target.value)}
        disabled={disabled}
        className={selectClassName}
      >
        <option value="">— No funnel: main product only —</option>
        {funnels.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name} · {f.totalSteps} steps · {f.products} products ({f.upsells} upsells)
            {f.isProject ? '' : ' · library'}
          </option>
        ))}
      </select>

      {selectedFunnel && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-xs font-medium text-foreground">
              Steps to swipe · {value.steps.length}/{stepTotal}
            </p>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={selectAll}
                disabled={disabled || !selectedFunnel.steps.length}
                className="text-primary hover:underline disabled:opacity-50"
              >
                All
              </button>
              <span className="text-muted-foreground">·</span>
              <button
                type="button"
                onClick={selectNone}
                disabled={disabled}
                className="text-muted-foreground hover:underline disabled:opacity-50"
              >
                None
              </button>
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {stepsLoading && selectedFunnel.steps.length === 0 && (
              <p className="text-xs text-muted-foreground py-2">Loading steps…</p>
            )}
            {selectedFunnel.steps.map((step) => {
              const checked = selectedIdx.has(step.index);
              return (
                <label
                  key={step.index}
                  className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer ${
                    checked ? 'bg-background' : 'opacity-60'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleStep(step)}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">
                      {step.index + 1}. {step.name}
                    </span>
                    {step.pageType && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {step.pageType}
                        {step.isUpsell ? ' · product' : ''}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
          {stepsError && <p className="text-xs text-red-500">{stepsError}</p>}
          <p className="text-xs font-medium text-foreground">
            {stepsLoading && value.steps.length === 0
              ? 'Loading the funnel steps…'
              : value.steps.length === 0
              ? 'Select at least one step, or Chimera builds the main product only.'
              : `Creates ${counts.products} product${counts.products === 1 ? '' : 's'}${
                  counts.upsells > 0
                    ? ` (${counts.hasMain ? '1 main + ' : ''}${counts.upsells} upsell${counts.upsells === 1 ? '' : 's'})`
                    : ' (main only)'
                } from the selected steps.`}
          </p>
        </div>
      )}

      {loaded && error && <p className="text-xs text-red-500">{error}</p>}
      {loaded && !error && funnels.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No multi-step funnels in Templates yet. Whatever you see under Templates → Funnel appears here.
        </p>
      )}
      {!selectedFunnel && (
        <p className="text-xs text-muted-foreground">
          Pick a funnel, then tick the steps to swipe. Product count (main + one per upsell) is read from
          those steps only.
        </p>
      )}
    </div>
  );
}
