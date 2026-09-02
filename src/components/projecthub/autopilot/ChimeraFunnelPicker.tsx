'use client';

import { useEffect, useMemo, useState } from 'react';
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
        setFunnels(pickerFunnelsFromArchive(rows));
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

  const selectedFunnel = funnels.find((f) => f.id === value.funnelId) || null;
  const selectedIdx = useMemo(() => new Set(value.steps.map((s) => s.index)), [value.steps]);
  const counts = countProductsFromSteps(value.steps);

  const applyFunnel = (funnelId: string) => {
    if (!funnelId) {
      onChange({ funnelId: '', steps: [] });
      return;
    }
    const f = funnels.find((x) => x.id === funnelId);
    onChange({ funnelId, steps: f ? [...f.steps] : [] });
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
              Steps to swipe · {value.steps.length}/{selectedFunnel.steps.length}
            </p>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={selectAll}
                disabled={disabled}
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
          <p className="text-xs font-medium text-foreground">
            {value.steps.length === 0
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
