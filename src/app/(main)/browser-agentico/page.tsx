'use client';

import { useState, useRef, useEffect } from 'react';
import Header from '@/components/Header';
import type { AgenticCrawlResult, AgenticCrawlStep } from '@/types';
import {
  Play,
  Loader2,
  CheckCircle,
  XCircle,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Copy,
  Clock,
  Layers,
  AlertCircle,
  Bot,
  MousePointerClick,
  Eye,
  StopCircle,
  Scroll,
  Type,
  Navigation,
  ArrowLeft,
  Hourglass,
  Monitor,
} from 'lucide-react';

// =====================================================
// MAIN PAGE
// =====================================================

export default function BrowserAgenticoPage() {
  const [entryUrl, setEntryUrl] = useState('');
  const [maxSteps, setMaxSteps] = useState(100);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AgenticCrawlResult | null>(null);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [liveSteps, setLiveSteps] = useState<AgenticCrawlStep[]>([]);
  const pollRef = useRef(false);
  const stepsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest step
  useEffect(() => {
    if (liveSteps.length > 0 && loading) {
      stepsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [liveSteps.length, loading]);

  const runAgentic = async () => {
    if (!entryUrl.trim()) return;
    setLoading(true);
    setResult(null);
    setProgress(null);
    setLiveSteps([]);
    setExpandedStep(null);
    pollRef.current = true;

    try {
      const startRes = await fetch('/api/browser-agentico/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryUrl: entryUrl.trim(),
          maxSteps,
          viewportWidth: 1440,
          viewportHeight: 900,
        }),
      });
      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok || !startData.jobId) {
        setResult({
          success: false,
          entryUrl: entryUrl.trim(),
          steps: [],
          totalSteps: 0,
          durationMs: 0,
          error: (startData as { error?: string }).error || 'Unable to start',
        });
        setLoading(false);
        return;
      }
      const jobId = startData.jobId;

      const pollStatus = async (): Promise<void> => {
        if (!pollRef.current) return;

        const statusRes = await fetch(`/api/browser-agentico/status/${jobId}`);
        const statusData = await statusRes.json().catch(() => ({}));

        if (statusRes.status === 404 || statusData.status === 'not_found') {
          setResult({
            success: false,
            entryUrl: entryUrl.trim(),
            steps: [],
            totalSteps: 0,
            durationMs: 0,
            error: 'Job not found',
          });
          setLoading(false);
          return;
        }

        if (statusData.currentStep != null && statusData.totalSteps != null) {
          setProgress({ current: statusData.currentStep, total: statusData.totalSteps });
        }

        if (statusData.result?.steps?.length) {
          setLiveSteps(statusData.result.steps);
          const latest = statusData.result.steps[statusData.result.steps.length - 1];
          if (latest?.stepIndex) setExpandedStep(latest.stepIndex);
        }

        if (statusData.status === 'completed' && statusData.result) {
          setResult(statusData.result);
          setLiveSteps([]);
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
            error: statusData.error || 'Agentic browser failed',
            stopReason: statusData.result?.stopReason,
          });
          setLiveSteps([]);
          setLoading(false);
          return;
        }
        await new Promise((r) => setTimeout(r, 2500));
        return pollStatus();
      };
      await pollStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Request failed';
      setResult({
        success: false,
        entryUrl: entryUrl.trim(),
        steps: [],
        totalSteps: 0,
        durationMs: 0,
        error: msg === 'Failed to fetch' ? 'Network error' : msg,
      });
      setLiveSteps([]);
    } finally {
      setLoading(false);
      pollRef.current = false;
    }
  };

  const stopCrawl = () => {
    pollRef.current = false;
    setLoading(false);
    if (liveSteps.length > 0) {
      setResult({
        success: true,
        entryUrl: entryUrl.trim(),
        steps: liveSteps,
        totalSteps: liveSteps.length,
        durationMs: 0,
        stopReason: 'user_stopped',
      });
      setLiveSteps([]);
    }
  };

  const copyJson = () => {
    if (!result) return;
    const clean = {
      ...result,
      steps: result.steps.map(({ screenshotBase64, ...rest }) => rest),
    };
    navigator.clipboard.writeText(JSON.stringify(clean, null, 2));
  };

  const displaySteps = result ? result.steps : liveSteps;
  const showResults = displaySteps.length > 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="Browser Agentico"
        subtitle="Gemini Computer Use + Playwright — the model sees the screen and navigates the funnel autonomously"
      />

      <div className="p-6">
        {/* Controls */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Bot className="w-5 h-5 text-violet-500" />
            Gemini Computer Use — Funnel Navigator
          </h3>

          <div className="bg-violet-50 rounded-lg p-3 mb-4 border border-violet-200">
            <p className="text-sm text-violet-800">
              <Monitor className="w-4 h-4 inline mr-1 -mt-0.5" />
              The model <strong>sees the screen</strong> via screenshots and generates precise actions
              (click at coordinates, typing, scroll). Handles quizzes, forms, popups and navigates
              automatically to checkout.
            </p>
          </div>

          <div className="flex gap-3 mb-4">
            <input
              type="url"
              value={entryUrl}
              onChange={(e) => setEntryUrl(e.target.value)}
              placeholder="https://example.com/landing"
              className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent outline-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !loading) runAgentic();
              }}
            />
            {entryUrl && (
              <a
                href={entryUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-3 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 flex items-center"
              >
                <ExternalLink className="w-5 h-5" />
              </a>
            )}
          </div>

          <div className="flex items-center gap-4 mb-4">
            <label className="flex items-center gap-2">
              <span className="text-sm text-gray-600">Max step:</span>
              <input
                type="number"
                min={3}
                max={100}
                value={maxSteps}
                onChange={(e) =>
                  setMaxSteps(Math.min(100, Math.max(3, Number(e.target.value) || 100)))
                }
                className="w-20 px-2 py-1 border border-gray-300 rounded text-sm"
              />
            </label>
            <span className="text-xs text-gray-400">Viewport: 1440 x 900 (Google recommended)</span>
          </div>

          <div className="flex gap-3">
            <button
              onClick={runAgentic}
              disabled={!entryUrl.trim() || loading}
              className="flex items-center gap-2 px-6 py-3 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-medium"
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Play className="w-5 h-5" />
              )}
              {loading ? 'Running...' : 'Start Computer Use'}
            </button>
            {loading && (
              <button
                onClick={stopCrawl}
                className="flex items-center gap-2 px-4 py-3 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors"
              >
                <StopCircle className="w-5 h-5" />
                Stop
              </button>
            )}
          </div>
        </div>

        {/* Progress */}
        {loading && progress && (
          <div className="bg-white rounded-lg shadow-sm border border-violet-200 p-4 mb-6">
            <div className="flex items-center gap-3 mb-2">
              <Loader2 className="w-5 h-5 animate-spin text-violet-500" />
              <span className="font-medium text-gray-900">
                Step {progress.current} / {progress.total}
              </span>
              <span className="text-sm text-gray-500">
                — Computer Use analyzes and acts
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-violet-500 h-2 rounded-full transition-all duration-700"
                style={{ width: `${Math.max(2, (progress.current / progress.total) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Results */}
        {showResults && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3 flex-wrap">
                {result ? (
                  result.success ? (
                    <span className="flex items-center gap-2 px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium">
                      <CheckCircle className="w-4 h-4" />
                      Completed
                    </span>
                  ) : (
                    <span className="flex items-center gap-2 px-3 py-1 bg-red-100 text-red-700 rounded-full text-sm font-medium">
                      <XCircle className="w-4 h-4" />
                      Error
                    </span>
                  )
                ) : (
                  <span className="flex items-center gap-2 px-3 py-1 bg-violet-100 text-violet-700 rounded-full text-sm font-medium">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    In progress...
                  </span>
                )}
                <span className="flex items-center gap-1 text-sm text-gray-500">
                  <Layers className="w-4 h-4" />
                  {displaySteps.length} step
                </span>
                {result?.durationMs ? (
                  <span className="flex items-center gap-1 text-sm text-gray-500">
                    <Clock className="w-4 h-4" />
                    {(result.durationMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
                {result?.stopReason && (
                  <span className="flex items-center gap-1 text-xs text-gray-400">
                    <StopCircle className="w-3 h-3" />
                    {formatStopReason(result.stopReason)}
                  </span>
                )}
              </div>
              {result && (
                <button
                  onClick={copyJson}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
                >
                  <Copy className="w-4 h-4" />
                  Copy JSON
                </button>
              )}
            </div>

            {result?.error && (
              <div className="mx-6 mt-4 p-4 bg-red-50 rounded-lg border border-red-200 flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                <p className="text-red-700 text-sm">{result.error}</p>
              </div>
            )}

            {/* Step list */}
            <div className="divide-y divide-gray-100">
              {displaySteps.map((step) => (
                <StepCard
                  key={step.stepIndex}
                  step={step}
                  expanded={expandedStep === step.stepIndex}
                  onToggleExpand={() =>
                    setExpandedStep((prev) =>
                      prev === step.stepIndex ? null : step.stepIndex,
                    )
                  }
                  isLive={!result}
                />
              ))}
              <div ref={stepsEndRef} />
            </div>
          </div>
        )}

        {/* Health link */}
        <a
          href="/api/health"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-flex items-center gap-2 text-xs text-gray-400 hover:text-emerald-600"
        >
          <AlertCircle className="w-3 h-3" />
          API Diagnostics
        </a>
      </div>
    </div>
  );
}

// =====================================================
// STEP CARD COMPONENT
// =====================================================

function StepCard({
  step,
  expanded,
  onToggleExpand,
  isLive,
}: {
  step: AgenticCrawlStep;
  expanded: boolean;
  onToggleExpand: () => void;
  isLive?: boolean;
}) {
  return (
    <div className="px-6 py-3">
      <button
        onClick={onToggleExpand}
        className="w-full flex items-center gap-3 text-left"
      >
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-gray-400 shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />
        )}
        <span
          className={`font-medium text-sm ${isLive ? 'text-violet-700' : 'text-gray-900'}`}
        >
          Step {step.stepIndex}
        </span>
        {isLive && (
          <span className="w-2 h-2 rounded-full bg-violet-500 animate-pulse shrink-0" />
        )}

        {/* Action badge */}
        {step.actions && step.actions.length > 0 && (
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 bg-violet-100 text-violet-700 rounded-full">
            {getActionIcon(step.actions[0].name)}
            {formatActionName(step.actions[0].name)}
          </span>
        )}

        <span className="text-gray-400 text-xs truncate flex-1">
          {step.title || step.url}
        </span>
        <a
          href={step.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-violet-600 hover:underline shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </button>

      {expanded && (
        <div className="mt-3 pl-7 space-y-3">
          {/* Model thought */}
          {step.modelThought && (
            <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
              <p className="text-xs font-medium text-gray-500 mb-1 flex items-center gap-1">
                <Eye className="w-3 h-3" />
                Model reasoning
              </p>
              <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                {step.modelThought.slice(0, 500)}
                {step.modelThought.length > 500 && '...'}
              </p>
            </div>
          )}

          {/* Actions */}
          {step.actions && step.actions.length > 0 && (
            <div className="bg-violet-50 rounded-lg p-3 border border-violet-200">
              <p className="text-xs font-medium text-violet-700 mb-2 flex items-center gap-1">
                <MousePointerClick className="w-3 h-3" />
                Actions executed
              </p>
              <div className="space-y-1">
                {step.actions.map((action, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs font-mono bg-violet-100 text-violet-800 px-2 py-0.5 rounded">
                      {action.name}
                    </span>
                    <span className="text-xs text-violet-600 truncate">
                      {formatActionArgs(action.name, action.args)}
                    </span>
                  </div>
                ))}
              </div>
              {step.actionExecuted === false && step.actionError && (
                <p className="text-xs text-red-600 mt-2">
                  <AlertCircle className="w-3 h-3 inline mr-1" />
                  {step.actionError}
                </p>
              )}
            </div>
          )}

          {/* Screenshot */}
          {step.screenshotBase64 && (
            <div className="rounded-lg border border-gray-200 overflow-hidden bg-gray-100">
              <img
                src={`data:image/jpeg;base64,${step.screenshotBase64}`}
                alt={`Step ${step.stepIndex}`}
                className="w-full max-h-[550px] object-contain object-top"
                loading="lazy"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =====================================================
// FORMATTERS
// =====================================================

function formatStopReason(reason: string): string {
  const map: Record<string, string> = {
    checkout_reached: 'Checkout reached',
    task_complete: 'Task completed by model',
    no_actions_repeated: 'No actions for 3 turns',
    gemini_api_error: 'Gemini API error',
    blocked_payment_action: 'Payment action blocked',
    max_steps_reached: 'Max steps reached',
    user_stopped: 'Stopped by user',
    loop_ended: 'Loop ended',
    exception: 'Unexpected error',
  };
  return map[reason] || reason;
}

function formatActionName(name: string): string {
  const map: Record<string, string> = {
    click_at: 'Click',
    type_text_at: 'Type',
    scroll_document: 'Scroll',
    scroll_at: 'Scroll',
    hover_at: 'Hover',
    navigate: 'Navigate',
    go_back: 'Back',
    go_forward: 'Forward',
    key_combination: 'Key',
    wait_5_seconds: 'Wait',
    drag_and_drop: 'Drag',
    search: 'Search',
    open_web_browser: 'Open',
  };
  return map[name] || name;
}

function formatActionArgs(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'click_at':
      return `(${args.x}, ${args.y})`;
    case 'type_text_at':
      return `"${String(args.text || '').slice(0, 40)}" at (${args.x}, ${args.y})`;
    case 'scroll_document':
    case 'scroll_at':
      return String(args.direction || '');
    case 'navigate':
      return String(args.url || '').slice(0, 60);
    case 'key_combination':
      return String(args.keys || '');
    case 'hover_at':
      return `(${args.x}, ${args.y})`;
    default:
      return Object.keys(args).length > 0 ? JSON.stringify(args).slice(0, 60) : '';
  }
}

function getActionIcon(name: string) {
  switch (name) {
    case 'click_at':
      return <MousePointerClick className="w-3 h-3" />;
    case 'type_text_at':
      return <Type className="w-3 h-3" />;
    case 'scroll_document':
    case 'scroll_at':
      return <Scroll className="w-3 h-3" />;
    case 'navigate':
      return <Navigation className="w-3 h-3" />;
    case 'go_back':
      return <ArrowLeft className="w-3 h-3" />;
    case 'wait_5_seconds':
      return <Hourglass className="w-3 h-3" />;
    default:
      return <Bot className="w-3 h-3" />;
  }
}
