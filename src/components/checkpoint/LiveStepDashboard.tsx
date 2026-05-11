'use client';

import { useEffect, useState } from 'react';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Sparkles,
  Bot,
  Target,
  Layers,
  Mic,
  Shield,
  PenLine,
} from 'lucide-react';
import {
  CHECKPOINT_CATEGORY_LABELS,
  CHECKPOINT_CATEGORY_DESCRIPTIONS,
  type CheckpointCategory,
  type CheckpointCategoryResult,
  type CheckpointResults,
} from '@/types/checkpoint';

/**
 * State of a single audit step in the live dashboard.
 *
 *   pending  → waiting in queue
 *   running  → the bot is currently working on this category
 *   done     → completed (whatever the score)
 *   error    → category-level failure
 *   skipped  → wasn't part of this run
 */
export type LiveStepState = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface LiveStep {
  category: CheckpointCategory;
  state: LiveStepState;
  result?: CheckpointCategoryResult;
  startedAt?: number; // epoch ms
  finishedAt?: number;
}

const CATEGORY_ICON: Record<CheckpointCategory, React.ComponentType<{ className?: string }>> = {
  cro: Target,
  coherence: Layers,
  tov: Mic,
  compliance: Shield,
  copy: PenLine,
};

const CATEGORY_BOT_NAME: Record<CheckpointCategory, string> = {
  cro: 'CRO Bot',
  coherence: 'Coherence Bot',
  tov: 'Voice Bot',
  compliance: 'Compliance Bot',
  copy: 'Copy Bot',
};

interface Props {
  steps: LiveStep[];
  /** True while the SSE stream is open. Drives the "bot at work"
   *  pulse and the global progress bar. */
  isRunning: boolean;
  /** When isRunning, this is the index of the currently-working step.
   *  -1 means "between steps" (nothing pulsing). */
  activeIndex: number;
  /** Optional ETA hint shown above the bar. */
  startedAt?: number;
}

export default function LiveStepDashboard({
  steps,
  isRunning,
  activeIndex,
  startedAt,
}: Props) {
  const total = steps.length;
  const doneCount = steps.filter(
    (s) => s.state === 'done' || s.state === 'error',
  ).length;
  const percent = total === 0 ? 0 : Math.round((doneCount / total) * 100);

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-blue-50 to-indigo-50">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-blue-600 text-white flex items-center justify-center shadow-sm">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-gray-900">
              {isRunning ? (
                <span className="flex items-center gap-2">
                  Audit in corso
                  <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
                </span>
              ) : doneCount === total && total > 0 ? (
                'Audit completo'
              ) : (
                'Audit pronto'
              )}
            </div>
            <div className="text-xs text-gray-500">
              {doneCount}/{total} step completati
              {isRunning && activeIndex >= 0 && steps[activeIndex] && (
                <>
                  {' '}· lavora su{' '}
                  <strong>
                    {CHECKPOINT_CATEGORY_LABELS[steps[activeIndex].category]}
                  </strong>
                </>
              )}
            </div>
          </div>
        </div>
        {startedAt && (
          <div className="text-xs text-gray-500 flex items-center gap-1">
            <Clock className="w-3 h-3" />
            <ElapsedTimer startedAt={startedAt} running={isRunning} />
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div className="px-5 pt-3">
        <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ease-out ${
              isRunning
                ? 'bg-gradient-to-r from-blue-500 via-indigo-500 to-blue-500 bg-[length:200%_100%] animate-[shimmer_2s_linear_infinite]'
                : 'bg-emerald-500'
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <style jsx>{`
          @keyframes shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }
        `}</style>
      </div>

      {/* Step grid */}
      <div className="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {steps.map((step, i) => (
          <StepCard
            key={step.category}
            step={step}
            position={i + 1}
            isActive={isRunning && i === activeIndex}
          />
        ))}
      </div>
    </div>
  );
}

