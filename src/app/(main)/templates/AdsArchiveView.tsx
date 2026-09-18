'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight, FolderOpen, Loader2, Megaphone, Play, Plus, Search, Tag,
  Trash2, Upload, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { authFetch } from '@/lib/auth/client-fetch';
import { confirmDialog } from '@/components/ui/confirm';
import { adMatchesQuery, formatAdTags, parseAdTags } from '@/lib/ad-tags';
import { getUploadUrl } from '@/lib/projecthub-storage';
import AdsRecreatePanel, { type RecreatePreview } from './AdsRecreatePanel';
import {
  AD_TYPE_CATEGORIES,
  BUILT_IN_AD_TYPE_OPTIONS,
  humanizeAdTypeSlug,
  type AdTypeOption,
} from '@/types';

export type ArchiveAd = {
  id: string;
  name: string;
  ad_type: string;
  category: string;
  media_type: string;
  file_path: string;
  tags: string;
  headline: string;
  primary_text: string;
  created_at: string;
};

const UNFILED = '__unfiled__';

function downloadHref(path: string) {
  const url = getUploadUrl(path);
  return url + (url.includes('?') ? '&' : '?') + 'download=1';
}

type Props = {
  search: string;
  onFolderCount?: (count: number) => void;
};

export default function AdsArchiveView({ search, onFolderCount }: Props) {
  const [rows, setRows] = useState<ArchiveAd[]>([]);
  const [customTypes, setCustomTypes] = useState<AdTypeOption[]>([]);
  const [addingType, setAddingType] = useState(false);
  const [newTypeFolder, setNewTypeFolder] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [openType, setOpenType] = useState<string | null>(null);
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [missingTable, setMissingTable] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<ArchiveAd | null>(null);
  const [recreated, setRecreated] = useState<RecreatePreview | null>(null);
  const [tagFilter, setTagFilter] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => rows.filter((r) => r.media_type !== 'folder'), [rows]);
  const folderRows = useMemo(() => rows.filter((r) => r.media_type === 'folder'), [rows]);

  const loadAds = useCallback(async () => {
    try {
      const res = await authFetch('/api/templates/ads');
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not load ads');
      setMissingTable(Boolean(d.missingTable));
      setRows(Array.isArray(d.ads) ? d.ads : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load ads');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTypes = useCallback(async () => {
    try {
      const res = await authFetch('/api/templates/ad-types');
      if (!res.ok) return;
      const d = await res.json();
      const types = Array.isArray(d.types) ? d.types : [];
      setCustomTypes(types.map((t: { value: string; label: string }) => ({
        value: t.value,
        label: t.label,
        category: 'custom' as const,
      })));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void loadAds();
    void loadTypes();
  }, [loadAds, loadTypes]);

  const typeFolderOptions: AdTypeOption[] = useMemo(() => {
    const seen = new Set(BUILT_IN_AD_TYPE_OPTIONS.map((o) => o.value));
    const extras: AdTypeOption[] = [...customTypes.filter((t) => {
      if (seen.has(t.value)) return false;
      seen.add(t.value);
      return true;
    })];
    for (const row of rows) {
      const t = String(row.ad_type || '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      extras.push({ value: t, label: humanizeAdTypeSlug(t), category: 'custom' });
    }
    return [...BUILT_IN_AD_TYPE_OPTIONS, ...extras];
  }, [rows, customTypes]);

  const q = search.trim().toLowerCase();

  useEffect(() => {
    const n = new Set(items.map((a) => a.ad_type).filter(Boolean)).size;
    onFolderCount?.(n);
  }, [items, onFolderCount]);

  useEffect(() => {
    setRecreated(null);
  }, [preview?.id]);

  const itemsInType = (type: string) => items.filter((a) => (a.ad_type || 'image') === type);

  const categoryFolders = (type: string) => {
    const explicit = folderRows.filter((f) => f.ad_type === type).map((f) => f.name);
    const implicit = itemsInType(type).map((a) => a.category).filter(Boolean);
    return Array.from(new Set([...explicit, ...implicit])).sort((a, b) => a.localeCompare(b));
  };

  const folderRowFor = (type: string, name: string) =>
    folderRows.find((f) => f.ad_type === type && f.name === name);

  const adsInFolder = (type: string, folder: string | null) => {
    const list = itemsInType(type);
    if (!folder) return list;
    if (folder === UNFILED) return list.filter((a) => !a.category);
    return list.filter((a) => a.category === folder);
  };

  const addTypeFolder = async () => {
    const name = newTypeFolder.trim();
    if (!name) return;
    try {
      const res = await authFetch('/api/templates/ad-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not create folder');
      if (d.value) {
        setCustomTypes((prev) => (
          prev.some((t) => t.value === d.value)
            ? prev
            : [...prev, { value: d.value, label: d.label || name, category: 'custom' }]
        ));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create folder');
    }
    setNewTypeFolder('');
    setAddingType(false);
  };

  const addCategoryFolder = async () => {
    const name = newCategory.trim();
    if (!name || !openType) return;
    try {
      const res = await authFetch('/api/templates/ads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'folder', name, ad_type: openType }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not create folder');
      setRows((prev) => [d as ArchiveAd, ...prev]);
      toast.success(`Folder "${name}" created`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create folder');
    }
    setNewCategory('');
    setAddingCategory(false);
  };

  const deleteCategoryFolder = async (type: string, name: string) => {
    const row = folderRowFor(type, name);
    const ok = await confirmDialog({
      title: 'Delete folder',
      message: `Delete folder "${name}"? Ads inside stay and move to Uncategorized.`,
      confirmText: 'Delete folder',
      danger: true,
    });
    if (!ok) return;
    if (row) {
      const res = await authFetch(`/api/templates/ads/${row.id}`, { method: 'DELETE' });
      if (!res.ok) { toast.error('Delete failed'); return; }
      setRows((prev) => prev
        .filter((x) => x.id !== row.id)
        .map((x) => (x.ad_type === type && x.category === name && x.media_type !== 'folder' ? { ...x, category: '' } : x)));
    } else {
      setRows((prev) => prev.map((x) => (
        x.ad_type === type && x.category === name && x.media_type !== 'folder' ? { ...x, category: '' } : x
      )));
      await Promise.all(
        itemsInType(type).filter((a) => a.category === name).map((a) =>
          authFetch(`/api/templates/ads/${a.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category: '' }),
          }),
        ),
      );
    }
    if (openCategory === name) setOpenCategory(null);
    toast.success('Folder deleted');
  };

  const uploadFiles = async (files: FileList | File[] | null) => {
    if (!files || (files as FileList).length === 0) return;
    if (!openType || !openCategory) {
      toast.error('Open a category folder before uploading.');
      return;
    }
    const category = openCategory === UNFILED ? '' : openCategory;
    setUploading(true);
    let ok = 0;
    let ko = 0;
    let lastError = '';
    for (const file of Array.from(files as FileList | File[])) {
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('ad_type', openType);
        fd.append('category', category);
        fd.append('name', file.name.replace(/\.[^.]+$/, ''));
        const rr = await authFetch('/api/templates/ads/upload', { method: 'POST', body: fd });
        const rj = await rr.json().catch(() => ({}));
        if (!rr.ok) throw new Error(rj.error || `Upload failed (${rr.status})`);
        setRows((prev) => [rj as ArchiveAd, ...prev]);
        ok++;
      } catch (e) {
        ko++;
        lastError = e instanceof Error ? e.message : 'Upload failed';
        console.warn('[ads] upload failed:', e);
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
    if (ok > 0) toast.success(`${ok} ad${ok === 1 ? '' : 's'} uploaded`);
    if (ko > 0) toast.error(lastError || `${ko} file${ko === 1 ? '' : 's'} failed`);
  };

  const moveAd = async (ad: ArchiveAd, patch: { ad_type?: string; category?: string; tags?: string }) => {
    const next = { ...ad, ...patch };
    setRows((prev) => prev.map((x) => (x.id === ad.id ? next : x)));
    const res = await authFetch(`/api/templates/ads/${ad.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      toast.error('Update failed');
      void loadAds();
    }
  };

  const deleteAd = async (ad: ArchiveAd) => {
    const ok = await confirmDialog({
      title: 'Delete ad',
      message: `Do you want to delete "${ad.name}"? This action cannot be undone.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setRows((prev) => prev.filter((x) => x.id !== ad.id));
    if (preview?.id === ad.id) setPreview(null);
    const res = await authFetch(`/api/templates/ads/${ad.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Delete failed');
      void loadAds();
    } else {
      toast.success('Ad deleted');
    }
  };

  const matchingAds = useMemo(() => {
    if (!q && !tagFilter) return [] as ArchiveAd[];
    return items.filter((a) => {
      if (q && !adMatchesQuery(a, q)) return false;
      if (tagFilter) {
        const want = tagFilter.toLowerCase();
        if (!parseAdTags(a.tags).some((t) => t.toLowerCase() === want)) return false;
      }
      return true;
    });
  }, [items, q, tagFilter]);

  const typeColor = (type: string) => {
    const opt = typeFolderOptions.find((o) => o.value === type);
    return AD_TYPE_CATEGORIES.find((c) => c.value === opt?.category)?.color || 'bg-gray-100 text-gray-700';
  };

  const categoryOptionsFor = (type: string) => {
    const names = categoryFolders(type);
    return [{ value: '', label: 'Uncategorized' }, ...names.map((n) => ({ value: n, label: n }))];
  };

  return (
    <div className="space-y-5">
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={(e) => { void uploadFiles(e.target.files); }}
      />

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-500">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
          Loading ads…
        </div>
      ) : missingTable ? (
        <div className="bg-white rounded-xl border border-amber-200 p-8 text-center">
          <Megaphone className="w-10 h-10 text-amber-400 mx-auto mb-3" />
          <p className="text-gray-700 font-medium">Ads library is not installed yet</p>
          <p className="text-sm text-gray-500 mt-1">Run <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">supabase-migration-archive-ads.sql</code> on Supabase, then reload.</p>
        </div>
      ) : (q || tagFilter) ? (
        matchingAds.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <Search className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500">
              No ads match {q ? `“${search.trim()}”` : ''}{q && tagFilter ? ' and ' : ''}{tagFilter ? `tag #${tagFilter}` : ''}.
            </p>
            {tagFilter && (
              <button type="button" onClick={() => setTagFilter('')} className="mt-3 text-sm text-indigo-600 hover:underline">
                Clear tag
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {tagFilter && (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-indigo-100 text-indigo-800 text-xs font-semibold">
                  <Tag className="w-3 h-3" /> #{tagFilter}
                  <button type="button" onClick={() => setTagFilter('')} className="hover:text-indigo-950"><X className="w-3 h-3" /></button>
                </span>
                <span className="text-xs text-gray-400">{matchingAds.length} {matchingAds.length === 1 ? 'ad' : 'ads'}</span>
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {matchingAds.map((ad) => (
              <AdCard
                key={ad.id}
                ad={ad}
                typeOptions={typeFolderOptions}
                categoryOptions={categoryOptionsFor(ad.ad_type)}
                onPreview={() => setPreview(ad)}
                onMoveType={(t) => void moveAd(ad, { ad_type: t })}
                onMoveCategory={(c) => void moveAd(ad, { category: c })}
                onTags={(tags) => void moveAd(ad, { tags: formatAdTags(parseAdTags(tags)) })}
                onTagClick={setTagFilter}
                onDelete={() => void deleteAd(ad)}
              />
            ))}
            </div>
          </div>
        )
      ) : openType === null ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {typeFolderOptions.map((opt) => {
            const count = itemsInType(opt.value).length;
            return (
              <button
                key={opt.value}
                onClick={() => { setOpenType(opt.value); setOpenCategory(null); }}
                className="group bg-white rounded-2xl border border-gray-200 shadow-sm p-5 flex flex-col items-start gap-3 hover:border-indigo-300 hover:shadow-lg hover:-translate-y-0.5 transition-all text-left"
              >
                <div className="flex items-center justify-between w-full">
                  <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-fuchsia-100 to-violet-200 text-violet-600 group-hover:from-indigo-100 group-hover:to-indigo-200 group-hover:text-indigo-600 transition-colors">
                    <Megaphone className="w-5 h-5" />
                  </span>
                  <span className="text-3xl font-bold text-gray-800 tabular-nums">{count}</span>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${typeColor(opt.value)}`}>{opt.label}</span>
                <span className="text-[11px] text-gray-400">{count === 1 ? '1 ad' : `${count} ads`}</span>
              </button>
            );
          })}
          {addingType ? (
            <div className="bg-white rounded-2xl border border-dashed border-indigo-300 shadow-sm p-5 flex flex-col gap-3">
              <input
                autoFocus
                type="text"
                value={newTypeFolder}
                onChange={(e) => setNewTypeFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void addTypeFolder(); }
                  if (e.key === 'Escape') { setAddingType(false); setNewTypeFolder(''); }
                }}
                placeholder="E.g. Hook, Testimonial"
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
              />
              <div className="flex items-center gap-2">
                <button onClick={() => void addTypeFolder()} className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">Add type</button>
                <button onClick={() => { setAddingType(false); setNewTypeFolder(''); }} className="p-2 text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setAddingType(true)}
              className="group bg-white rounded-2xl border border-dashed border-gray-300 shadow-sm p-5 flex flex-col items-start gap-3 hover:border-indigo-400 hover:shadow-lg hover:-translate-y-0.5 transition-all text-left"
            >
              <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-gray-50 text-gray-400 group-hover:bg-indigo-50 group-hover:text-indigo-600 transition-colors">
                <Plus className="w-5 h-5" />
              </span>
              <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">New type</span>
              <span className="text-[11px] text-gray-400">Add a type (e.g. Hook)</span>
            </button>
          )}
        </div>
      ) : openCategory === null ? (
        (() => {
          const opt = typeFolderOptions.find((o) => o.value === openType);
          const folders = categoryFolders(openType);
          const unfiled = adsInFolder(openType, UNFILED).length;
          return (
            <div className="space-y-4">
              <div className="flex items-center gap-3 flex-wrap">
                <button onClick={() => { setOpenType(null); setOpenCategory(null); }} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
                  <ChevronRight className="w-4 h-4 rotate-180" /> Types
                </button>
                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${typeColor(openType)}`}>{opt?.label || openType}</span>
                <span className="text-sm text-gray-400">{itemsInType(openType).length} ads</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {folders.map((name) => {
                  const count = adsInFolder(openType, name).length;
                  return (
                    <div key={name} className="relative group">
                      <button
                        onClick={() => setOpenCategory(name)}
                        className="w-full bg-white rounded-2xl border border-gray-200 shadow-sm p-5 flex flex-col items-start gap-3 hover:border-indigo-300 hover:shadow-lg hover:-translate-y-0.5 transition-all text-left"
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-amber-100 to-amber-200 text-amber-600">
                            <FolderOpen className="w-5 h-5" />
                          </span>
                          <span className="text-3xl font-bold text-gray-800 tabular-nums">{count}</span>
                        </div>
                        <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-800">{name}</span>
                        <span className="text-[11px] text-gray-400">{count === 1 ? '1 ad' : `${count} ads`}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteCategoryFolder(openType, name)}
                        className="absolute top-3 right-3 p-1 rounded-md text-gray-300 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Delete folder"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
                {unfiled > 0 && (
                  <button
                    onClick={() => setOpenCategory(UNFILED)}
                    className="bg-white rounded-2xl border border-dashed border-gray-300 shadow-sm p-5 flex flex-col items-start gap-3 hover:border-indigo-300 hover:shadow-lg hover:-translate-y-0.5 transition-all text-left"
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-gray-100 text-gray-500">
                        <FolderOpen className="w-5 h-5" />
                      </span>
                      <span className="text-3xl font-bold text-gray-800 tabular-nums">{unfiled}</span>
                    </div>
                    <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">Uncategorized</span>
                    <span className="text-[11px] text-gray-400">{unfiled === 1 ? '1 ad' : `${unfiled} ads`}</span>
                  </button>
                )}
                {addingCategory ? (
                  <div className="bg-white rounded-2xl border border-dashed border-indigo-300 shadow-sm p-5 flex flex-col gap-3">
                    <input
                      autoFocus
                      type="text"
                      value={newCategory}
                      onChange={(e) => setNewCategory(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); void addCategoryFolder(); }
                        if (e.key === 'Escape') { setAddingCategory(false); setNewCategory(''); }
                      }}
                      placeholder="E.g. Survival, Weight loss…"
                      className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    />
                    <div className="flex items-center gap-2">
                      <button onClick={() => void addCategoryFolder()} className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">Add folder</button>
                      <button onClick={() => { setAddingCategory(false); setNewCategory(''); }} className="p-2 text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setAddingCategory(true)}
                    className="group bg-white rounded-2xl border border-dashed border-gray-300 shadow-sm p-5 flex flex-col items-start gap-3 hover:border-indigo-400 hover:shadow-lg hover:-translate-y-0.5 transition-all text-left"
                  >
                    <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-gray-50 text-gray-400 group-hover:bg-indigo-50 group-hover:text-indigo-600 transition-colors">
                      <Plus className="w-5 h-5" />
                    </span>
                    <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">New folder</span>
                    <span className="text-[11px] text-gray-400">Divide this type by category</span>
                  </button>
                )}
              </div>
            </div>
          );
        })()
      ) : (() => {
        const opt = typeFolderOptions.find((o) => o.value === openType);
        const folderAds = adsInFolder(openType, openCategory);
        const folderLabel = openCategory === UNFILED ? 'Uncategorized' : openCategory;
        return (
          <div
            className="space-y-4"
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
            onDrop={(e) => {
              e.preventDefault();
              void uploadFiles(e.dataTransfer.files);
            }}
          >
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={() => { setOpenType(null); setOpenCategory(null); }} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
                <ChevronRight className="w-4 h-4 rotate-180" /> Types
              </button>
              <button onClick={() => setOpenCategory(null)} className={`px-2.5 py-1 rounded-full text-xs font-semibold ${typeColor(openType)} hover:ring-1 hover:ring-indigo-300`}>
                {opt?.label || openType}
              </button>
              <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
              <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-800">{folderLabel}</span>
              <span className="text-sm text-gray-400">{folderAds.length} {folderAds.length === 1 ? 'ad' : 'ads'}</span>
              <div className="ml-auto">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50"
                >
                  {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  {uploading ? 'Uploading…' : 'Upload'}
                </button>
              </div>
            </div>

            {folderAds.length === 0 ? (
              <div className="bg-white rounded-xl border border-dashed border-gray-200 p-12 text-center">
                <FolderOpen className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500">No ads in this folder.</p>
                <p className="text-xs text-gray-400 mt-1">Drop images or videos here, or upload.</p>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Upload className="w-4 h-4" /> Upload ads
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {folderAds.map((ad) => (
                  <AdCard
                    key={ad.id}
                    ad={ad}
                    typeOptions={typeFolderOptions}
                    categoryOptions={categoryOptionsFor(openType)}
                    onPreview={() => setPreview(ad)}
                    onMoveType={(t) => void moveAd(ad, { ad_type: t })}
                    onMoveCategory={(c) => void moveAd(ad, { category: c })}
                    onTags={(tags) => void moveAd(ad, { tags: formatAdTags(parseAdTags(tags)) })}
                    onTagClick={setTagFilter}
                    onDelete={() => void deleteAd(ad)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {preview && preview.media_type !== 'folder' && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <div className="w-full max-w-6xl max-h-[92vh] bg-gray-950 rounded-2xl overflow-hidden shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
              <div>
                <h3 className="text-white font-semibold">{recreated?.name || preview.name}</h3>
                <p className="text-xs text-gray-400">
                  {recreated
                    ? 'Preview — not in this Ads folder until you save it to a project'
                    : `${humanizeAdTypeSlug(preview.ad_type)}${preview.category ? ` · ${preview.category}` : ''}`}
                </p>
              </div>
              <button onClick={() => setPreview(null)} className="p-1 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col lg:flex-row">
              <div className="bg-black flex items-center justify-center lg:flex-1 min-h-[40vh] min-w-0 p-3">
                {preview.media_type === 'video' ? (
                  <video src={getUploadUrl(preview.file_path)} controls autoPlay className="max-h-[70vh] w-full" />
                ) : recreated ? (
                  <div className="flex flex-col items-center gap-3 w-full">
                    <p className="text-[11px] uppercase tracking-wide text-violet-300">Recreated</p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      key={recreated.previewUrl || recreated.filePath}
                      src={recreated.previewUrl || getUploadUrl(recreated.filePath)}
                      alt={recreated.name}
                      className="max-h-[62vh] w-full object-contain rounded-lg bg-black ring-1 ring-violet-400/40"
                    />
                    <details className="w-full max-w-xs">
                      <summary className="text-[11px] text-gray-400 cursor-pointer text-center">Show original</summary>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={getUploadUrl(preview.file_path)} alt={preview.name} className="mt-2 max-h-40 w-full object-contain rounded-md opacity-80" />
                    </details>
                  </div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={getUploadUrl(preview.file_path)} alt={preview.name} className="max-h-[70vh] w-full object-contain" />
                )}
              </div>
              {preview.media_type !== 'video' && (
                <AdsRecreatePanel
                  ad={preview}
                  onResult={setRecreated}
                />
              )}
            </div>
            <div className="px-4 py-3 flex items-center justify-end gap-2 border-t border-white/10">
              <button
                onClick={() => void deleteAd(preview)}
                className="px-3 py-1.5 text-sm text-red-400 hover:text-red-300"
              >
                Delete
              </button>
              <a
                href={
                  recreated?.filePath
                    ? downloadHref(recreated.filePath)
                    : (recreated?.previewUrl || downloadHref(preview.file_path))
                }
                className="px-3 py-1.5 bg-white text-gray-900 rounded-lg text-sm font-medium"
              >
                Download
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AdCard({
  ad,
  typeOptions,
  categoryOptions,
  onPreview,
  onMoveType,
  onMoveCategory,
  onTags,
  onTagClick,
  onDelete,
}: {
  ad: ArchiveAd;
  typeOptions: AdTypeOption[];
  categoryOptions: { value: string; label: string }[];
  onPreview: () => void;
  onMoveType: (adType: string) => void;
  onMoveCategory: (category: string) => void;
  onTags: (tags: string) => void;
  onTagClick: (tag: string) => void;
  onDelete: () => void;
}) {
  const src = getUploadUrl(ad.file_path);
  const chips = parseAdTags(ad.tags);
  const [tagDraft, setTagDraft] = useState(ad.tags);
  useEffect(() => { setTagDraft(ad.tags); }, [ad.tags]);
  return (
    <div className="group bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden hover:border-indigo-300 hover:shadow-md transition-all">
      <button type="button" onClick={onPreview} className="relative block w-full aspect-[4/5] bg-gray-100">
        {ad.media_type === 'video' ? (
          <>
            <video src={src} muted playsInline className="w-full h-full object-cover" />
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="w-10 h-10 rounded-full bg-black/55 text-white flex items-center justify-center">
                <Play className="w-4 h-4 ml-0.5" />
              </span>
            </span>
          </>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={ad.name} className="w-full h-full object-cover" />
        )}
      </button>
      <div className="p-2.5 space-y-1.5">
        <p className="text-sm font-medium text-gray-900 truncate" title={ad.name}>{ad.name}</p>
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {chips.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => onTagClick(tag)}
                className="px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-[10px] font-medium hover:bg-indigo-100"
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
        <input
          value={tagDraft}
          onChange={(e) => setTagDraft(e.target.value)}
          onBlur={() => {
            const next = formatAdTags(parseAdTags(tagDraft));
            setTagDraft(next);
            if (next !== formatAdTags(parseAdTags(ad.tags))) onTags(next);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="Tags: hook, ugc…"
          className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-[11px] bg-white text-gray-700 focus:ring-2 focus:ring-indigo-500 outline-none"
        />
        <select
          value={ad.ad_type}
          onChange={(e) => onMoveType(e.target.value)}
          className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white text-gray-700 focus:ring-2 focus:ring-indigo-500 outline-none"
          title="Move to another type"
        >
          {typeOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <select
          value={ad.category || ''}
          onChange={(e) => onMoveCategory(e.target.value)}
          className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white text-gray-700 focus:ring-2 focus:ring-indigo-500 outline-none"
          title="Move to another category folder"
        >
          {categoryOptions.map((opt) => (
            <option key={opt.value || '__none'} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={onDelete}
          className="w-full flex items-center justify-center gap-1 py-1 text-xs text-red-500 hover:text-red-700 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Trash2 className="w-3 h-3" /> Delete
        </button>
      </div>
    </div>
  );
}
