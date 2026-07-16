'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import VisualHtmlEditor from '@/components/VisualHtmlEditor';
import { authFetch } from '@/lib/auth/client-fetch';

/**
 * Standalone editor for a saved archive page (funnel_pages row). Deep-linkable
 * as `/edit/<pageId>` — used by the browser extension's "Open in editor"
 * button. Loads the HTML stored in `page_html` (kind=cloned), lets the user
 * edit it in the visual editor, and saves it back to the same slot.
 */
function EditSavedPageInner() {
  const params = useParams<{ pageId: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const pageId = params?.pageId as string;
  const sourceUrl = search.get('src') || undefined;
  const title = search.get('title') || 'Saved page';

  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(
          `/api/funnel-html?pageId=${encodeURIComponent(pageId)}&kind=cloned&variant=desktop&v=${Date.now()}`,
        );
        if (res.status === 404) {
          if (!cancelled) setError('No saved HTML found for this page.');
          return;
        }
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          if (!cancelled) setError(txt || `Failed to load (${res.status})`);
          return;
        }
        const text = await res.text();
        if (!cancelled) setHtml(text);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load page');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  const handleSave = useCallback(
    async (nextHtml: string) => {
      try {
        const res = await authFetch('/api/extension/save-html', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageId, html: nextHtml }),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          setError(txt || `Save failed (${res.status})`);
          return;
        }
        setSavedAt(Date.now());
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Save failed');
      }
    },
    [pageId],
  );

  if (error) {
    return (
      <div className="p-8">
        <button onClick={() => router.push('/my-funnels')} className="text-sm text-gray-500 hover:text-gray-800 mb-4">
          ← Back
        </button>
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 max-w-lg">{error}</div>
      </div>
    );
  }

  if (html === null) {
    return (
      <div className="flex items-center justify-center h-[70vh] text-gray-500">
        <div className="animate-pulse">Loading saved page…</div>
      </div>
    );
  }

  return (
    <VisualHtmlEditor
      initialHtml={html}
      pageTitle={savedAt ? `${title} (saved ✓)` : title}
      sourceUrl={sourceUrl}
      onSave={handleSave}
      onClose={() => router.push('/my-funnels')}
    />
  );
}

export default function EditSavedPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-[70vh] text-gray-500">
          <div className="animate-pulse">Loading…</div>
        </div>
      }
    >
      <EditSavedPageInner />
    </Suspense>
  );
}
