'use client';

import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { authFetch } from '@/lib/auth/client-fetch';

type RecreatedAd = {
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

type ProjectPick = { id: string; name: string; brief?: string | null; description?: string | null };
type ProductPick = { id: string; name: string; brand_name?: string | null; image_url?: string | null };

type Props = {
  ad: RecreatedAd;
  onCreated: (ad: RecreatedAd, analysis: string) => void;
};

export default function AdsRecreatePanel({ ad, onCreated }: Props) {
  const photoRef = useRef<HTMLInputElement>(null);
  const [projects, setProjects] = useState<ProjectPick[]>([]);
  const [products, setProducts] = useState<ProductPick[]>([]);
  const [projectId, setProjectId] = useState('');
  const [productId, setProductId] = useState('');
  const [productName, setProductName] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [analysis, setAnalysis] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pr, pd] = await Promise.all([
          authFetch('/api/projects/list'),
          authFetch(`/api/templates/ads/${ad.id}/recreate`),
        ]);
        const pj = await pr.json().catch(() => ({}));
        const dj = await pd.json().catch(() => ({}));
        if (cancelled) return;
        if (Array.isArray(pj.projects)) setProjects(pj.projects);
        if (Array.isArray(dj.products)) setProducts(dj.products);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
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
      onCreated(d.ad as RecreatedAd, String(d.analysis || ''));
      toast.success('Ad recreated and saved in this folder');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Recreate failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4 bg-gray-900/80 border-t border-white/10 lg:border-t-0 lg:border-l lg:w-[340px] lg:shrink-0">
      <div>
        <p className="text-sm font-semibold text-white flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-300" /> Recreate for your product
        </p>
        <p className="text-xs text-gray-400 mt-1">
          AI reads this layout, then rebuilds the ad around your project or packshot. Structure stays, copy and branding are new.
        </p>
      </div>

      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-gray-500">Project</span>
        <select
          value={projectId}
          onChange={(e) => onPickProject(e.target.value)}
          disabled={busy}
          className="mt-1 w-full px-2.5 py-2 rounded-lg bg-gray-800 border border-white/10 text-sm text-white outline-none focus:ring-2 focus:ring-violet-500"
        >
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
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
          This can take up to a minute. The result is saved next to the original.
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
