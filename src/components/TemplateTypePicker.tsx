'use client';

import { useEffect, useMemo, useState } from 'react';
import { LayoutTemplate, Loader2, Search, X } from 'lucide-react';
import { useStore } from '@/store/useStore';
import {
  listTemplatesForStepType,
  pickerValueForTemplate,
  type ArchiveTemplatePage,
} from '@/lib/archive-template-pages';
import { humanizePageTypeSlug, normalizeArchiveType } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export function TemplatePickerDialog({
  open,
  stepType,
  selectedValue,
  onClose,
  onPick,
}: {
  open: boolean;
  stepType: string;
  selectedValue?: string;
  onClose: () => void;
  onPick: (page: ArchiveTemplatePage) => void;
}) {
  const {
    archivedFunnels,
    archivedFunnelsLoaded,
    archivedFunnelsLoading,
    loadArchivedFunnels,
    customPageTypes,
  } = useStore();
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    setSearch('');
    const has = (useStore.getState().archivedFunnels || []).length > 0;
    void loadArchivedFunnels(!has);
  }, [open, loadArchivedFunnels]);

  const knownCustomTypes = useMemo(
    () => (customPageTypes || []).map((ct) => ct.value),
    [customPageTypes],
  );

  const pages = useMemo(() => {
    const out = listTemplatesForStepType(
      stepType,
      archivedFunnels || [],
      undefined,
      knownCustomTypes,
    );
    const q = search.trim().toLowerCase();
    if (!q) return out;
    return out.filter((p) =>
      `${p.name} ${p.funnel_name} ${p.url_to_swipe}`.toLowerCase().includes(q),
    );
  }, [archivedFunnels, knownCustomTypes, stepType, search]);

  const typeLabel =
    humanizePageTypeSlug(normalizeArchiveType(stepType, knownCustomTypes)) || stepType;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-w-4xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Template → {typeLabel}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${typeLabel} templates…`}
            className="pl-8 h-9 text-sm"
          />
        </div>
        {archivedFunnelsLoading && !archivedFunnelsLoaded ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
            Loading templates…
          </div>
        ) : pages.length === 0 ? (
          <div className="py-12 text-center border-2 border-dashed border-border rounded-xl">
            <LayoutTemplate className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm font-medium">No {typeLabel} templates</p>
            <p className="text-xs text-muted-foreground mt-1">
              Save pages in Template → By Type → {typeLabel}.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {pages.map((p) => {
              const value = pickerValueForTemplate(p);
              const selected = selectedValue === value;
              return (
                <button
                  key={`${p.funnel_id}::${p.url_to_swipe}::${p.name}`}
                  type="button"
                  onClick={() => onPick(p)}
                  className={`group bg-white rounded-2xl border overflow-hidden text-left hover:shadow-xl transition-shadow ${
                    selected
                      ? 'border-green-400 ring-2 ring-green-200'
                      : 'border-gray-200 hover:border-indigo-300'
                  }`}
                >
                  <div className="relative aspect-[9/16] bg-gray-100 overflow-hidden">
                    {p.screenshotUrl ? (
                      <img
                        src={p.screenshotUrl}
                        alt={p.name}
                        className="block w-full h-full object-cover object-top group-hover:scale-[1.02] transition-transform"
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-gray-300">
                        <LayoutTemplate className="w-8 h-8" />
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <p className="font-semibold text-sm text-gray-900 truncate">{p.name}</p>
                    {p.funnel_name && p.funnel_name !== p.name && (
                      <p className="text-[10px] text-gray-400 truncate">from: {p.funnel_name}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function TemplatePickerCell({
  pageType,
  templateId,
  typeLabel,
  onPick,
}: {
  pageType: string;
  templateId?: string;
  typeLabel: string;
  onPick: (page: ArchiveTemplatePage | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const archivedFunnels = useStore((s) => s.archivedFunnels);
  const customPageTypes = useStore((s) => s.customPageTypes);
  const knownCustomTypes = useMemo(
    () => (customPageTypes || []).map((ct) => ct.value),
    [customPageTypes],
  );
  const pages = useMemo(
    () =>
      listTemplatesForStepType(
        pageType,
        archivedFunnels || [],
        undefined,
        knownCustomTypes,
      ),
    [archivedFunnels, knownCustomTypes, pageType],
  );
  const selected = pages.find((p) => pickerValueForTemplate(p) === templateId);

  return (
    <>
      <div className="flex items-center gap-0.5 min-w-0">
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={
            selected
              ? selected.name
              : pages.length === 0
                ? `No ${typeLabel} templates`
                : `Pick a ${typeLabel} template`
          }
          className="flex items-center gap-1.5 min-w-0 flex-1 rounded border border-gray-200 bg-white px-1 py-0.5 text-left hover:border-indigo-300 hover:bg-indigo-50/40"
        >
          {selected?.screenshotUrl ? (
            <img
              src={selected.screenshotUrl}
              alt=""
              className="w-7 h-9 rounded object-cover object-top flex-shrink-0 bg-gray-100"
            />
          ) : (
            <span className="w-7 h-9 rounded bg-gray-100 flex items-center justify-center flex-shrink-0 text-gray-400">
              <LayoutTemplate className="w-3.5 h-3.5" />
            </span>
          )}
          <span className="min-w-0 truncate text-[11px] text-gray-700">
            {selected
              ? selected.name
              : pages.length === 0
                ? `No ${typeLabel}`
                : 'Pick template'}
          </span>
        </button>
        {templateId && (
          <button
            type="button"
            title="Clear template"
            onClick={() => onPick(null)}
            className="p-0.5 text-gray-400 hover:text-red-500 flex-shrink-0"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      <TemplatePickerDialog
        open={open}
        stepType={pageType}
        selectedValue={templateId}
        onClose={() => setOpen(false)}
        onPick={(page) => {
          onPick(page);
          setOpen(false);
        }}
      />
    </>
  );
}
