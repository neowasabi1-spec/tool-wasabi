'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, X, Paintbrush, CheckCircle, XCircle, Eye } from 'lucide-react';

export type RestyleWatchSibling = {
  id: string;
  name: string;
  swipeStatus: string;
};

function previewUrl(pageId: string, kind: 'swiped' | 'cloned', bust: string): string {
  return (
    `/api/funnel-html?pageId=${encodeURIComponent(pageId)}` +
    `&kind=${kind}&variant=desktop&inert=1&v=${encodeURIComponent(bust)}`
  );
}

/**
 * Live reconstruction popup. Closing it does NOT stop the worker —
 * it only hides this window. Reopen from the eye on an In Progress row.
 *
 * The iframe is inert (no scripts) and loaded via URL — we never pull
 * megabytes of HTML into React. That was freezing the browser.
 */
export function RestyleWatchModal({
  open,
  pageId,
  pageName,
  siblings,
  onSelectPage,
  onStatus,
  onClose,
}: {
  open: boolean;
  pageId: string;
  pageName: string;
  siblings?: RestyleWatchSibling[];
  onSelectPage?: (id: string, name: string) => void;
  onStatus?: (pageId: string, swipeStatus: string, swipeResult: string) => void;
  onClose: () => void;
}) {
  const [result, setResult] = useState('');
  const [status, setStatus] = useState('in_progress');
  const [frameSrc, setFrameSrc] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const lastToken = useRef('');
  const debounceRef = useRef<number | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    if (!open || !pageId) return;
    let cancelled = false;
    setResult('Waiting for the first draft…');
    setStatus('in_progress');
    setFrameSrc(previewUrl(pageId, 'cloned', `open-${Date.now()}`));
    lastToken.current = '';

    const show = (kind: 'swiped' | 'cloned', token: string) => {
      if (token === lastToken.current) return;
      lastToken.current = token;
      const src = previewUrl(pageId, kind, token);
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        if (cancelled) return;
        setFrameSrc(src);
        setUpdatedAt(Date.now());
      }, 800);
    };

    const tick = async () => {
      try {
        const stRes = await fetch(`/api/chimera/swipe?ids=${encodeURIComponent(pageId)}`, { cache: 'no-store' });
        const stData = (await stRes.json().catch(() => ({}))) as {
          pages?: Array<{ swipeStatus?: string; swipeResult?: string }>;
        };
        const row = stData.pages?.[0];
        if (cancelled || !row) return;
        setStatus(row.swipeStatus || 'in_progress');
        if (row.swipeResult) setResult(row.swipeResult);
        if (row.swipeStatus) onStatusRef.current?.(pageId, row.swipeStatus, row.swipeResult || '');
        const progressed = /texts|theme|photo|palette|visual|rewritten|replaced|editing|product shot/i
          .test(row.swipeResult || '');
        show(progressed ? 'swiped' : 'cloned', `${row.swipeStatus}|${row.swipeResult || ''}`);
      } catch {
        /* keep last frame */
      }
    };

    void tick();
    const id = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [open, pageId]);

  if (!open) return null;

  const running = status === 'in_progress' || status === 'pending';
  const done = status === 'completed';

  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-4 bg-black/55">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-violet-100 bg-gradient-to-r from-violet-50 via-fuchsia-50 to-amber-50">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              {running ? (
                <Loader2 className="w-4 h-4 animate-spin text-violet-600" />
              ) : done ? (
                <CheckCircle className="w-4 h-4 text-emerald-600" />
              ) : (
                <XCircle className="w-4 h-4 text-red-500" />
              )}
              <Paintbrush className="w-4 h-4 text-fuchsia-600" />
              <span className="truncate">{pageName}</span>
              <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                running ? 'bg-amber-100 text-amber-800' : done ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'
              }`}>
                {running ? 'Rebuilding' : done ? 'Done' : 'Failed'}
              </span>
            </div>
            <p className="mt-1 text-xs text-gray-600 truncate" title={result}>
              {result || 'Internal restyle running in the background…'}
            </p>
            <p className="mt-0.5 text-[11px] text-gray-400">
              Close anytime — the restyle keeps going. Preview is static (no page scripts).
              {updatedAt ? ` · refreshed ${Math.max(0, Math.round((Date.now() - updatedAt) / 1000))}s ago` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 p-2 rounded-lg text-gray-500 hover:bg-white/80 hover:text-gray-800"
            title="Close preview — restyle continues"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {siblings && siblings.length > 1 && (
          <div className="flex items-center gap-1.5 px-4 py-2 border-b border-gray-100 overflow-x-auto bg-white">
            {siblings.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelectPage?.(s.id, s.name)}
                className={`text-[11px] px-2.5 py-1 rounded-full border whitespace-nowrap ${
                  s.id === pageId
                    ? 'bg-violet-600 text-white border-violet-600'
                    : s.swipeStatus === 'completed'
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      : s.swipeStatus === 'failed'
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : 'bg-amber-50 text-amber-800 border-amber-200'
                }`}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}

        <div className="relative flex-1 bg-gray-100 min-h-0">
          {!frameSrc && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-500">
              <Eye className="w-8 h-8 text-violet-300" />
              <p className="text-sm">Waiting for the first rebuilt HTML…</p>
              <p className="text-xs text-gray-400">Texts + palette land first, then photos in batches.</p>
            </div>
          )}
          {frameSrc ? (
            <iframe
              title={`Restyle preview ${pageName}`}
              className="w-full h-full bg-white"
              sandbox=""
              src={frameSrc}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
