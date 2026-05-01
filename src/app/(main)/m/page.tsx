'use client';

import { useState } from 'react';
import type { FunnelCrawlResult, FunnelCrawlStep } from '@/types';
import {
  Loader2,
  Save,
  List,
  CheckCircle,
  ExternalLink,
  Globe,
  ChevronDown,
  ChevronUp,
  AlertCircle,
} from 'lucide-react';

export default function MobileFunnelPage() {
  const [entryUrl, setEntryUrl] = useState('');
  const [funnelName, setFunnelName] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FunnelCrawlResult | null>(null);
  const [view, setView] = useState<'input' | 'steps'>('input');
  const [selectedSteps, setSelectedSteps] = useState<Set<number>>(new Set());
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveAllSuccess, setSaveAllSuccess] = useState(false);
  const [saveAllError, setSaveAllError] = useState<string | null>(null);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  const runCrawl = async (afterCrawl?: (data: FunnelCrawlResult) => void) => {
    if (!entryUrl.trim()) return;
    setLoading(true);
    setResult(null);
    setSaveSuccess(null);
    setSaveError(null);
    setSaveAllSuccess(false);
    setSaveAllError(null);
    try {
      const startRes = await fetch('/api/funnel-analyzer/crawl/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryUrl: entryUrl.trim(),
          headless: true,
          maxSteps: 15,
          maxDepth: 3,
          followSameOriginOnly: true,
          captureScreenshots: true,
          captureNetwork: true,
          captureCookies: true,
          viewportWidth: 390,
          viewportHeight: 844,
        }),
      });
      const startData = await startRes.json();
      if (!startRes.ok || !startData.jobId) {
        setResult({
          success: false,
          entryUrl: entryUrl.trim(),
          steps: [],
          totalSteps: 0,
          durationMs: 0,
          visitedUrls: [],
          error: startData?.error || 'Failed to start crawl',
        });
        setLoading(false);
        return;
      }
      const jobId = startData.jobId;

      const poll = async (): Promise<void> => {
        const statusRes = await fetch(`/api/funnel-analyzer/crawl/status/${jobId}`);
        const statusData = await statusRes.json();
        if (statusData.status === 'completed' && statusData.result) {
          const data = statusData.result;
          setResult(data);
          setSelectedSteps(new Set());
          if (data.steps?.length) afterCrawl?.(data);
          setLoading(false);
          return;
        }
        if (statusData.status === 'failed') {
          setResult({
            success: false,
            entryUrl: entryUrl.trim(),
            steps: statusData.result?.steps ?? [],
            totalSteps: statusData.result?.totalSteps ?? 0,
            durationMs: statusData.result?.durationMs ?? 0,
            visitedUrls: statusData.result?.visitedUrls ?? [],
            error: statusData.error || 'Crawl failed',
          });
          setLoading(false);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
        return poll();
      };
      await poll();
    } catch (err) {
      setResult({
        success: false,
        entryUrl: entryUrl.trim(),
        steps: [],
        totalSteps: 0,
        durationMs: 0,
        visitedUrls: [],
        error: err instanceof Error ? err.message : 'Request failed',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAllFunnel = async () => {
    const name = funnelName.trim() || 'Unnamed funnel';
    setSaveAllError(null);
    setSaveAllSuccess(false);
    await runCrawl(async (data) => {
      if (!data.success || !data.steps?.length) {
        setSaveAllError('No steps to save.');
        return;
      }
      setSaveLoading(true);
      try {
        const res = await fetch('/api/funnel-analyzer/save-steps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entryUrl: data.entryUrl,
            funnelName: name,
            steps: data.steps,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Save failed');
        setSaveAllSuccess(true);
      } catch (err) {
        setSaveAllError(err instanceof Error ? err.message : 'Save error');
      } finally {
        setSaveLoading(false);
      }
    });
  };

  const handleSeeAllSteps = () => {
    setView('steps');
    runCrawl();
  };

  const toggleStep = (stepIndex: number) => {
    setSelectedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepIndex)) next.delete(stepIndex);
      else next.add(stepIndex);
      return next;
    });
    setSaveSuccess(null);
    setSaveError(null);
  };

  const selectAllSteps = () => {
    if (!result?.steps?.length) return;
    setSelectedSteps(new Set(result.steps.map((s) => s.stepIndex)));
  };

  const saveSelectedSteps = async () => {
    if (!result || selectedSteps.size === 0) return;
    const toSave = result.steps.filter((s) => selectedSteps.has(s.stepIndex));
    const name = funnelName.trim() || 'Unnamed funnel';
    setSaveLoading(true);
    setSaveSuccess(null);
    setSaveError(null);
    try {
      const res = await fetch('/api/funnel-analyzer/save-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryUrl: result.entryUrl,
          funnelName: name,
          steps: toSave,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setSaveSuccess(data.saved ?? toSave.length);
      setSelectedSteps(new Set());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save error');
    } finally {
      setSaveLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 max-w-[480px] mx-auto shadow-xl">
      {/* Compact header */}
      <header className="sticky top-0 z-10 bg-emerald-600 text-white px-4 py-3 safe-area-inset-top">
        <h1 className="text-lg font-semibold">Funnel Mobile</h1>
        <p className="text-emerald-100 text-xs mt-0.5">Paste the link and save the steps</p>
      </header>

      <div className="p-4 pb-8 space-y-4">
        {/* Input URL */}
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-200">
          <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
            <Globe className="w-4 h-4 text-emerald-500" />
            Funnel link
          </label>
          <input
            type="url"
            value={entryUrl}
            onChange={(e) => setEntryUrl(e.target.value)}
            placeholder="https://..."
            className="w-full px-4 py-3 text-base border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none"
            inputMode="url"
            autoComplete="url"
          />
        </div>

        {/* Funnel name (used for Save all and Save selected) */}
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-200">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Funnel name (for saving)
          </label>
          <input
            type="text"
            value={funnelName}
            onChange={(e) => setFunnelName(e.target.value)}
            placeholder="e.g. Funnel Bioma Q1"
            className="w-full px-4 py-3 text-base border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none"
          />
        </div>

        {/* Two main buttons */}
        <div className="grid grid-cols-1 gap-3">
          <button
            onClick={handleSaveAllFunnel}
            disabled={!entryUrl.trim() || loading || saveLoading}
            className="flex items-center justify-center gap-2 w-full py-4 bg-emerald-600 text-white rounded-xl font-medium text-base active:bg-emerald-700 disabled:opacity-50 disabled:pointer-events-none touch-manipulation"
          >
            {(loading || saveLoading) && view === 'input' ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Save className="w-5 h-5" />
            )}
            Save entire funnel
          </button>
          <button
            onClick={handleSeeAllSteps}
            disabled={!entryUrl.trim() || loading}
            className="flex items-center justify-center gap-2 w-full py-4 bg-white border-2 border-emerald-600 text-emerald-700 rounded-xl font-medium text-base active:bg-emerald-50 disabled:opacity-50 disabled:pointer-events-none touch-manipulation"
          >
            {loading && view === 'steps' ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <List className="w-5 h-5" />
            )}
            View all steps
          </button>
        </div>

        {/* Save all messages */}
        {saveAllSuccess && (
          <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-xl text-green-800 text-sm">
            <CheckCircle className="w-5 h-5 shrink-0" />
            The entire funnel has been saved.
          </div>
        )}
        {saveAllError && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
            <AlertCircle className="w-5 h-5 shrink-0" />
            {saveAllError}
          </div>
        )}

        {/* Step list (after "View all steps") */}
        {view === 'steps' && result && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            {result.error && (
              <div className="p-4 bg-red-50 border-b border-red-100 flex items-start gap-2 text-red-700 text-sm">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                {result.error}
              </div>
            )}
            {result.success && result.steps.length > 0 && (
              <>
                <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
                  <span className="text-sm text-gray-600">
                    {result.totalSteps} steps crawled
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={selectAllSteps}
                      className="text-sm text-emerald-600 font-medium"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={saveSelectedSteps}
                      disabled={selectedSteps.size === 0 || saveLoading}
                      className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                    >
                      {saveLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <CheckCircle className="w-4 h-4" />
                      )}
                      Save ({selectedSteps.size})
                    </button>
                  </div>
                </div>
                {saveSuccess !== null && (
                  <div className="px-4 py-2 bg-green-50 text-green-700 text-sm">
                    Saved {saveSuccess} steps.
                  </div>
                )}
                {saveError && (
                  <div className="px-4 py-2 bg-red-50 text-red-700 text-sm flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {saveError}
                  </div>
                )}
                <ul className="divide-y divide-gray-200">
                  {result.steps.map((step) => (
                    <MobileStepRow
                      key={step.stepIndex}
                      step={step}
                      selected={selectedSteps.has(step.stepIndex)}
                      expanded={expandedStep === step.stepIndex}
                      onToggleSelect={() => toggleStep(step.stepIndex)}
                      onToggleExpand={() =>
                        setExpandedStep((p) => (p === step.stepIndex ? null : step.stepIndex))
                      }
                    />
                  ))}
                </ul>
              </>
            )}
            {result.success && result.steps.length === 0 && (
              <div className="p-6 text-center text-gray-500 text-sm">
                No steps found for this URL.
              </div>
            )}
          </div>
        )}

        {/* Direct link (info) */}
        <p className="text-xs text-gray-500 text-center pt-2">
          Mobile page · Direct link: <strong>/m</strong>
        </p>
      </div>

      {/* Overlay loading */}
      {(loading || saveLoading) && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 max-w-[480px] left-1/2 -translate-x-1/2">
          <div className="bg-white rounded-2xl p-6 mx-4 flex flex-col items-center shadow-xl">
            <Loader2 className="w-12 h-12 animate-spin text-emerald-600 mb-3" />
            <p className="text-gray-900 font-medium">
              {loading ? 'Crawling...' : 'Saving...'}
            </p>
            <p className="text-gray-500 text-sm mt-1">
              {loading ? 'Analyzing funnel pages' : 'Writing to Supabase'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function MobileStepRow({
  step,
  selected,
  expanded,
  onToggleSelect,
  onToggleExpand,
}: {
  step: FunnelCrawlStep;
  selected: boolean;
  expanded: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
}) {
  return (
    <li className="bg-white">
      <div className="flex items-center gap-3 px-4 py-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          className="w-5 h-5 text-emerald-600 rounded border-gray-300 shrink-0 touch-manipulation"
          aria-label={`Save step ${step.stepIndex}`}
        />
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex-1 flex items-center gap-2 text-left min-w-0"
        >
          {expanded ? (
            <ChevronUp className="w-5 h-5 text-gray-400 shrink-0" />
          ) : (
            <ChevronDown className="w-5 h-5 text-gray-400 shrink-0" />
          )}
          <span className="font-medium text-gray-900">Step {step.stepIndex}</span>
          <span className="text-gray-500 truncate flex-1 text-sm">
            {step.title || step.url}
          </span>
          <a
            href={step.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-600 p-2 -m-2 shrink-0"
            onClick={(e) => e.stopPropagation()}
            aria-label="Open link"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        </button>
      </div>
      {expanded && (
        <div className="px-4 pb-4 pl-12">
          {step.screenshotBase64 && (
            <div className="rounded-lg border border-gray-200 overflow-hidden bg-gray-100 mb-3">
              <img
                src={`data:image/png;base64,${step.screenshotBase64}`}
                alt={`Step ${step.stepIndex}`}
                className="w-full max-h-48 object-contain object-top"
              />
            </div>
          )}
          <a
            href={step.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-emerald-600 break-all"
          >
            {step.url}
          </a>
        </div>
      )}
    </li>
  );
}
