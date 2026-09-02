'use client';

import { useRef, useState } from 'react';
import { Label } from '@/components/ui/label';
import { authFetch } from '@/lib/auth/client-fetch';
import { ImagePlus, Loader2, X } from 'lucide-react';
import type { ChimeraImageMode } from '@/components/projecthub/autopilot/ChimeraImageModeToggle';

export function ChimeraProductPhoto({
  projectId,
  imageMode,
  value,
  onChange,
  disabled,
}: {
  projectId?: string;
  imageMode: ChimeraImageMode;
  value: string;
  onChange: (url: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hint = value
    ? 'This packshot and its colors will be used on the landing.'
    : imageMode === 'affiliate'
      ? 'No photo: Affiliate keeps competitor images. Mockup is skipped.'
      : 'No photo: Internal invents a product mockup from the brief.';

  const upload = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (projectId) fd.append('projectId', projectId);
      const res = await authFetch('/api/chimera/product-photo', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Upload failed');
      const url = String((data as { url?: string }).url || '');
      if (!url) throw new Error('Upload returned no URL');
      onChange(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-violet-200 bg-violet-50/70 p-3">
      <Label className="text-sm font-semibold text-slate-900">Product photo (optional)</Label>
      <button
        type="button"
        disabled={disabled || uploading}
        onClick={() => inputRef.current?.click()}
        className="flex w-full items-center gap-3 rounded-lg border border-dashed border-violet-300 bg-white px-3 py-3 text-left hover:border-violet-500 hover:bg-violet-50/50 disabled:opacity-50"
      >
        <span className="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-slate-50 text-slate-400">
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="Product" className="h-full w-full object-cover" />
          ) : uploading ? (
            <Loader2 className="h-5 w-5 animate-spin text-violet-600" />
          ) : (
            <ImagePlus className="h-6 w-6 text-violet-600" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-slate-900">
            {uploading ? 'Uploading…' : value ? 'Photo uploaded — click to replace' : 'Click to upload packshot'}
          </span>
          <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>
        </span>
      </button>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {value && (
        <button
          type="button"
          disabled={disabled || uploading}
          onClick={() => onChange('')}
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900"
        >
          <X className="h-3 w-3" /> Remove photo
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        disabled={disabled || uploading}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
