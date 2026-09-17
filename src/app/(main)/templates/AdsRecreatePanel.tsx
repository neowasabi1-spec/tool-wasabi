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

function absStreamUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${window.location.origin}/api/projecthub/file-proxy?path=${encodeURIComponent(path)}&stream=1`;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const raw = await res.text();
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const timeout = res.status === 504 || res.status === 408 || /timeout/i.test(raw);
    throw new Error(timeout
      ? `Server timed out (${res.status})`
      : `Unexpected response (HTTP ${res.status})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jobFrom(data: Record<string, unknown>, fallback?: Record<string, unknown>) {
  return {
    requestId: String(data.requestId || fallback?.requestId || 'job'),
    statusUrl: String(data.statusUrl || fallback?.statusUrl || ''),
    responseUrl: String(data.responseUrl || fallback?.responseUrl || ''),
    modelKey: String(data.modelKey || fallback?.modelKey || 'gpt-image-2-edit'),
  };
}

async function pollChatGptJob(opts: {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
  modelKey: string;
  onWait: (msg: string) => void;
}): Promise<string> {
  let data: Record<string, unknown> = {
    status: 'pending',
    requestId: opts.requestId,
    statusUrl: opts.statusUrl,
    responseUrl: opts.responseUrl,
    modelKey: opts.modelKey,
  };
  const started = Date.now();
  const deadline = started + 5 * 60_000;
  let misses = 0;
  while (String(data.status || '') === 'pending') {
    if (Date.now() > deadline) throw new Error('ChatGPT Image 2 timed out — keep the popup open and try again');
    const elapsed = Math.round((Date.now() - started) / 1000);
    opts.onWait(
      String(data.falStatus || '') === 'IN_PROGRESS'
        ? `ChatGPT Image 2 is generating… ${elapsed}s`
        : `Waiting for ChatGPT Image 2… checking every 5s (${elapsed}s)`,
    );
    await sleep(5_000);
    try {
      const pollRes = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'poll',
          ...jobFrom(data, opts),
        }),
      });
      const next = await readJson(pollRes);
      if (next.status === 'error') {
        const msg = String(next.error || 'ChatGPT Image 2 failed');
        const transient = pollRes.status === 504 || pollRes.status === 408 || /timeout|ETIMEDOUT|network/i.test(msg);
        if (!transient) throw new Error(msg);
        misses += 1;
        if (misses >= 4) throw new Error(msg);
        continue;
      }
      if (!pollRes.ok) {
        misses += 1;
        if (misses >= 4) throw new Error(`Unexpected response (HTTP ${pollRes.status})`);
        continue;
      }
      misses = 0;
      data = { ...data, ...next };
    } catch (e) {
      misses += 1;
      if (misses >= 4) throw e;
    }
  }
  const url = String(data.url || '').trim();
  if (String(data.status || '') !== 'completed' || !url) {
    throw new Error(String(data.error || 'ChatGPT Image 2 did not return an image'));
  }
  return url;
}

async function submitAndPollChatGpt(opts: {
  prompt: string;
  imageUrl: string;
  secondaryImageUrl?: string;
  onWait: (msg: string) => void;
}): Promise<string> {
  opts.onWait('Sending to ChatGPT Image 2…');
  const submitRes = await fetch('/api/generate-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'image2image',
      model: 'gpt-image-2-edit',
      prompt: opts.prompt,
      size: '1024x1536',
      style: 'natural',
      imageUrl: opts.imageUrl,
      secondaryImageUrl: opts.secondaryImageUrl || undefined,
    }),
  });
  const submit = await readJson(submitRes);
  if (!submitRes.ok || submit.status === 'error' || !submit.statusUrl) {
    throw new Error(String(submit.error || 'ChatGPT Image 2 failed to start'));
  }
  return pollChatGptJob({ ...jobFrom(submit), onWait: opts.onWait });
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
  const [waitMsg, setWaitMsg] = useState('');
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
    setWaitMsg('Preparing images…');
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
      const raw = await res.text();
      let d: Record<string, unknown> = {};
      try { d = JSON.parse(raw) as Record<string, unknown>; } catch { /* html 504/500 */ }
      if (!res.ok) {
        throw new Error(
          String(d.error || '')
          || (res.status === 504 ? 'ChatGPT timed out — try again' : `Recreate failed (HTTP ${res.status})`),
        );
      }

      const name = String(d.name || productName || 'Recreated ad');
      const prompt = String(d.prompt || '').trim();
      const imageUrl = /^https?:\/\//i.test(String(d.imageUrl || ''))
        ? String(d.imageUrl)
        : (String(d.imagePath || '') ? absStreamUrl(String(d.imagePath)) : '');
      const secondaryImageUrl = /^https?:\/\//i.test(String(d.productImageUrl || ''))
        ? String(d.productImageUrl)
        : (String(d.productPath || '') ? absStreamUrl(String(d.productPath)) : '');

      let falUrl = '';
      if (d.status === 'pending' && (d.requestId || d.statusUrl)) {
        falUrl = await pollChatGptJob({
          ...jobFrom(d),
          onWait: setWaitMsg,
        });
      } else if (prompt && imageUrl) {
        falUrl = await submitAndPollChatGpt({
          prompt,
          imageUrl,
          secondaryImageUrl: secondaryImageUrl || undefined,
          onWait: setWaitMsg,
        });
      }

      if (!falUrl) {
        throw new Error(String(d.error || 'ChatGPT Image 2 did not return an image'));
      }

      let filePath = '';
      let previewUrl = falUrl;
      setResult({ filePath: '', name, previewUrl: falUrl });
      onResult({ filePath: '', name, previewUrl: falUrl });
      const ingested = await authFetch(`/api/templates/ads/${ad.id}/recreate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ingest', url: falUrl, name }),
      });
      const savedRaw = await ingested.text();
      let saved: Record<string, unknown> = {};
      try { saved = JSON.parse(savedRaw) as Record<string, unknown>; } catch { /* ignore */ }
      if (ingested.ok) {
        filePath = String(saved.filePath || saved.file_path || '');
        previewUrl = String(saved.previewUrl || falUrl);
      }
      const preview: RecreatePreview = {
        filePath,
        name,
        previewUrl: previewUrl || falUrl,
      };
      setResult(preview);
      onResult(preview);
      toast.success('Preview ready — save to the project or download');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Recreate failed');
    } finally {
      setBusy(false);
      setWaitMsg('');
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
        {busy ? (waitMsg || 'Working…') : 'Recreate ad'}
      </button>

      {busy && (
        <p className="text-[11px] text-gray-400">
          {waitMsg || 'Sending the job, then checking every 5 seconds. Keep this popup open.'}
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
