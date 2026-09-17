'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, FolderKanban, ImagePlus, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { authFetch } from '@/lib/auth/client-fetch';
import { getUploadUrl } from '@/lib/projecthub-storage';
import { supabase } from '@/lib/supabase';

type RecreatedAd = {
  id: string;
  name: string;
  file_path: string;
};

export type RecreatePreview = {
  filePath: string;
  name: string;
  previewUrl: string;
};

type ProjectPick = { id: string; name: string; brief?: string | null; description?: string | null };
type ProductPick = { id: string; name: string; brand_name?: string | null; image_url?: string | null };

type Props = {
  ad: RecreatedAd;
  onResult: (result: RecreatePreview | null) => void;
};

function asProjectRows(raw: unknown): ProjectPick[] {
  const list = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { projects?: unknown }).projects)
      ? (raw as { projects: unknown[] }).projects
      : []);
  const out: ProjectPick[] = [];
  const seen = new Set<string>();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const p = row as Record<string, unknown>;
    const id = String(p.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof p.name === 'string' && p.name.trim() ? p.name : 'Untitled',
      brief: typeof p.brief === 'string' ? p.brief : null,
      description: typeof p.description === 'string' ? p.description : null,
    });
  }
  return out;
}

function parseProjects(hub: unknown, list: unknown, db: unknown): ProjectPick[] {
  const merged = [...asProjectRows(hub), ...asProjectRows(list), ...asProjectRows(db)];
  const seen = new Set<string>();
  return merged.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

export default function AdsRecreatePanel({ ad, onResult }: Props) {
  const photoRef = useRef<HTMLInputElement>(null);
  const [projects, setProjects] = useState<ProjectPick[]>([]);
  const [products, setProducts] = useState<ProductPick[]>([]);
  const [projectId, setProjectId] = useState('');
  const [productId, setProductId] = useState('');
  const [productName, setProductName] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [analysis, setAnalysis] = useState('');
  const [result, setResult] = useState<RecreatePreview | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingProjects(true);
      try {
        const [hub, list, db, catalog] = await Promise.all([
          authFetch('/api/projecthub/projects').then((r) => r.json()).catch(() => null),
          authFetch('/api/projects/list').then((r) => r.json()).catch(() => null),
          supabase.from('projects').select('id, name, description, brief').order('created_at', { ascending: false }),
          authFetch(`/api/templates/ads/${ad.id}/recreate`).then((r) => r.json()).catch(() => ({})),
        ]);
        if (cancelled) return;
        const mapped = parseProjects(hub, list, db.data);
        setProjects(mapped);
        if (Array.isArray(catalog?.products)) setProducts(catalog.products);
      } catch {
        if (!cancelled) setProjects([]);
      } finally {
        if (!cancelled) setLoadingProjects(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ad.id]);

  useEffect(() => {
    setResult(null);
    setSaved(false);
    setAnalysis('');
  }, [ad.id]);

  useEffect(() => {
    if (!photo) {
      setPhotoPreview('');
      return;
    }
    const url = URL.createObjectURL(photo);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const onPickProject = (id: string) => {
    setProjectId(id);
    const proj = projects.find((p) => p.id === id);
    if (proj && !productName.trim()) setProductName(proj.name);
  };

  const onPickProduct = (id: string) => {
    setProductId(id);
    const prod = products.find((p) => p.id === id);
    if (prod && !productName.trim()) setProductName(prod.name);
  };

  const canRun = Boolean(projectId || productId || photo || productName.trim());

  const recreate = async () => {
    if (!canRun) {
      toast.error('Pick a project, a product, or upload a packshot.');
      return;
    }
    setBusy(true);
    setAnalysis('');
    setSaved(false);
    setResult(null);
    onResult(null);
    try {
      const fd = new FormData();
      if (projectId) fd.append('projectId', projectId);
      if (productId) fd.append('productId', productId);
      if (productName.trim()) fd.append('productName', productName.trim());
      if (photo) fd.append('file', photo);
      const res = await authFetch(`/api/templates/ads/${ad.id}/recreate`, {
        method: 'POST',
        body: fd,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Recreate failed');
      if (d.analysis) setAnalysis(String(d.analysis));
      const previewUrl = String(d.previewDataUrl || d.previewUrl || '').trim()
        || (d.filePath || d.file_path ? getUploadUrl(String(d.filePath || d.file_path)) : '');
      const preview: RecreatePreview = {
        filePath: String(d.filePath || d.file_path || ''),
        name: String(d.name || productName || 'Recreated ad'),
        previewUrl,
      };
      if (!preview.filePath && !preview.previewUrl) throw new Error('Generation returned no image');
      setResult(preview);
      onResult(preview);
      toast.success('Preview ready — save to the project or download');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Recreate failed');
    } finally {
      setBusy(false);
    }
  };

  const saveToProject = async () => {
    if (!result) return;
    if (!projectId) {
      toast.error('Pick a project to save into Creative');
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch(`/api/templates/ads/${ad.id}/recreate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          projectId,
          filePath: result.filePath,
          name: result.name,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not save to Creative');
      setSaved(true);
      toast.success('Saved in the project Creative section');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save to Creative');
    } finally {
      setSaving(false);
    }
  };

  const downloadHref = result
    ? getUploadUrl(result.filePath) + (getUploadUrl(result.filePath).includes('?') ? '&' : '?') + 'download=1'
    : '';

  return (
    <div className="flex flex-col gap-3 p-4 bg-gray-900/80 border-t border-white/10 lg:border-t-0 lg:border-l lg:w-[340px] lg:shrink-0">
      <div>
        <p className="text-sm font-semibold text-white flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-300" /> Recreate for your product
        </p>
        <p className="text-xs text-gray-400 mt-1">
          AI reads this layout, then rebuilds the ad around your project or packshot. The result stays in this popup until you save it to the project Creative tab or download it.
        </p>
      </div>

      {result?.previewUrl && (
        <div className="rounded-lg border border-violet-400/30 bg-violet-500/10 p-2 space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={result.previewUrl}
            alt={result.name}
            className="w-full max-h-64 object-contain rounded-md bg-black"
          />
          {saved && (
            <p className="text-[11px] text-emerald-300 px-1">Saved in Creative → Recreated ads</p>
          )}
          <button
            type="button"
            onClick={() => void saveToProject()}
            disabled={saving || busy || !projectId}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-white text-gray-900 text-sm font-medium hover:bg-gray-100 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderKanban className="w-4 h-4" />}
            {saved ? 'Saved to project' : 'Save to project Creative'}
          </button>
          <a
            href={downloadHref}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-white/20 text-white text-sm font-medium hover:bg-white/10"
          >
            <Download className="w-4 h-4" /> Download
          </a>
          {!projectId && (
            <p className="text-[11px] text-amber-300 px-1">Select a project above to save into Creative.</p>
          )}
        </div>
      )}

      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-gray-500">My Projects</span>
        <select
          value={projectId}
          onChange={(e) => onPickProject(e.target.value)}
          disabled={busy || loadingProjects}
          className="mt-1 w-full px-2.5 py-2 rounded-lg bg-gray-800 border border-white/10 text-sm text-white outline-none focus:ring-2 focus:ring-violet-500"
        >
          <option value="">
            {loadingProjects ? 'Loading projects…' : projects.length === 0 ? 'No projects yet' : 'Select a project'}
          </option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {!loadingProjects && projects.length === 0 && (
          <span className="mt-1 block text-[11px] text-amber-400">
            Could not load My Projects. Create one under My Projects, then reopen this ad.
          </span>
        )}
      </label>

      {products.length > 0 && (
        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-gray-500">Catalog product</span>
          <select
            value={productId}
            onChange={(e) => onPickProduct(e.target.value)}
            disabled={busy}
            className="mt-1 w-full px-2.5 py-2 rounded-lg bg-gray-800 border border-white/10 text-sm text-white outline-none focus:ring-2 focus:ring-violet-500"
          >
            <option value="">No catalog product</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.brand_name ? `${p.brand_name} — ${p.name}` : p.name}</option>
            ))}
          </select>
        </label>
      )}

      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-gray-500">Product name</span>
        <input
          type="text"
          value={productName}
          onChange={(e) => setProductName(e.target.value)}
          disabled={busy}
          placeholder="Optional — filled from the project"
          className="mt-1 w-full px-2.5 py-2 rounded-lg bg-gray-800 border border-white/10 text-sm text-white outline-none focus:ring-2 focus:ring-violet-500 placeholder:text-gray-500"
        />
      </label>

      <input
        ref={photoRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => setPhoto(e.target.files?.[0] || null)}
      />
      <button
        type="button"
        onClick={() => photoRef.current?.click()}
        disabled={busy}
        className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg border border-dashed border-white/20 text-left hover:border-violet-400/60 hover:bg-white/5 transition-colors disabled:opacity-50"
      >
        {photoPreview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoPreview} alt="" className="w-12 h-12 rounded-md object-cover bg-black" />
        ) : (
          <span className="w-12 h-12 rounded-md bg-white/5 text-gray-400 flex items-center justify-center">
            <ImagePlus className="w-5 h-5" />
          </span>
        )}
        <span className="min-w-0">
          <span className="block text-sm text-white">Upload product photo</span>
          <span className="block text-xs text-gray-400 truncate">
            {photo ? photo.name : 'Packshot used in the new ad'}
          </span>
        </span>
      </button>
      {photo && (
        <button
          type="button"
          onClick={() => setPhoto(null)}
          disabled={busy}
          className="text-xs text-gray-400 hover:text-white self-start"
        >
          Remove photo
        </button>
      )}

      <button
        type="button"
        onClick={() => void recreate()}
        disabled={busy || !canRun}
        className="mt-1 inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-500 disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        {busy ? 'Analyzing & recreating…' : 'Recreate ad'}
      </button>

      {busy && (
        <p className="text-[11px] text-gray-400">
          This can take up to a minute. The new ad stays in this popup — it is not added to this Ads folder.
        </p>
      )}

      {analysis && (
        <details className="rounded-lg bg-black/40 border border-white/10 px-3 py-2">
          <summary className="text-xs text-gray-300 cursor-pointer">Layout analysis</summary>
          <pre className="mt-2 text-[10px] text-gray-400 whitespace-pre-wrap break-words max-h-40 overflow-auto">{analysis}</pre>
        </details>
      )}
    </div>
  );
}