function StepCard({
  step,
  position,
  isActive,
}: {
  step: LiveStep;
  position: number;
  isActive: boolean;
}) {
  const Icon = CATEGORY_ICON[step.category];
  const label = CHECKPOINT_CATEGORY_LABELS[step.category];
  const description = CHECKPOINT_CATEGORY_DESCRIPTIONS[step.category];
  const botName = CATEGORY_BOT_NAME[step.category];

  // Visual state.
  const cardCls = (() => {
    if (isActive)
      return 'border-blue-400 bg-blue-50 ring-2 ring-blue-200 shadow-lg scale-[1.02]';
    if (step.state === 'done') {
      const score = step.result?.score ?? 0;
      if (step.result?.status === 'pass')
        return 'border-emerald-300 bg-emerald-50';
      if (step.result?.status === 'warn' || (score >= 50 && score < 80))
        return 'border-amber-300 bg-amber-50';
      if (step.result?.status === 'fail' || score < 50)
        return 'border-red-300 bg-red-50';
      return 'border-gray-200 bg-white';
    }
    if (step.state === 'error') return 'border-red-200 bg-red-50';
    return 'border-gray-200 bg-gray-50/50';
  })();

  return (
    <div
      className={`rounded-lg border p-4 transition-all duration-300 relative ${cardCls}`}
    >
      <div className="absolute top-2 right-2 text-[10px] text-gray-400 font-mono">
        {String(position).padStart(2, '0')}
      </div>

      <div className="flex items-start gap-2 mb-2">
        <div
          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
            isActive
              ? 'bg-blue-600 text-white'
              : step.state === 'done'
                ? 'bg-white text-gray-700 border border-gray-200'
                : step.state === 'error'
                  ? 'bg-red-100 text-red-600'
                  : 'bg-gray-100 text-gray-400'
          }`}
        >
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-900 truncate">
            {label}
          </div>
          <div className="text-[10px] text-gray-500 truncate">{botName}</div>
        </div>
      </div>

      <StateBadge step={step} isActive={isActive} />

      <p className="mt-2 text-[11px] text-gray-500 line-clamp-2 leading-snug">
        {description}
      </p>

      {isActive && (
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-blue-700 bg-blue-100/70 rounded px-2 py-1">
          <Sparkles className="w-3 h-3 animate-pulse" />
          <span>Il bot sta analizzando...</span>
        </div>
      )}

      {step.state === 'done' && step.result && (
        <div className="mt-3 text-[11px] text-gray-600">
          {step.result.issues.length > 0 ? (
            <span>
              <strong className="text-red-600">{step.result.issues.length}</strong>{' '}
              problemi
            </span>
          ) : (
            <span className="text-emerald-700">Nessun problema</span>
          )}
          {step.result.suggestions.length > 0 && (
            <>
              {' · '}
              <strong className="text-blue-600">
                {step.result.suggestions.length}
              </strong>{' '}
              spunti
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StateBadge({
  step,
  isActive,
}: {
  step: LiveStep;
  isActive: boolean;
}) {
  if (isActive) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700">
        <Loader2 className="w-3 h-3 animate-spin" />
        In analisi...
      </span>
    );
  }
  if (step.state === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-400 font-medium">
        <Clock className="w-3 h-3" />
        In coda
      </span>
    );
  }
  if (step.state === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700">
        <XCircle className="w-3 h-3" />
        Errore
      </span>
    );
  }
  if (step.state === 'skipped') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-400">
        Saltato
      </span>
    );
  }
  // done
  const score = step.result?.score ?? null;
  const status = step.result?.status;
  if (status === 'pass' || (score !== null && score >= 80)) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700">
        <CheckCircle2 className="w-3 h-3" />
        {score}/100
      </span>
    );
  }
  if (status === 'fail' || (score !== null && score < 50)) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold text-red-700">
        <XCircle className="w-3 h-3" />
        {score}/100
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-700">
      <AlertTriangle className="w-3 h-3" />
      {score !== null ? `${score}/100` : 'Done'}
    </span>
  );
}

function ElapsedTimer({
  startedAt,
  running,
}: {
  startedAt: number;
  running: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running]);
  const sec = Math.max(0, Math.round((now - startedAt) / 1000));
  if (sec < 60) return <span>{sec}s</span>;
  return (
    <span>
      {Math.floor(sec / 60)}m {sec % 60}s
    </span>
  );
}

/** Build the initial step list from a list of categories + an
 *  optional "already-known" results object (e.g. when viewing a
 *  historical completed run). */
export function buildSteps(
  categories: CheckpointCategory[],
  results?: CheckpointResults,
): LiveStep[] {
  return categories.map((category) => {
    const result = results?.[category];
    if (!result) {
      return { category, state: 'pending' as LiveStepState };
    }
    return {
      category,
      state: result.status === 'error' ? 'error' : 'done',
      result,
    };
  });
}
