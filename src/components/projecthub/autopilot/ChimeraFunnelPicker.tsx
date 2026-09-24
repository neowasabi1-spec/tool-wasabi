'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutTemplate, X } from 'lucide-react';
import { useLiveReload } from '@/lib/live-refresh';
import { authFetch } from '@/lib/auth/client-fetch';
import {
  countProductsFromSteps,
  isUpsellPageType,
  pickerFunnelsFromArchive,
  type PickerFunnel,
  type PickerStep,
} from '@/lib/archive-placement';
import {
  listArchivePagesByType,
  pickerValueForTemplate,
  type ArchiveTemplatePage,
} from '@/lib/archive-template-pages';
import { TemplatePickerDialog } from '@/components/TemplateTypePicker';
import { useStore } from '@/store/useStore';
import {
  BUILT_IN_PAGE_TYPE_OPTIONS,
  PAGE_TYPE_CATEGORIES,
  humanizePageTypeSlug,
  type PageTypeOption,
} from '@/types';
import type { ArchivedFunnel } from '@/types/database';

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

function pageToStep(page: ArchiveTemplatePage): PickerStep {
  return {
    index: 0,
    name: page.name,
    pageType: page.page_type,
    isUpsell: isUpsellPageType(page.page_type, page.name, page.url_to_swipe),
    url: page.url_to_swipe || undefined,
    pageId: page.funnel_id,
    htmlUrl: page.htmlUrl || undefined,
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
  const [source, setSource] = useState<'funnel' | 'page'>('funnel');
  const [funnels, setFunnels] = useState<PickerFunnel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [stepsLoading, setStepsLoading] = useState(false);
  const [stepsError, setStepsError] = useState<string | null>(null);
  const [pickerType, setPickerType] = useState<string | null>(null);
  const [localPage, setLocalPage] = useState<ArchiveTemplatePage | null>(null);
  const loadedSteps = useRef<Set<string>>(new Set());
  const funnelsRef = useRef(funnels);
  funnelsRef.current = funnels;

  const archivedFunnels = useStore((s) => s.archivedFunnels);
  const archivedFunnelsLoaded = useStore((s) => s.archivedFunnelsLoaded);
  const loadArchivedFunnels = useStore((s) => s.loadArchivedFunnels);
  const customPageTypes = useStore((s) => s.customPageTypes);
  const loadCustomPageTypes = useStore((s) => s.loadCustomPageTypes);

  const mergeList = (rows: unknown[]) => {
    const next = pickerFunnelsFromArchive(rows as Parameters<typeof pickerFunnelsFromArchive>[0]);
    setFunnels((prev) => next.map((f) => {
      const old = prev.find((p) => p.id === f.id);
      if (old?.steps.length && !f.steps.length) return withSteps(f, old.steps);
      return f;
    }));
  };

  useEffect(() => {
    void loadCustomPageTypes();
  }, [loadCustomPageTypes]);

  useEffect(() => {
    if (source !== 'page') return;
    const has = (useStore.getState().archivedFunnels || []).length > 0;
    void loadArchivedFunnels(!has);
  }, [source, loadArchivedFunnels]);

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

  const knownCustomTypes = useMemo(
    () => (customPageTypes || []).map((ct) => ct.value),
    [customPageTypes],
  );

  const pagesByType = useMemo(
    () => listArchivePagesByType((archivedFunnels || []) as ArchivedFunnel[], knownCustomTypes),
    [archivedFunnels, knownCustomTypes],
  );

  const allPageTypeOptions: PageTypeOption[] = useMemo(() => {
    const customOptions: PageTypeOption[] = (customPageTypes || []).map((ct) => ({
      value: ct.value,
      label: ct.label,
      category: 'custom' as const,
    }));
    const seen = new Set([...BUILT_IN_PAGE_TYPE_OPTIONS, ...customOptions].map((o) => o.value));
    const extras: PageTypeOption[] = [];
    for (const t of Object.keys(pagesByType)) {
      if (seen.has(t)) continue;
      extras.push({
        value: t,
        label: t === 'altro' ? 'Altro' : humanizePageTypeSlug(t),
        category: t === 'altro' ? 'other' : 'custom',
      });
    }
    return [...BUILT_IN_PAGE_TYPE_OPTIONS, ...customOptions, ...extras];
  }, [customPageTypes, pagesByType]);

  const groupedPageTypes = useMemo(() => {
    const groups: Record<string, PageTypeOption[]> = {};
    PAGE_TYPE_CATEGORIES.forEach((cat) => {
      groups[cat.value] = allPageTypeOptions.filter((opt) => opt.category === cat.value);
    });
    return groups;
  }, [allPageTypeOptions]);

  const pickedPage = useMemo(() => {
    if (source !== 'page' || !value.funnelId) return null;
    if (localPage && localPage.funnel_id === value.funnelId) return localPage;
    const wantUrl = value.steps[0]?.url || '';
    for (const pages of Object.values(pagesByType)) {
      const hit = pages.find((p) =>
        p.funnel_id === value.funnelId && (!wantUrl || p.url_to_swipe === wantUrl),
      );
      if (hit) return hit;
    }
    return null;
  }, [localPage, pagesByType, source, value.funnelId, value.steps]);

  const selectedFunnel = source === 'funnel'
    ? (funnels.find((f) => f.id === value.funnelId) || null)
    : null;
  const selectedIdx = useMemo(() => new Set(value.steps.map((s) => s.index)), [value.steps]);
  const counts = countProductsFromSteps(value.steps);

  useEffect(() => {
    if (!value.funnelId || !loaded) return;
    if (localPage && localPage.funnel_id === value.funnelId) {
      setSource('page');
      return;
    }
    if (funnelsRef.current.some((x) => x.id === value.funnelId)) {
      setSource('funnel');
      return;
    }
    const isPage = Object.values(pagesByType).some((pages) =>
      pages.some((p) => p.funnel_id === value.funnelId),
    );
    if (isPage) setSource('page');
  }, [value.funnelId, loaded, pagesByType, localPage]);

  useEffect(() => {
    const funnelId = value.funnelId;
    if (!funnelId || !loaded || source !== 'funnel') return;
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
  }, [value.funnelId, loaded, source]);

  const switchSource = (next: 'funnel' | 'page') => {
    if (next === source) return;
    setSource(next);
    setPickerType(null);
    setLocalPage(null);
    setStepsError(null);
    onChange({ funnelId: '', steps: [] });
  };

  const applyFunnel = (funnelId: string) => {
    if (!funnelId) {
      setStepsError(null);
      onChange({ funnelId: '', steps: [] });
      return;
    }
    const f = funnels.find((x) => x.id === funnelId);
    onChange({ funnelId, steps: f?.steps.length ? [...f.steps] : [] });
  };

  const applyPage = (page: ArchiveTemplatePage) => {
    setLocalPage(page);
    onChange({ funnelId: page.funnel_id, steps: [pageToStep(page)] });
    setPickerType(null);
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

  const openType = (type: string) => {
    if (disabled) return;
    setPickerType(type);
  };

  const stepTotal = Math.max(selectedFunnel?.steps.length || 0, selectedFunnel?.totalSteps || 0);

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium leading-none">
        Funnel or page to build (from templates)
      </label>
      <div className="flex rounded-lg border border-border bg-muted/40 p-0.5 w-full sm:w-fit">
        <button
          type="button"
          disabled={disabled}
          onClick={() => switchSource('funnel')}
          className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            source === 'funnel'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Funnel templates
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => switchSource('page')}
          className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            source === 'page'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Pages
        </button>
      </div>

      {source === 'funnel' && (
        <>
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
        </>
      )}

      {source === 'page' && (
        <>
          <select
            id={`${id}-page-type`}
            value={pickerType || ''}
            onChange={(e) => {
              const next = e.target.value;
              if (next) openType(next);
            }}
            disabled={disabled}
            className={selectClassName}
          >
            <option value="">— Choose a page type —</option>
            {PAGE_TYPE_CATEGORIES.map((category) => {
              const categoryOptions = groupedPageTypes[category.value] || [];
              if (categoryOptions.length === 0) return null;
              return (
                <optgroup key={category.value} label={category.label}>
                  {categoryOptions.map((opt) => {
                    const count = (pagesByType[opt.value] || []).length;
                    return (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}{count ? ` (${count})` : ''}
                      </option>
                    );
                  })}
                </optgroup>
              );
            })}
          </select>

          {pickedPage && (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-2">
              {pickedPage.screenshotUrl ? (
                <img
                  src={pickedPage.screenshotUrl}
                  alt=""
                  className="w-10 h-14 rounded object-cover object-top flex-shrink-0 bg-muted"
                />
              ) : (
                <span className="w-10 h-14 rounded bg-muted flex items-center justify-center flex-shrink-0 text-muted-foreground">
                  <LayoutTemplate className="w-4 h-4" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{pickedPage.name}</p>
                <p className="text-xs text-muted-foreground">
                  {humanizePageTypeSlug(pickedPage.page_type) || pickedPage.page_type}
                </p>
              </div>
              <button
                type="button"
                disabled={disabled}
                onClick={() => openType(pickedPage.page_type)}
                className="text-xs text-primary hover:underline disabled:opacity-50"
              >
                Change
              </button>
              <button
                type="button"
                disabled={disabled}
                title="Clear page"
                onClick={() => {
                  setLocalPage(null);
                  onChange({ funnelId: '', steps: [] });
                }}
                className="p-1 text-muted-foreground hover:text-destructive disabled:opacity-50"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {!pickedPage && (
            <p className="text-xs text-muted-foreground">
              Pick a page type — the template cards open in a popup, same as Clone/Swipe.
              Leave empty to build the main product only.
            </p>
          )}
          {source === 'page' && archivedFunnelsLoaded && Object.keys(pagesByType).length === 0 && (
            <p className="text-xs text-muted-foreground">
              No standalone pages in Templates yet. Save pages under Templates → Pages, then pick a type here.
            </p>
          )}
        </>
      )}

      <TemplatePickerDialog
        open={!!pickerType}
        stepType={pickerType || 'landing'}
        selectedValue={pickedPage ? pickerValueForTemplate(pickedPage) : undefined}
        onClose={() => setPickerType(null)}
        onPick={applyPage}
      />
    </div>
  );
}
