'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2, X, CheckCircle2, AlertCircle, Sparkles,
  PenLine, Layers, Zap, FileCode2, Clock,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SwipeLogKind = 'info' | 'progress' | 'success' | 'warn' | 'error' | 'rewrite';

export interface SwipeLogEntry {
  id: number;
  at: number;
  kind: SwipeLogKind;
  pageName?: string;
  message: string;
}

export type SwipeAllStep =
  | 'idle' | 'cloning' | 'rewriting' | 'narrative' | 'completed' | 'failed';

export interface SwipeAllJobShape {
  isRunning: boolean;
  cancelRequested: boolean;
  currentIndex: number;
  totalCount: number;
  currentStep: SwipeAllStep;
  currentPageName: string;
  batchInfo: string;
  completed: number;
  errors: { pageId: string; pageName: string; message: string }[];
  startedAt: number;
}

export interface CloneProgressShape {
  phase: string;
  totalTexts: number;
  processedTexts: number;
  message: string;
}

export interface SwipePageInfo {
  id: string;
  name: string;
  pageType?: string;
  url?: string;
  swipeStatus?: 'pending' | 'in_progress' | 'completed' | 'failed';
  clonedHtml?: string;
}

export interface SwipeCinemaOverlayProps {
  swipeAll: SwipeAllJobShape | null;
  cloneProgress: CloneProgressShape | null;
  cloneTargetPageName?: string;
  pages: SwipePageInfo[];
  log: SwipeLogEntry[];
  onCancel: () => void;
  onClose?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function SwipeCinemaOverlay({
  swipeAll,
  cloneProgress,
  cloneTargetPageName,
  pages,
  log,
  onCancel,
  onClose,
}: SwipeCinemaOverlayProps) {
  const isSwipeAll = !!swipeAll && (swipeAll.isRunning || swipeAll.completed > 0 || swipeAll.errors.length > 0);
  const isSingle = !isSwipeAll && !!cloneProgress;
  const open = isSwipeAll || isSingle;

  // Wallclock tick — updates the elapsed timer once per second.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [open]);

  // Auto-scroll the log to the bottom on each new entry.
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log.length]);

  const startedAt = swipeAll?.startedAt;
  const elapsedSec = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  const completed = swipeAll?.completed ?? 0;
  const total = swipeAll?.totalCount ?? (isSingle ? 1 : 0);
  const isRunning = !!(swipeAll?.isRunning) || isSingle;
  const cancelRequested = !!swipeAll?.cancelRequested;

  // ETA from average per-page time so far. Only meaningful after >=1 page.
  const etaSec = useMemo(() => {
    if (!isSwipeAll || completed < 1 || total <= completed) return null;
    const avg = elapsedSec / completed;
    return Math.round(avg * (total - completed));
  }, [isSwipeAll, completed, total, elapsedSec]);

  const overallPct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const currentPageName = isSwipeAll
    ? (swipeAll?.currentPageName || '\u2014')
    : (cloneTargetPageName || cloneProgress?.message || 'Rewrite');

  const stepLabel = isSwipeAll
    ? labelForStep(swipeAll!.currentStep)
    : (cloneProgress ? labelForCloneProgress(cloneProgress) : '');

  // Per-batch progress for the centre column. Pulls from swipeAll.batchInfo
  // which is like "batch 3 (24/87)" or from cloneProgress directly.
  const batchProgress = useMemo(() => {
    if (isSingle && cloneProgress?.totalTexts) {
      return {
        done: cloneProgress.processedTexts,
        total: cloneProgress.totalTexts,
        pct: Math.round((cloneProgress.processedTexts / cloneProgress.totalTexts) * 100),
      };
    }
    if (isSwipeAll && swipeAll?.batchInfo) {
      const m = swipeAll.batchInfo.match(/\((\d+)\/(\d+)\)/);
      if (m) {
        const done = parseInt(m[1], 10);
        const tot = parseInt(m[2], 10);
        return tot > 0 ? { done, total: tot, pct: Math.round((done / tot) * 100) } : null;
      }
    }
    return null;
  }, [isSingle, cloneProgress, isSwipeAll, swipeAll?.batchInfo]);

  // Live preview HTML for the iframe. Use the most up-to-date clonedHtml
  // for the current page (or the only page in single mode).
  const currentPage = useMemo(() => {
    if (isSwipeAll && swipeAll?.currentPageName) {
      return pages.find((p) => p.name === swipeAll.currentPageName);
    }
    if (isSingle && cloneTargetPageName) {
      return pages.find((p) => p.name === cloneTargetPageName);
    }
    return undefined;
  }, [isSwipeAll, isSingle, swipeAll?.currentPageName, cloneTargetPageName, pages]);

  const previewHtml = currentPage?.clonedHtml || '';

  // Build a srcdoc-friendly HTML payload. For very large HTML we truncate
  // to 1MB so the iframe doesn't choke; the user sees enough to confirm.
  const iframeSrcDoc = useMemo(() => {
    if (!previewHtml) return '';
    const truncated = previewHtml.length > 1_000_000
      ? previewHtml.slice(0, 1_000_000) + '<!-- truncated for preview -->'
      : previewHtml;
    // Inject a tiny CSS to keep the embedded page from interfering with our
    // overlay (no scroll lock), and a non-interactive overlay to prevent
    // accidental clicks while it's still being rewritten.
    return truncated.replace(
      /<head[^>]*>/i,
      (m) => `${m}<style>html,body{margin:0;padding:0}body{pointer-events:none;user-select:none}</style>`,
    );
  }, [previewHtml]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-[#05070d]/97 backdrop-blur-md flex flex-col text-white">
      {/* TOP BAR ────────────────────────────────────────────── */}
      <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between gap-4 bg-gradient-to-r from-fuchsia-950/40 via-violet-950/30 to-indigo-950/40">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-fuchsia-500 to-violet-600 flex items-center justify-center shadow-lg shadow-fuchsia-500/30">
            {isRunning ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight">
              {isSwipeAll ? 'Swipe All' : 'Rewrite'}
              <span className="ml-2 text-white/50 font-normal text-xs">
                {isRunning ? 'in progress\u2026' : (cancelRequested ? 'cancelled' : 'finished')}
              </span>
            </h2>
            <p className="text-xs text-white/60 truncate">
              {isSwipeAll
                ? `Page ${swipeAll!.currentIndex || completed}/${total} \u2014 ${currentPageName}`
                : currentPageName}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Stat icon={<Clock className="w-3.5 h-3.5" />} label="Elapsed" value={fmtDuration(elapsedSec)} />
          {etaSec !== null && (
            <Stat icon={<Sparkles className="w-3.5 h-3.5" />} label="ETA" value={`~${fmtDuration(etaSec)}`} />
          )}
          <Stat icon={<CheckCircle2 className="w-3.5 h-3.5" />} label="Done" value={`${completed}/${total}`} highlight={completed === total && total > 0} />
          {(swipeAll?.errors?.length ?? 0) > 0 && (
            <Stat icon={<AlertCircle className="w-3.5 h-3.5" />} label="Errors" value={String(swipeAll!.errors.length)} danger />
          )}

          {isRunning ? (
            <button
              onClick={onCancel}
              disabled={cancelRequested}
              className="ml-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-red-600/90 hover:bg-red-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cancelRequested ? 'Cancelling\u2026' : 'Cancel'}
            </button>
          ) : (
            <button
              onClick={onClose}
              className="ml-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-white/10 hover:bg-white/15 text-white transition-colors"
            >
              <X className="w-3.5 h-3.5" /> Close
            </button>
          )}
        </div>
      </div>

      {/* OVERALL PROGRESS BAR ────────────────────────────────── */}
      <div className="px-6 pt-3">
        <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-fuchsia-500 via-violet-500 to-indigo-500 transition-all duration-500"
            style={{ width: `${overallPct}%` }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between text-[10px] text-white/50">
          <span>{overallPct}% overall</span>
          <span>{stepLabel}</span>
        </div>
      </div>

      {/* MAIN GRID ───────────────────────────────────────────── */}
      <div className={`flex-1 grid gap-4 px-6 py-4 overflow-hidden min-h-0 ${
        isSwipeAll ? 'grid-cols-[260px_1fr_360px]' : 'grid-cols-[1fr_360px]'
      }`}>
        {/* LEFT — pages list (Swipe All only) */}
        {isSwipeAll && (
          <PagesSidebar
            pages={pages}
            currentPageName={swipeAll?.currentPageName}
            currentIndex={swipeAll?.currentIndex || 0}
          />
        )}

        {/* CENTER — live preview iframe */}
        <PreviewPanel
          srcDoc={iframeSrcDoc}
          batchProgress={batchProgress}
          stepLabel={stepLabel}
          isRunning={isRunning}
        />

        {/* RIGHT — activity log */}
        <ActivityLog log={log} logRef={logRef} />
      </div>

      {/* BOTTOM ─────────────────────────────────────────────── */}
      <div className="px-6 py-2 border-t border-white/10 bg-black/40 flex items-center justify-between text-[11px] text-white/50">
        <span>
          Powered by Claude Sonnet 4 \u00b7 Jina rescue \u00b7 Smart KB routing per page-type
        </span>
        <span className="font-mono">
          {log.length} events
        </span>
      </div>
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function Stat({
  icon, label, value, highlight, danger,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  highlight?: boolean;
  danger?: boolean;
}) {
  const cls = danger
    ? 'bg-red-950/50 border-red-700/40 text-red-200'
    : highlight
      ? 'bg-emerald-950/50 border-emerald-700/40 text-emerald-200'
      : 'bg-white/5 border-white/10 text-white/80';
  return (
    <div className={`px-2.5 py-1 rounded-md border flex items-center gap-1.5 ${cls}`}>
      <span className="opacity-80">{icon}</span>
      <span className="text-[10px] uppercase tracking-wider opacity-60">{label}</span>
      <span className="text-xs font-mono font-semibold">{value}</span>
    </div>
  );
}

function PagesSidebar({
  pages, currentPageName, currentIndex,
}: {
  pages: SwipePageInfo[];
  currentPageName?: string;
  currentIndex: number;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-white/10 bg-white/[0.04] flex items-center gap-2">
        <Layers className="w-3.5 h-3.5 text-white/60" />
        <span className="text-xs font-medium text-white/80">Funnel pages</span>
        <span className="ml-auto text-[10px] text-white/40 font-mono">{pages.length}</span>
      </div>
      <div className="overflow-auto divide-y divide-white/5 flex-1">
        {pages.map((p, idx) => {
          const isCurrent = p.name === currentPageName;
          const status = p.swipeStatus || 'pending';
          return (
            <div
              key={p.id}
              className={`px-3 py-2 flex items-center gap-2 transition-colors ${
                isCurrent ? 'bg-fuchsia-500/10 border-l-2 border-fuchsia-400' : ''
              }`}
            >
              <span className="text-[10px] font-mono text-white/40 w-5">{idx + 1}.</span>
              <PageStatusIcon status={status} isCurrent={isCurrent} />
              <div className="min-w-0 flex-1">
                <div className={`text-xs truncate ${isCurrent ? 'text-white font-medium' : 'text-white/70'}`}>
                  {p.name}
                </div>
                {p.pageType && (
                  <div className="text-[10px] text-white/40 truncate">{p.pageType}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-3 py-2 border-t border-white/10 bg-white/[0.02] text-[10px] text-white/50 font-mono">
        Step {currentIndex} / {pages.length}
      </div>
    </div>
  );
}

function PageStatusIcon({ status, isCurrent }: { status: string; isCurrent: boolean }) {
  if (status === 'completed') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />;
  if (status === 'failed') return <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />;
  if (isCurrent || status === 'in_progress') return <Loader2 className="w-3.5 h-3.5 text-fuchsia-400 animate-spin flex-shrink-0" />;
  return <div className="w-3.5 h-3.5 rounded-full border border-white/20 flex-shrink-0" />;
}

function PreviewPanel({
  srcDoc, batchProgress, stepLabel, isRunning,
}: {
  srcDoc: string;
  batchProgress: { done: number; total: number; pct: number } | null;
  stepLabel: string;
  isRunning: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden flex flex-col min-h-0 relative">
      <div className="px-3 py-2 border-b border-white/10 bg-white/[0.04] flex items-center gap-2">
        <FileCode2 className="w-3.5 h-3.5 text-white/60" />
        <span className="text-xs font-medium text-white/80">Live preview</span>
        <span className="text-[10px] text-white/40">{stepLabel}</span>
        {batchProgress && (
          <span className="ml-auto text-[10px] font-mono text-white/60">
            {batchProgress.done}/{batchProgress.total} texts
          </span>
        )}
      </div>

      {/* Iframe area */}
      <div className="relative flex-1 bg-white">
        {srcDoc ? (
          <>
            <iframe
              srcDoc={srcDoc}
              className="absolute inset-0 w-full h-full border-0"
              sandbox="allow-same-origin"
              title="Live preview"
            />
            {isRunning && (
              <>
                {/* Animated scanning line — feels like the page is being analysed */}
                <div className="pointer-events-none absolute inset-0 overflow-hidden">
                  <div className="absolute left-0 right-0 h-[120px] bg-gradient-to-b from-transparent via-fuchsia-400/15 to-transparent animate-[scan_3s_ease-in-out_infinite]" />
                </div>
                {/* Subtle dim overlay */}
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-fuchsia-500/[0.02] via-transparent to-violet-500/[0.02]" />
              </>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm bg-[#0a0d18]">
            <div className="text-center">
              <Zap className="w-10 h-10 mx-auto mb-2 text-fuchsia-400/60 animate-pulse" />
              <div className="text-white/60">Cloning competitor page\u2026</div>
              <div className="text-[11px] text-white/30 mt-1">Preview will appear once the HTML is captured</div>
            </div>
          </div>
        )}
      </div>

      {/* Per-batch progress */}
      {batchProgress && (
        <div className="px-3 py-2 border-t border-white/10 bg-black/40">
          <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-400 to-cyan-400 transition-all duration-500"
              style={{ width: `${batchProgress.pct}%` }}
            />
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-white/50 font-mono">
            <span>{batchProgress.pct}% texts rewritten on this page</span>
            <span>{batchProgress.done}/{batchProgress.total}</span>
          </div>
        </div>
      )}

      <style jsx>{`
        @keyframes scan {
          0%   { top: -120px; }
          50%  { top: 100%; }
          100% { top: -120px; }
        }
      `}</style>
    </div>
  );
}

function ActivityLog({
  log, logRef,
}: {
  log: SwipeLogEntry[];
  logRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-white/10 bg-white/[0.04] flex items-center gap-2">
        <PenLine className="w-3.5 h-3.5 text-white/60" />
        <span className="text-xs font-medium text-white/80">Activity</span>
        <span className="ml-auto text-[10px] text-white/40 font-mono">{log.length}</span>
      </div>
      <div ref={logRef} className="flex-1 overflow-auto px-3 py-2 space-y-1 font-mono text-[11px]">
        {log.length === 0 ? (
          <div className="text-white/30 italic">Waiting for activity\u2026</div>
        ) : (
          log.map((e) => <LogLine key={e.id} entry={e} />)
        )}
      </div>
    </div>
  );
}

function LogLine({ entry }: { entry: SwipeLogEntry }) {
  const colorByKind: Record<SwipeLogKind, string> = {
    info: 'text-white/70',
    progress: 'text-cyan-300',
    success: 'text-emerald-300',
    warn: 'text-amber-300',
    error: 'text-red-300',
    rewrite: 'text-fuchsia-300',
  };
  const time = new Date(entry.at);
  const t = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
  return (
    <div className={`flex items-start gap-2 leading-relaxed ${colorByKind[entry.kind]}`}>
      <span className="text-white/30 flex-shrink-0">{t}</span>
      {entry.pageName && (
        <span className="text-white/40 flex-shrink-0 max-w-[80px] truncate" title={entry.pageName}>
          {entry.pageName}
        </span>
      )}
      <span className="break-words">{entry.message}</span>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${pad(s)}s`;
}

function labelForStep(step: SwipeAllStep): string {
  switch (step) {
    case 'cloning': return 'Cloning page\u2026';
    case 'rewriting': return 'Rewriting with Claude\u2026';
    case 'narrative': return 'Extracting narrative for funnel coherence\u2026';
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
    default: return '';
  }
}

function labelForCloneProgress(p: CloneProgressShape): string {
  if (p.phase === 'extract') return 'Extracting texts\u2026';
  if (p.phase === 'translating') return 'Translating\u2026';
  return 'Rewriting with Claude\u2026';
}
