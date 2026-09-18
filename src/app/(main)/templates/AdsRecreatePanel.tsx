'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FolderKanban, ImagePlus, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { authFetch } from '@/lib/auth/client-fetch';
import { getUploadUrl } from '@/lib/projecthub-storage';
import { supabase } from '@/lib/supabase';
import {
  absStreamUrl,
  extractVideoPosters,
  submitAndPollGenerate,
} from './ads-recreate-client';

type RecreatedAd = {
  id: string;
  name: string;
  media_type?: string;
  file_path?: string;
};

export type RecreatePreview = {
  filePath: string;
  name: string;
  previewUrl: string;
  mediaType?: 'image' | 'video';
};

type ProjectPick = { id: string; name: string; brief?: string | null; description?: string | null };
type ProductPick = { id: string; name: string; brand_name?: string | null; image_url?: string | null };

type Props = {
  ads: RecreatedAd[];
  onResult: (result: RecreatePreview | null) => void;
  onActiveAd?: (ad: RecreatedAd) => void;
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

function videoFallbackPrompt(productName: string, brief: string, adName: string): string {
  const name = productName || 'our product';
  return [
    `Create a 10-second multi-shot product video for ${name}.`,
    brief ? `Product facts: ${brief.replace(/\s+/g, ' ').trim().slice(0, 800)}.` : '',
    `Match the persuasive intent and format of the competitor clip titled "${adName}".`,
    'Keep the same genre (UGC, demo, testimonial, before/after, news, lifestyle) and energy.',
    'Realistic, photoreal, professional cinematic lighting, smooth motion, sharp focus, no on-screen text, no captions, no logos, no audio.',
  ].filter(Boolean).join(' ');
}

export default function AdsRecreatePanel({ ads, onResult, onActiveAd }: Props) {
  const photoRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  const [projects, setProjects] = useState<ProjectPick[]>([]);
  const [products, setProducts] = useState<ProductPick[]>([]);
  const [projectId, setProjectId] = useState('');
  const [productId, setProductId] = useState('');
  const [productName, setProductName] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [waitMsg, setWaitMsg] = useState('');
  const [queueIndex, setQueueIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedHref, setSavedHref] = useState('');
  const [analysis, setAnalysis] = useState('');
  const [result, setResult] = useState<RecreatePreview | null>(null);
  const [history, setHistory] = useState<RecreatePreview[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);

  const queue = ads.filter((a) => a.id && a.media_type !== 'folder');
  const firstId = queue[0]?.id || '';
  const bulk = queue.length > 1;

  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingProjects(true);
      try {
        const catalogUrl = firstId
          ? `/api/templates/ads/${firstId}/recreate`
          : '/api/templates/ads';
        const [hub, list, db, catalog] = await Promise.all([
          authFetch('/api/projecthub/projects').then((r) => r.json()).catch(() => null),
          authFetch('/api/projects/list').then((r) => r.json()).catch(() => null),
          supabase.from('projects').select('id, name, description, brief').order('created_at', { ascending: false }),
          firstId
            ? authFetch(catalogUrl).then((r) => r.json()).catch(() => ({}))
            : Promise.resolve({}),
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
  }, [firstId]);

  useEffect(() => {
    setResult(null);
    setSaved(false);
    setSavedHref('');
    setAnalysis('');
    setHistory([]);
    setQueueIndex(0);
  }, [firstId, queue.length]);

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

  const canRun = Boolean(projectId || productId || photo || productName.trim()) && queue.length > 0;

  const ingest = async (adId: string, falUrl: string, name: string, mediaType: 'image' | 'video') => {
    const ingested = await authFetch(`/api/templates/ads/${adId}/recreate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ingest', url: falUrl, name, mediaType }),
    });
    const savedRaw = await ingested.text();
    let savedJson: Record<string, unknown> = {};
    try { savedJson = JSON.parse(savedRaw) as Record<string, unknown>; } catch { /* ignore */ }
    if (!ingested.ok) {
      return { filePath: '', previewUrl: falUrl, mediaType };
    }
    return {
      filePath: String(savedJson.filePath || savedJson.file_path || ''),
      previewUrl: String(savedJson.previewUrl || falUrl),
      mediaType: String(savedJson.mediaType || mediaType) === 'video' ? 'video' as const : 'image' as const,
    };
  };

  const saveOne = async (adId: string, preview: RecreatePreview, silent?: boolean) => {
    if (!projectId) {
      if (!silent) toast.error('Pick a project under My Projects first');
      return '';
    }
    let filePath = preview.filePath;
    if (!filePath && preview.previewUrl) {
      const kept = await ingest(adId, preview.previewUrl, preview.name, preview.mediaType || 'image');
      filePath = kept.filePath;
    }
    if (!filePath) throw new Error('The file is not ready to save yet');
    const res = await authFetch(`/api/templates/ads/${adId}/recreate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'save',
        projectId,
        filePath,
        name: preview.name,
      }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'Could not save to Creative');
    return String(d.href || `/projects/${projectId}?section=creative`);
  };

  const recreateOne = async (
    item: RecreatedAd,
    label: (msg: string) => void,
  ): Promise<RecreatePreview> => {
    const fd = new FormData();
    if (projectId) fd.append('projectId', projectId);
    if (productId) fd.append('productId', productId);
    if (productName.trim()) fd.append('productName', productName.trim());
    if (photo) fd.append('file', photo);
    const res = await authFetch(`/api/templates/ads/${item.id}/recreate`, {
      method: 'POST',
      body: fd,
    });
    const raw = await res.text();
    let d: Record<string, unknown> = {};
    try { d = JSON.parse(raw) as Record<string, unknown>; } catch { /* html 504/500 */ }
    if (!res.ok) {
      throw new Error(
        String(d.error || '')
        || (res.status === 504 ? 'Timed out — try again' : `Recreate failed (HTTP ${res.status})`),
      );
    }

    const name = String(d.name || productName || item.name || 'Recreated ad');
    const mediaType = String(d.mediaType || item.media_type || 'image') === 'video' ? 'video' : 'image';
    const productLabel = String(d.productName || productName || 'our product');
    const brief = String(d.brief || '');

    let falUrl = '';
    if (mediaType === 'video') {
      label('Reading video frames…');
      let frames: string[] = [];
      const srcPath = String(d.imagePath || item.file_path || '');
      if (srcPath) {
        try {
          frames = await extractVideoPosters(absStreamUrl(srcPath));
        } catch {
          frames = [];
        }
      }
      label('Analyzing the clip…');
      const analyzed = await fetch('/api/swipe-video/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          posterFrames: frames.slice(0, 3),
          currentAlt: item.name,
          pageTitle: item.name,
          productContext: {
            name: productLabel,
            brief: brief.slice(0, 2000),
          },
        }),
      }).then((r) => r.json()).catch(() => ({} as Record<string, unknown>));
      const suggested = String(analyzed.suggestedPrompt || '').trim();
      const neg = String(analyzed.negativePrompt || '').trim();
      const prompt = suggested
        ? (neg ? `${suggested}\n\nAvoid: ${neg}.` : suggested)
        : videoFallbackPrompt(productLabel, brief, item.name);
      setAnalysis(String(analyzed.analysis || analyzed.originalDescription || prompt).slice(0, 2500));
      const duration = analyzed.suggestedDuration === 5 ? 5 : 10;
      falUrl = await submitAndPollGenerate({
        mode: 'text2video',
        model: 'seedance-2-t2v',
        prompt,
        duration,
        onWait: label,
        label: 'Seedance',
      });
    } else {
      const prompt = String(d.prompt || '').trim();
      const imageUrl = /^https?:\/\//i.test(String(d.imageUrl || ''))
        ? String(d.imageUrl)
        : (String(d.imagePath || '') ? absStreamUrl(String(d.imagePath)) : '');
      const secondaryImageUrl = /^https?:\/\//i.test(String(d.productImageUrl || ''))
        ? String(d.productImageUrl)
        : (String(d.productPath || '') ? absStreamUrl(String(d.productPath)) : '');
      if (!prompt || !imageUrl) {
        throw new Error(String(d.error || 'ChatGPT Image 2 did not return an image'));
      }
      falUrl = await submitAndPollGenerate({
        mode: 'image2image',
        model: 'gpt-image-2-edit',
        prompt,
        imageUrl,
        secondaryImageUrl: secondaryImageUrl || undefined,
        onWait: label,
        label: 'ChatGPT Image 2',
      });
    }

    if (!falUrl) throw new Error('Generation did not return a file');
    const kept = await ingest(item.id, falUrl, name, mediaType);
    return {
      filePath: kept.filePath,
      name,
      previewUrl: kept.previewUrl || falUrl,
      mediaType: kept.mediaType,
    };
  };

  const recreate = async () => {
    if (!canRun) {
      toast.error('Pick a project, a product, or upload a packshot.');
      return;
    }
    cancelledRef.current = false;
    setBusy(true);
    setWaitMsg('Preparing…');
    setAnalysis('');
    setSaved(false);
    setSavedHref('');
    setResult(null);
    setHistory([]);
    onResult(null);
    const done: RecreatePreview[] = [];
    let failed = 0;
    let lastHref = '';
    try {
      for (let i = 0; i < queue.length; i++) {
        if (cancelledRef.current) return;
        const item = queue[i];
        setQueueIndex(i);
        onActiveAd?.(item);
        const prefix = bulk ? `${i + 1}/${queue.length} · ${item.name} — ` : '';
        const label = (msg: string) => setWaitMsg(`${prefix}${msg}`);
        label('Preparing…');
        try {
          const preview = await recreateOne(item, label);
          if (cancelledRef.current) return;
          done.push(preview);
          setHistory([...done]);
          setResult(preview);
          onResult(preview);
          if (projectId && preview.filePath) {
            try {
              lastHref = await saveOne(item.id, preview, true);
              setSaved(true);
              setSavedHref(lastHref);
            } catch (e) {
              toast.error(`${item.name}: ${e instanceof Error ? e.message : 'Could not save to Creative'}`);
            }
          }
        } catch (e) {
          failed += 1;
          toast.error(`${item.name}: ${e instanceof Error ? e.message : 'Recreate failed'}`);
        }
      }
      if (cancelledRef.current) return;
      if (done.length === 0) {
        toast.error('None of the selected creatives could be recreated');
      } else if (bulk) {
        toast.success(
          projectId
            ? `${done.length} saved to Creative → Recreated ads${failed ? ` · ${failed} failed` : ''}`
            : `${done.length} preview${done.length === 1 ? '' : 's'} ready${failed ? ` · ${failed} failed` : ''}`,
        );
      } else {
        toast.success(projectId && lastHref
          ? 'Saved to Creative → Recreated ads'
          : 'Preview ready — save to the project or download');
      }
    } finally {
      setBusy(false);
      setWaitMsg('');
    }
  };

  const projectLabel = projects.find((p) => p.id === projectId)?.name || '';
  const activeAd = queue[Math.min(queueIndex, Math.max(0, queue.length - 1))];

  const saveToProject = async () => {
    if (!result || !activeAd) return;
    setSaving(true);
    try {
      const href = await saveOne(activeAd.id, result);
      setSaved(true);
      setSavedHref(href);
      toast.success(`Saved in ${projectLabel || 'the project'} → Creative → Recreated ads`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save to Creative');
    } finally {
      setSaving(false);
    }
  };

  const fileDownloadHref = result?.filePath
    ? getUploadUrl(result.filePath) + (getUploadUrl(result.filePath).includes('?') ? '&' : '?') + 'download=1'
    : (result?.previewUrl || '');

  const runLabel = bulk
    ? `Recreate ${queue.length} ads`
    : 'Recreate ad';

  return (
    <div className="flex flex-col gap-3 p-4 bg-gray-900/80 border-t border-white/10 lg:border-t-0 lg:border-l lg:w-[340px] lg:shrink-0">
      <div>
        <p className="text-sm font-semibold text-white flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-violet-300" /> Recreate for your product
        </p>
        <p className="text-xs text-gray-400 mt-1">
          {bulk
            ? `Runs ${queue.length} creatives one by one (images and videos). Pick a project to save each into Creative → Recreated ads.`
            : 'Rebuilds this ad for your product. Download it, or save it into a project: Creative → Creatives → Recreated ads.'}
        </p>
      </div>

      {bulk && (
        <ol className="max-h-28 overflow-auto rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] text-gray-300 space-y-0.5">
          {queue.map((a, i) => (
            <li
              key={a.id}
              className={i === queueIndex && busy ? 'text-violet-300 font-medium' : i < history.length ? 'text-emerald-300' : ''}
            >
              {i + 1}. {a.name}{a.media_type === 'video' ? ' · video' : ''}
            </li>
          ))}
        </ol>
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

      {result?.previewUrl && (
        <div className="rounded-lg border border-violet-400/30 bg-violet-500/10 p-2 space-y-2">
          {result.mediaType === 'video' ? (
            <video src={result.previewUrl} controls className="w-full max-h-64 rounded-md bg-black" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={result.previewUrl}
              alt={result.name}
              className="w-full max-h-64 object-contain rounded-md bg-black"
            />
          )}
          {saved ? (
            <p className="text-[11px] text-emerald-300 px-1">
              Saved in {projectLabel || 'the project'} → Creative → Creatives → Recreated ads
            </p>
          ) : (
            <p className="text-[11px] text-gray-300 px-1">
              {projectId
                ? `Save puts this in ${projectLabel} → Creative → Creatives → Recreated ads`
                : 'Pick a project above, then save. It goes to Creative → Creatives → Recreated ads.'}
            </p>
          )}
          <button
            type="button"
            onClick={() => void saveToProject()}
            disabled={saving || busy || !projectId}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-white text-gray-900 text-sm font-medium hover:bg-gray-100 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderKanban className="w-4 h-4" />}
            {saved
              ? 'Saved to project'
              : projectLabel
                ? `Save to ${projectLabel}`
                : 'Save to project'}
          </button>
          {saved && savedHref && (
            <a
              href={savedHref}
              className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-500"
            >
              <ExternalLink className="w-4 h-4" />
              Open Creative tab
            </a>
          )}
          <a
            href={fileDownloadHref}
            download={result.name || (result.mediaType === 'video' ? 'recreated-ad.mp4' : 'recreated-ad.png')}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-white/20 text-white text-sm font-medium hover:bg-white/10"
          >
            <Download className="w-4 h-4" /> Download
          </a>
        </div>
      )}

      {history.length > 1 && (
        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-gray-500">Done</p>
          {history.map((h, i) => (
            <a
              key={`${h.filePath || h.previewUrl}-${i}`}
              href={h.filePath
                ? getUploadUrl(h.filePath) + (getUploadUrl(h.filePath).includes('?') ? '&' : '?') + 'download=1'
                : h.previewUrl}
              className="block truncate text-[11px] text-violet-300 hover:text-white"
              download={h.name}
            >
              {i + 1}. {h.name}
            </a>
          ))}
        </div>
      )}

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
        {busy ? (waitMsg || 'Working…') : runLabel}
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
