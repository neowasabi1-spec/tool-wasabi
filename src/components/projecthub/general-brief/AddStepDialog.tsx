'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useStore } from '@/store/useStore';
import { listArchivePagesByType, type ArchiveTemplatePage } from '@/lib/archive-template-pages';
import {
  BUILT_IN_PAGE_TYPE_OPTIONS,
  PAGE_TYPE_CATEGORIES,
  humanizePageTypeSlug,
  normalizeArchiveType,
  type PageTypeOption,
} from '@/types';
import { ArrowLeft, FolderOpen, LayoutTemplate, Loader2 } from 'lucide-react';

export type PickedStepTemplate = {
  name: string;
  url: string;
  funnelName: string;
  funnelId: string;
  screenshotUrl: string | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** When set, skip the category grid and open templates for this type. */
  initialPageType?: string;
  onConfirm: (pageType: string, label: string, template: PickedStepTemplate | null) => void;
};

export function AddStepDialog({ open, onClose, initialPageType, onConfirm }: Props) {
  const {
    archivedFunnels,
    archivedFunnelsLoaded,
    archivedFunnelsLoading,
    loadArchivedFunnels,
    customPageTypes,
    loadCustomPageTypes,
    templates,
  } = useStore();

  const [pickedType, setPickedType] = useState<string | null>(initialPageType || null);

  useEffect(() => {
    if (!open) return;
    setPickedType(initialPageType || null);
    void loadArchivedFunnels();
    void loadCustomPageTypes();
  }, [open, initialPageType, loadArchivedFunnels, loadCustomPageTypes]);

  const knownCustomTypes = useMemo(
    () => (customPageTypes || []).map((ct) => ct.value),
    [customPageTypes],
  );

  const pagesByType = useMemo(() => {
    const map = listArchivePagesByType(archivedFunnels || [], knownCustomTypes);
    for (const t of templates || []) {
      const type = normalizeArchiveType(t.pageType, knownCustomTypes);
      const url = t.sourceUrl || '';
      if (!url) continue;
      const list = map[type] || [];
      if (list.some((p) => p.url_to_swipe === url)) continue;
      list.push({
        funnel_name: 'Templates',
        funnel_id: t.id,
        name: t.name,
        url_to_swipe: url,
        prompt: '',
        page_type: type,
        screenshotUrl: t.previewImage || null,
      });
      map[type] = list;
    }
    return map;
  }, [archivedFunnels, knownCustomTypes, templates]);

  const typeFolderOptions: PageTypeOption[] = useMemo(() => {
    const customOptions: PageTypeOption[] = (customPageTypes || []).map((ct) => ({
      value: ct.value,
      label: ct.label,
      category: 'custom' as const,
    }));
    const all = [...BUILT_IN_PAGE_TYPE_OPTIONS, ...customOptions];
    const seen = new Set(all.map((o) => o.value));
    const extras: PageTypeOption[] = [];
    for (const t of Object.keys(pagesByType)) {
      if (t === 'altro' || seen.has(t)) continue;
      extras.push({ value: t, label: humanizePageTypeSlug(t), category: 'custom' });
    }
    return [...all, ...extras];
  }, [customPageTypes, pagesByType]);

  const getLabel = (value: string) =>
    typeFolderOptions.find((o) => o.value === value)?.label || humanizePageTypeSlug(value);

  const pages = pickedType ? pagesByType[pickedType] || [] : [];

  const pickType = (value: string) => setPickedType(value);

  const confirmWith = (tpl: PickedStepTemplate | null) => {
    if (!pickedType) return;
    onConfirm(pickedType, getLabel(pickedType), tpl);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-4xl sm:max-w-4xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {pickedType ? `Templates — ${getLabel(pickedType)}` : 'Choose step category'}
          </DialogTitle>
          <DialogDescription>
            {pickedType
              ? 'Pick a template from Templates for this step, or add the step without one.'
              : 'Landing, upsell, OTO, checkout… you choose the type before the step is created.'}
          </DialogDescription>
        </DialogHeader>

        {pickedType && (
          <button
            type="button"
            onClick={() => setPickedType(null)}
            className="self-start inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to categories
          </button>
        )}

        <div className="overflow-y-auto min-h-0 pr-1 max-h-[60vh]">
          {!pickedType ? (
            <div className="space-y-5">
              {PAGE_TYPE_CATEGORIES.map((cat) => {
                const opts = typeFolderOptions.filter((o) => o.category === cat.value);
                if (opts.length === 0) return null;
                return (
                  <div key={cat.value}>
                    <p className={`inline-flex mb-2 px-2 py-0.5 rounded-full text-[10px] font-semibold ${cat.color}`}>
                      {cat.label}
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {opts.map((opt) => {
                        const count = (pagesByType[opt.value] || []).length;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => pickType(opt.value)}
                            className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 text-left hover:border-primary/50 hover:bg-primary/5 transition-colors"
                          >
                            <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-muted text-muted-foreground">
                              <FolderOpen className="w-4 h-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium truncate">{opt.label}</span>
                              <span className="block text-[11px] text-muted-foreground">
                                {count === 1 ? '1 template' : `${count} templates`}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : archivedFunnelsLoading && !archivedFunnelsLoaded ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
              Loading templates…
            </div>
          ) : pages.length === 0 ? (
            <div className="py-12 text-center border-2 border-dashed border-border rounded-xl">
              <LayoutTemplate className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm font-medium">No templates for {getLabel(pickedType)}</p>
              <p className="text-xs text-muted-foreground mt-1 mb-4">
                Save pages of this type in Templates, or add the step empty.
              </p>
              <button
                type="button"
                onClick={() => confirmWith(null)}
                className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Add step without template
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {pages.map((p) => (
                <TemplatePickCard
                  key={`${p.funnel_id}::${p.url_to_swipe}::${p.name}`}
                  page={p}
                  onPick={() => confirmWith({
                    name: p.name,
                    url: p.url_to_swipe,
                    funnelName: p.funnel_name,
                    funnelId: p.funnel_id,
                    screenshotUrl: p.screenshotUrl,
                  })}
                />
              ))}
            </div>
          )}
        </div>

        {pickedType && pages.length > 0 && (
          <div className="pt-2 border-t border-border flex justify-end">
            <button
              type="button"
              onClick={() => confirmWith(null)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Add step without template
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TemplatePickCard({
  page,
  onPick,
}: {
  page: ArchiveTemplatePage;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="group rounded-xl border border-border bg-card overflow-hidden text-left hover:border-primary/50 hover:shadow-md transition-all"
    >
      <div className="aspect-[9/16] bg-muted overflow-hidden">
        {page.screenshotUrl ? (
          <img
            src={page.screenshotUrl}
            alt={page.name}
            className="w-full h-full object-cover object-top group-hover:scale-[1.02] transition-transform"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
            <LayoutTemplate className="w-8 h-8" />
          </div>
        )}
      </div>
      <div className="p-2.5">
        <p className="text-xs font-medium truncate">{page.name}</p>
        <p className="text-[10px] text-muted-foreground truncate">{page.funnel_name}</p>
      </div>
    </button>
  );
}
