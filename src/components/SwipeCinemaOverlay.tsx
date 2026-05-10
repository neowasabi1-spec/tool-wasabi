'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2, X, CheckCircle2, AlertCircle, Sparkles,
  PenLine, Layers, Zap, Clock, ArrowRight,
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

/** A single (original → rewritten) pair produced by Claude during one
 *  process batch. Streamed into the overlay so the user can see the
 *  actual copy changes happening live, not just a numeric counter. */
export interface RewriteStreamEntry {
  id: number;
  at: number;
  pageName: string;
  original: string;
  rewritten: string;
}

export interface SwipeCinemaOverlayProps {
  swipeAll: SwipeAllJobShape | null;
  cloneProgress: CloneProgressShape | null;
  cloneTargetPageName?: string;
  pages: SwipePageInfo[];
  log: SwipeLogEntry[];
  rewrites?: RewriteStreamEntry[];
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
  rewrites = [],
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

        {/* CENTER — live (before → after) rewrite stream
            Replaces the old iframe preview, which was useless because it
            either showed the un-rewritten clone (confusing) or stayed
            empty for most of the process. The user wants to SEE the
            actual copy changes. */}
        <RewriteStreamPanel
          rewrites={rewrites}
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

function RewriteStreamPanel({
  rewrites, batchProgress, stepLabel, isRunning,
}: {
  rewrites: RewriteStreamEntry[];
  batchProgress: { done: number; total: number; pct: number } | null;
  stepLabel: string;
  isRunning: boolean;
}) {
  // Show the most recent rewrites at the top so the latest copy change
  // is always above the fold. We slice to the last ~80 to avoid huge
  // DOM trees on long Swipe-All runs. Memoised so we only re-reverse
  // when the array length changes.
  const recent = useMemo(() => {
    const sliced = rewrites.length > 80 ? rewrites.slice(rewrites.length - 80) : rewrites;
    return sliced.slice().reverse();
  }, [rewrites]);

  // Auto-scroll the stream container to the top on every new entry
  // (newest entries appear at the top, so scrollTop=0 is correct).
  const streamRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = 0;
  }, [rewrites.length]);

  // Pulse animation for the very first entry — gives the user a "fresh"
  // visual signal so they immediately notice each new copy change.
  const newestId = rewrites.length > 0 ? rewrites[rewrites.length - 1].id : -1;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden flex flex-col min-h-0 relative">
      <div className="px-3 py-2 border-b border-white/10 bg-white/[0.04] flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-fuchsia-300" />
        <span className="text-xs font-medium text-white/80">Live rewrites</span>
        <span className="text-[10px] text-white/40">{stepLabel}</span>
        <span className="ml-auto text-[10px] font-mono text-white/60">
          {rewrites.length} change{rewrites.length === 1 ? '' : 's'} streamed
        </span>
      </div>

      <div ref={streamRef} className="relative flex-1 overflow-auto bg-[#0a0d18]">
        {recent.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm">
            <div className="text-center max-w-sm px-6">
              {isRunning ? (
                <>
                  <Zap className="w-10 h-10 mx-auto mb-3 text-fuchsia-400/70 animate-pulse" />
                  <div className="text-white/70 font-medium">Waiting for the first batch</div>
                  <div className="text-[11px] text-white/40 mt-1.5 leading-relaxed">
                    Claude is reading the page. As soon as the first batch
                    of texts is rewritten you&apos;ll see them stream in
                    here, before&nbsp;→&nbsp;after.
                  </div>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-emerald-400/70" />
                  <div className="text-white/70 font-medium">No copy changes captured</div>
                  <div className="text-[11px] text-white/40 mt-1.5">
                    Either the page had nothing to rewrite, or the Edge
                    Function ran an older version that doesn&apos;t emit
                    per-batch previews.
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="px-3 py-3 space-y-2.5">
            {recent.map((r) => {
              const isNewest = r.id === newestId;
              return (
                <RewritePair
                  key={r.id}
                  entry={r}
                  highlight={isNewest && isRunning}
                />
              );
            })}
          </div>
        )}

        {isRunning && recent.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-fuchsia-500/[0.06] to-transparent" />
        )}
      </div>

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
    </div>
  );
}

function RewritePair({ entry, highlight }: { entry: RewriteStreamEntry; highlight: boolean }) {
  const time = new Date(entry.at);
  const ts = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
  return (
    <div
      className={`rounded-lg border p-2.5 transition-all duration-300 ${
        highlight
          ? 'border-fuchsia-400/50 bg-fuchsia-500/[0.06] shadow-[0_0_24px_-12px_rgba(232,121,249,0.6)]'
          : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.04]'
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5 text-[10px] font-mono text-white/40">
        <span>{ts}</span>
        {entry.pageName && (
          <>
            <span className="text-white/20">·</span>
            <span className="truncate max-w-[200px]" title={entry.pageName}>{entry.pageName}</span>
          </>
        )}
      </div>
      <div className="text-[12px] leading-relaxed text-red-200/85 line-through decoration-red-400/40 break-words">
        {entry.original}
      </div>
      <div className="my-1 flex items-center gap-1.5 text-[10px] text-fuchsia-300/70">
        <ArrowRight className="w-3 h-3" />
        <span className="uppercase tracking-wider">rewritten</span>
      </div>
      <div className="text-[12px] leading-relaxed text-emerald-100 font-medium break-words">
        {entry.rewritten}
      </div>
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
