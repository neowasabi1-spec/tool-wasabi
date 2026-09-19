'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bookmark, FolderPlus, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { authFetch } from '@/lib/auth/client-fetch';
import { formatAdTags, parseAdTags } from '@/lib/ad-tags';
import { BUILT_IN_AD_TYPE_OPTIONS, humanizeAdTypeSlug } from '@/types';

export type SaveAdTemplateItem = {
  id: number;
  brandId: number;
  mediaType?: string;
  name?: string;
};

type Props = {
  open: boolean;
  projectId: string;
  items: SaveAdTemplateItem[];
  onClose: () => void;
  onSaved?: () => void;
};

type FolderOpt = { adType: string; name: string };

export default function SaveAdTemplateDialog({ open, projectId, items, onClose, onSaved }: Props) {
  const defaultType = items.every((a) => a.mediaType === 'video') ? 'video' : 'image';
  const [adType, setAdType] = useState(defaultType);
  const [folder, setFolder] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [tags, setTags] = useState('');
  const [folders, setFolders] = useState<FolderOpt[]>([]);
  const [customTypes, setCustomTypes] = useState<{ value: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAdType(items.every((a) => a.mediaType === 'video') ? 'video' : 'image');
    setFolder('');
    setCreatingFolder(false);
    setNewFolder('');
    setTags('');
  }, [open, items]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [adsRes, typesRes] = await Promise.all([
          authFetch('/api/templates/ads'),
          authFetch('/api/templates/ad-types'),
        ]);
        const adsJson = await adsRes.json().catch(() => ({}));
        const typesJson = await typesRes.json().catch(() => ({}));
        if (cancelled) return;
        const rows = Array.isArray(adsJson.ads) ? adsJson.ads as Array<{ ad_type?: string; media_type?: string; name?: string; category?: string }> : [];
        const found: FolderOpt[] = [];
        const seen = new Set<string>();
        for (const r of rows) {
          const adType = String(r.ad_type || '');
          const name = r.media_type === 'folder' ? String(r.name || '') : String(r.category || '');
          const key = `${adType}::${name.toLowerCase()}`;
          if (!adType || !name || seen.has(key)) continue;
          seen.add(key);
          found.push({ adType, name });
        }
        setFolders(found);
        const types = Array.isArray(typesJson.types) ? typesJson.types : [];
        setCustomTypes(types.map((t: { value: string; label: string }) => ({ value: t.value, label: t.label })));
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const typeOptions = useMemo(() => {
    const seen = new Set(BUILT_IN_AD_TYPE_OPTIONS.map((o) => o.value));
    const extras = customTypes.filter((t) => {
      if (!t.value || seen.has(t.value)) return false;
      seen.add(t.value);
      return true;
    });
    return [...BUILT_IN_AD_TYPE_OPTIONS, ...extras.map((t) => ({ value: t.value, label: t.label }))];
  }, [customTypes]);

  const foldersForType = folders.filter((f) => f.adType === adType);

  if (!open || items.length === 0) return null;

  const save = async () => {
    const category = creatingFolder ? newFolder.trim() : folder;
    if (creatingFolder && !category) {
      toast.error('Name the new folder');
      return;
    }
    setBusy(true);
    try {
      const byBrand = new Map<number, number[]>();
      for (const item of items) {
        const list = byBrand.get(item.brandId) || [];
        list.push(item.id);
        byBrand.set(item.brandId, list);
      }
      let saved = 0;
      for (const [brandId, adIds] of byBrand) {
        const res = await authFetch(
          `/api/projecthub/projects/${projectId}/competitor-library/${brandId}/ads/save-to-templates`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ad_ids: adIds,
              ad_type: adType,
              category,
              newFolder: creatingFolder ? category : '',
              tags: formatAdTags(parseAdTags(tags)),
            }),
          },
        );
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || 'Could not save to Ads templates');
        saved += Number(d.count || adIds.length);
      }
      const typeLabel = typeOptions.find((t) => t.value === adType)?.label || humanizeAdTypeSlug(adType);
      toast.success(
        saved === 1
          ? `Saved to Templates → Ads → ${typeLabel}${category ? ` → ${category}` : ''}`
          : `${saved} ads saved to Templates → Ads → ${typeLabel}${category ? ` → ${category}` : ''}`,
      );
      onSaved?.();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save to Ads templates');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={() => !busy && onClose()} />
      <div className="relative w-full max-w-md bg-card border border-border rounded-2xl shadow-2xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Bookmark className="w-4 h-4 text-sky-500" />
              Save to Ads templates
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {items.length === 1
                ? 'Pick Image, Video or Carousel, a folder, and optional tags.'
                : `Saving ${items.length} ads with the same type, folder and tags.`}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Type</span>
          <select
            value={adType}
            onChange={(e) => { setAdType(e.target.value); setFolder(''); }}
            disabled={busy}
            className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
          >
            {typeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Folder</span>
          <select
            value={creatingFolder ? '__new__' : folder}
            onChange={(e) => {
              if (e.target.value === '__new__') {
                setCreatingFolder(true);
                setFolder('');
              } else {
                setCreatingFolder(false);
                setFolder(e.target.value);
              }
            }}
            disabled={busy}
            className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
          >
            <option value="">Uncategorized</option>
            {foldersForType.map((f) => (
              <option key={f.name} value={f.name}>{f.name}</option>
            ))}
            <option value="__new__">Create new folder…</option>
          </select>
        </label>

        {creatingFolder && (
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">New folder name</span>
            <span className="mt-1 flex items-center gap-2">
              <FolderPlus className="w-4 h-4 text-muted-foreground shrink-0" />
              <input
                autoFocus
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                disabled={busy}
                placeholder="e.g. After Before, Hooks"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
              />
            </span>
          </label>
        )}

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Tags</span>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            disabled={busy}
            placeholder="ugc, hook, testimonial"
            className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">Comma-separated. Searchable later in Templates → Ads.</span>
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-2 rounded-lg border border-border text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="px-3 py-2 rounded-lg bg-sky-500 hover:bg-sky-600 text-white text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bookmark className="w-4 h-4" />}
            {busy ? 'Saving…' : items.length === 1 ? 'Save template' : `Save ${items.length} templates`}
          </button>
        </div>
      </div>
    </div>
  );
}
