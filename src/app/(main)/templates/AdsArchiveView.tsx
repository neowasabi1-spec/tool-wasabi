'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight, FolderOpen, Loader2, Megaphone, Play, Plus, Search,
  Tag, Trash2, Upload, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { authFetch } from '@/lib/auth/client-fetch';
import { confirmDialog } from '@/components/ui/confirm';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { getUploadUrl } from '@/lib/projecthub-storage';
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

type Props = {
  search: string;
  onFolderCount?: (count: number) => void;
};

export default function AdsArchiveView({ search, onFolderCount }: Props) {
  const [ads, setAds] = useState<ArchiveAd[]>([]);
  const [customTypes, setCustomTypes] = useState<AdTypeOption[]>([]);
  const [archiveCategories, setArchiveCategories] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [addingType, setAddingType] = useState(false);
  const [newTypeFolder, setNewTypeFolder] = useState('');
  const [openType, setOpenType] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [missingTable, setMissingTable] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<ArchiveAd | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadAds = useCallback(async () => {
    try {
      const res = await authFetch('/api/templates/ads');
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not load ads');
      setMissingTable(Boolean(d.missingTable));
      setAds(Array.isArray(d.ads) ? d.ads : []);
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

  const loadCategories = useCallback(async () => {
    try {
      const res = await authFetch('/api/extension/categories');
      if (res.ok) {
        const d = await res.json();
        setArchiveCategories(Array.isArray(d.categories) ? d.categories : []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void loadAds();
    void loadTypes();
    void loadCategories();
  }, [loadAds, loadTypes, loadCategories]);

  const typeFolderOptions: AdTypeOption[] = useMemo(() => {
    const seen = new Set(BUILT_IN_AD_TYPE_OPTIONS.map((o) => o.value));
    const extras: AdTypeOption[] = [...customTypes.filter((t) => {
      if (seen.has(t.value)) return false;
      seen.add(t.value);
      return true;
    })];
    for (const ad of ads) {
      const t = String(ad.ad_type || '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      extras.push({ value: t, label: humanizeAdTypeSlug(t), category: 'custom' });
    }
    return [...BUILT_IN_AD_TYPE_OPTIONS, ...extras];
  }, [ads, customTypes]);

  const q = search.trim().toLowerCase();
  const adsByType = useMemo(() => {
    const map: Record<string, ArchiveAd[]> = {};
    for (const ad of ads) {
      if (q && !ad.name.toLowerCase().includes(q) && !ad.tags.toLowerCase().includes(q)) continue;
      const t = ad.ad_type || 'image';
      (map[t] ||= []).push(ad);
    }
    return map;
  }, [ads, q]);

  useEffect(() => {
    const n = new Set(ads.map((a) => a.ad_type).filter(Boolean)).size;
    onFolderCount?.(n);
  }, [ads, onFolderCount]);

  const addCategory = async () => {
    const name = newCategory.trim();
    if (!name) return;
    try {
      const res = await authFetch('/api/extension/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        const d = await res.json();
        setArchiveCategories(Array.isArray(d.categories) ? d.categories : []);
        setSelectedCategory(name);
      }
    } catch { /* ignore */ }
    setNewCategory('');
    setAddingCategory(false);
  };

  const deleteCategory = async (name: string) => {
    try {
      const res = await authFetch(`/api/extension/categories?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (res.ok) {
        const d = await res.json();
        setArchiveCategories(Array.isArray(d.categories) ? d.categories : []);
        if (selectedCategory === name) setSelectedCategory('');
      }
    } catch { /* ignore */ }
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

  const uploadFiles = async (files: FileList | File[] | null, adType: string) => {
    if (!files || (files as FileList).length === 0) return;
    const sb = getSupabaseBrowser();
    if (!sb) { toast.error('Storage unavailable'); return; }
    setUploading(true);
    let ok = 0;
    let ko = 0;
    for (const file of Array.from(files as FileList | File[])) {
      try {
        if (!/^(image|video)\//i.test(file.type)) {
          ko++;
          continue;
        }
        const sr = await authFetch('/api/templates/ads/sign-upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, contentType: file.type || 'application/octet-stream' }),
        });
        const sj = await sr.json().catch(() => ({}));
        if (!sr.ok || !sj.path || !sj.token) throw new Error(sj.error || 'sign failed');
        const up = await sb.storage.from('project-files').uploadToSignedUrl(sj.path, sj.token, file);
        if (up.error) throw new Error(up.error.message);
        const rr = await authFetch('/api/templates/ads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: file.name.replace(/\.[^.]+$/, ''),
            file_path: sj.path,
            media_type: sj.media_type,
            ad_type: adType,
            category: selectedCategory || '',
          }),
        });
        const rj = await rr.json().catch(() => ({}));
        if (!rr.ok) throw new Error(rj.error || 'register failed');
        setAds((prev) => [rj as ArchiveAd, ...prev]);
        ok++;
      } catch (e) {
        ko++;
        console.warn('[ads] upload failed:', e);
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
    if (ok > 0) toast.success(`${ok} ad${ok === 1 ? '' : 's'} uploaded`);
    if (ko > 0) toast.error(`${ko} file${ko === 1 ? '' : 's'} failed`);
  };

  const moveAd = async (ad: ArchiveAd, adType: string) => {
    if (adType === ad.ad_type) return;
    setAds((prev) => prev.map((x) => (x.id === ad.id ? { ...x, ad_type: adType } : x)));
    const res = await authFetch(`/api/templates/ads/${ad.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ad_type: adType }),
    });
    if (!res.ok) {
      toast.error('Move failed');
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
    setAds((prev) => prev.filter((x) => x.id !== ad.id));
    if (preview?.id === ad.id) setPreview(null);
    const res = await authFetch(`/api/templates/ads/${ad.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Delete failed');
      void loadAds();
    } else {
      toast.success('Ad deleted');
    }
  };

  const filteredIn = (type: string) => {
    const all = adsByType[type] || [];
    return selectedCategory ? all.filter((a) => (a.category || '') === selectedCategory) : all;
  };

  return (
    <div className="space-y-5">
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (openType) void uploadFiles(e.target.files, openType);
        }}
      />

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Tag className="w-4 h-4 text-indigo-500" />
          <span className="text-sm font-semibold text-gray-700">Category</span>
        </div>
        <select
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none min-w-[200px]"
        >
          <option value="">All categories</option>
          {archiveCategories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        {addingCategory ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              type="text"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void addCategory(); }
                if (e.key === 'Escape') { setAddingCategory(false); setNewCategory(''); }
              }}
              placeholder="E.g. Survival, Weight loss…"
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
            />
            <button onClick={() => void addCategory()} className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">Add</button>
            <button onClick={() => { setAddingCategory(false); setNewCategory(''); }} className="p-2 text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
          </div>
        ) : (
          <button
            onClick={() => setAddingCategory(true)}
            className="flex items-center gap-1.5 px-3 py-2 border border-dashed border-gray-300 text-gray-600 rounded-lg text-sm hover:border-indigo-400 hover:text-indigo-600 transition-colors"
          >
            <Plus className="w-4 h-4" /> New category
          </button>
        )}

        {selectedCategory && (
          <button
            onClick={() => void deleteCategory(selectedCategory)}
            className="ml-auto flex items-center gap-1 text-xs text-red-500 hover:text-red-700"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete &ldquo;{selectedCategory}&rdquo;
          </button>
        )}
      </div>

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
      ) : q ? (
        (() => {
          const groups = typeFolderOptions
            .map((opt) => ({ opt, ads: filteredIn(opt.value) }))
            .filter((g) => g.ads.length > 0);
          if (groups.length === 0) {
            return (
              <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                <Search className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500">No ads match “{search.trim()}”.</p>
              </div>
            );
          }
          return (
            <div className="space-y-8">
              {groups.map(({ opt, ads: folderAds }) => (
                <section key={opt.value} className="space-y-3">
                  <div className="flex items-center gap-3">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${AD_TYPE_CATEGORIES.find((c) => c.value === opt.category)?.color || 'bg-gray-100 text-gray-700'}`}>
                      {opt.label}
                    </span>
                    <span className="text-sm text-gray-400">{folderAds.length}</span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                    {folderAds.map((ad) => (
                      <AdCard
                        key={ad.id}
                        ad={ad}
                        typeOptions={typeFolderOptions}
                        onPreview={() => setPreview(ad)}
                        onMove={(t) => void moveAd(ad, t)}
                        onDelete={() => void deleteAd(ad)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          );
        })()
      ) : openType === null ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {typeFolderOptions.map((opt) => {
            const count = filteredIn(opt.value).length;
            const colorClass = AD_TYPE_CATEGORIES.find((c) => c.value === opt.category)?.color || 'bg-gray-100 text-gray-700';
            return (
              <button
                key={opt.value}
                onClick={() => setOpenType(opt.value)}
                className="group bg-white rounded-2xl border border-gray-200 shadow-sm p-5 flex flex-col items-start gap-3 hover:border-indigo-300 hover:shadow-lg hover:-translate-y-0.5 transition-all text-left"
              >
                <div className="flex items-center justify-between w-full">
                  <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-fuchsia-100 to-violet-200 text-violet-600 group-hover:from-indigo-100 group-hover:to-indigo-200 group-hover:text-indigo-600 transition-colors">
                    <Megaphone className="w-5 h-5" />
                  </span>
                  <span className="text-3xl font-bold text-gray-800 tabular-nums">{count}</span>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${colorClass}`}>{opt.label}</span>
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
                <button onClick={() => void addTypeFolder()} className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">Add folder</button>
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
              <span className="text-[11px] text-gray-400">Add a folder (e.g. Hook)</span>
            </button>
          )}
        </div>
      ) : (() => {
        const opt = typeFolderOptions.find((o) => o.value === openType);
        const folderAds = filteredIn(openType);
        const colorClass = AD_TYPE_CATEGORIES.find((c) => c.value === opt?.category)?.color || 'bg-gray-100 text-gray-700';
        return (
          <div
            className="space-y-4"
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
            onDrop={(e) => {
              e.preventDefault();
              void uploadFiles(e.dataTransfer.files, openType);
            }}
          >
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={() => setOpenType(null)} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
                <ChevronRight className="w-4 h-4 rotate-180" /> Folders
              </button>
              <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${colorClass}`}>{opt?.label || openType}</span>
              <span className="text-sm text-gray-400">{folderAds.length} {folderAds.length === 1 ? 'ad' : 'ads'}</span>
              {selectedCategory && <span className="text-xs text-indigo-500">· {selectedCategory}</span>}
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
                <p className="text-gray-500">No ads in this folder{selectedCategory ? ` for "${selectedCategory}"` : ''}.</p>
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
                    onPreview={() => setPreview(ad)}
                    onMove={(t) => void moveAd(ad, t)}
                    onDelete={() => void deleteAd(ad)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {preview && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <div className="w-full max-w-3xl bg-gray-950 rounded-2xl overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
              <div>
                <h3 className="text-white font-semibold">{preview.name}</h3>
                <p className="text-xs text-gray-400">{humanizeAdTypeSlug(preview.ad_type)}{preview.category ? ` · ${preview.category}` : ''}</p>
              </div>
              <button onClick={() => setPreview(null)} className="p-1 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="bg-black flex items-center justify-center max-h-[70vh]">
              {preview.media_type === 'video' ? (
                <video src={getUploadUrl(preview.file_path)} controls autoPlay className="max-h-[70vh] w-full" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={getUploadUrl(preview.file_path)} alt={preview.name} className="max-h-[70vh] w-full object-contain" />
              )}
            </div>
            <div className="px-4 py-3 flex items-center justify-end gap-2">
              <button
                onClick={() => void deleteAd(preview)}
                className="px-3 py-1.5 text-sm text-red-400 hover:text-red-300"
              >
                Delete
              </button>
              <a
                href={getUploadUrl(preview.file_path) + (getUploadUrl(preview.file_path).includes('?') ? '&' : '?') + 'download=1'}
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
  onPreview,
  onMove,
  onDelete,
}: {
  ad: ArchiveAd;
  typeOptions: AdTypeOption[];
  onPreview: () => void;
  onMove: (adType: string) => void;
  onDelete: () => void;
}) {
  const src = getUploadUrl(ad.file_path);
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
        <select
          value={ad.ad_type}
          onChange={(e) => onMove(e.target.value)}
          className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white text-gray-700 focus:ring-2 focus:ring-indigo-500 outline-none"
          title="Move to another folder"
        >
          {typeOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
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
