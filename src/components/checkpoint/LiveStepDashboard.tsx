'use client';

import { useEffect, useState } from 'react';
import {
  Loader2,
  CheckCircle2,
  Clock,
  Bot,
} from 'lucide-react';
import {
  CHECKPOINT_CATEGORY_LABELS,
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

      {/* Progress bar — sostituisce la griglia di card per step.
          Tick verticali sopra la barra segnano i confini di ciascun
          step così si capisce a colpo d'occhio dove siamo nel run. */}
      <div className="px-5 py-4">
        {/* Tick row: una tacca per ogni categoria, colorata in base
            allo stato (done/error/active/pending). */}
        {total > 1 && (
          <div className="flex items-center gap-1 mb-2 px-px">
            {steps.map((s, i) => {
              const isActiveTick = isRunning && i === activeIndex;
              let cls = 'bg-gray-200';
              if (s.state === 'done') {
                if (s.result?.status === 'fail') cls = 'bg-red-400';
                else if (s.result?.status === 'warn') cls = 'bg-amber-400';
                else cls = 'bg-emerald-400';
              } else if (s.state === 'error') cls = 'bg-red-400';
              else if (isActiveTick) cls = 'bg-blue-500 animate-pulse';
              return (
                <div
                  key={s.category}
                  title={CHECKPOINT_CATEGORY_LABELS[s.category]}
                  className={`flex-1 h-1 rounded-full ${cls}`}
                />
              );
            })}
          </div>
        )}

        <div className="h-2.5 w-full bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ease-out ${
              isRunning
                ? 'bg-gradient-to-r from-blue-500 via-indigo-500 to-blue-500 bg-[length:200%_100%] animate-[shimmer_2s_linear_infinite]'
                : doneCount === total && total > 0
                  ? 'bg-emerald-500'
                  : 'bg-blue-500'
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>

        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="text-gray-500">
            {isRunning && activeIndex >= 0 && steps[activeIndex] ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin text-blue-600" />
                <span>
                  Step {activeIndex + 1} di {total} ·{' '}
                  <strong className="text-gray-700">
                    {CHECKPOINT_CATEGORY_LABELS[steps[activeIndex].category]}
                  </strong>{' '}
                  in analisi
                </span>
              </span>
            ) : doneCount === total && total > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-700">
                <CheckCircle2 className="w-3 h-3" />
                Tutti gli step completati
              </span>
            ) : (
              <span>
                {doneCount} di {total} step
                {total === 1 ? '' : ''} completat{doneCount === 1 ? 'o' : 'i'}
              </span>
            )}
          </span>
          <span className="font-mono text-gray-400 tabular-nums">
            {percent}%
          </span>
        </div>

        <style jsx>{`
          @keyframes shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }
        `}</style>
      </div>
    </div>
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
