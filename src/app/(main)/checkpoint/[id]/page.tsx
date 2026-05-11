'use client';

import { useState, useEffect, useMemo, useRef, use } from 'react';
import Link from 'next/link';
import Header from '@/components/Header';
import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Clock,
  AlertCircle,
  StopCircle,
} from 'lucide-react';
import {
  type CheckpointCategory,
  type CheckpointCategoryResult,
  type CheckpointResults,
  type CheckpointRun,
  type CheckpointFunnel,
} from '@/types/checkpoint';
import { getCurrentUserName } from '@/lib/current-user';
import LiveStepDashboard, {
  buildSteps,
  type LiveStep,
} from '@/components/checkpoint/LiveStepDashboard';
import FindingsTable from '@/components/checkpoint/FindingsTable';

const CATEGORIES: CheckpointCategory[] = [
  'cro',
  'coherence',
  'tov',
  'compliance',
  'copy',
];

interface DetailResponse {
  funnel: CheckpointFunnel;
  runs: CheckpointRun[];
}

export default function CheckpointDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: funnelId } = use(params);

  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  // Live state during an active SSE-driven run.
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>(() =>
    buildSteps(CATEGORIES),
  );
  const [liveActiveIdx, setLiveActiveIdx] = useState(-1);
  const [liveResults, setLiveResults] = useState<CheckpointResults>({});
  const [liveStartedAt, setLiveStartedAt] = useState<number | undefined>();
  const abortRef = useRef<AbortController | null>(null);

  const refetch = async (preserveActive = false) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/checkpoint/${funnelId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as DetailResponse;
      setData(payload);
      if (!preserveActive && payload.runs.length > 0) {
        setActiveRunId(payload.runs[0].id);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [funnelId]);

  /**
   * Open the SSE stream and drive the live dashboard. Each event from
   * the server moves a step from pending → running → done so the user
   * literally watches the bot work through the queue.
   */
  const handleRun = async () => {
    setRunning(true);
    setRunError(null);
    setLiveResults({});
    setLiveSteps(buildSteps(CATEGORIES));
    setLiveActiveIdx(-1);
    setLiveStartedAt(Date.now());

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch(`/api/checkpoint/${funnelId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          triggeredByName: getCurrentUserName(),
        }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        let message = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(text);
          if (parsed?.error) message = parsed.error;
        } catch {
          if (text) message = text.slice(0, 300);
        }
        throw new Error(message);
      }

      // Read SSE events from the body stream. Server frames each event
      // as `data: <json>\n\n`. Buffer across chunks because reads can
      // split mid-event.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          // Each frame may have multiple `data:` lines; concatenate them.
          const json = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          if (!json) continue;
          try {
            const evt = JSON.parse(json);
            handleEvent(evt);
          } catch (err) {
            console.warn('[checkpoint stream] bad JSON frame', err, json);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setRunError('Run interrotta dall\'utente.');
      } else {
        setRunError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      // Reload history so the new run appears in the selector.
      await refetch(true);
    }
  };

  const handleEvent = (evt: {
    phase: string;
    runId?: string;
    category?: CheckpointCategory;
    index?: number;
    total?: number;
    result?: CheckpointCategoryResult;
    status?: string;
    score_overall?: number | null;
    results?: CheckpointResults;
    message?: string;
  }) => {
    switch (evt.phase) {
      case 'opened':
        if (evt.runId) setActiveRunId(evt.runId);
        break;
      case 'category_start':
        if (typeof evt.index === 'number') {
          setLiveActiveIdx(evt.index);
          setLiveSteps((prev) =>
            prev.map((s, i) =>
              i === evt.index ? { ...s, state: 'running' } : s,
            ),
          );
        }
        break;
      case 'category_done':
        if (
          typeof evt.index === 'number' &&
          evt.category &&
          evt.result
        ) {
          const cat = evt.category;
          const result = evt.result;
          setLiveResults((prev) => ({ ...prev, [cat]: result }));
          setLiveSteps((prev) =>
            prev.map((s, i) =>
              i === evt.index
                ? {
                    ...s,
                    state: result.status === 'error' ? 'error' : 'done',
                    result,
                  }
                : s,
            ),
          );
          setLiveActiveIdx(-1);
        }
        break;
      case 'complete':
        if (evt.results) setLiveResults(evt.results);
        setLiveActiveIdx(-1);
        break;
      case 'error':
        setRunError(evt.message ?? 'Errore stream sconosciuto');
        break;
      default:
        break;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const activeRun = useMemo(() => {
    if (!data) return null;
    return (
      data.runs.find((r) => r.id === activeRunId) ?? data.runs[0] ?? null
    );
  }, [data, activeRunId]);

  // The dashboard always has SOMETHING to show:
  //   - if a run is in progress, show the live state
  //   - else if a historical run is selected, show its frozen state
  //   - else show 5 pending placeholders
  const dashboardSteps: LiveStep[] = useMemo(() => {
    if (running) return liveSteps;
    if (activeRun) return buildSteps(CATEGORIES, activeRun.results);
    return buildSteps(CATEGORIES);
  }, [running, liveSteps, activeRun]);

  const dashboardResults: CheckpointResults = useMemo(() => {
    if (running) return liveResults;
    if (activeRun) return activeRun.results;
    return {};
  }, [running, liveResults, activeRun]);

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header title="Checkpoint" subtitle="Caricamento..." />
        <div className="p-12 text-center">
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-500" />
        </div>
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header title="Checkpoint" subtitle="Errore" />
        <div className="p-6">
          <Link
            href="/checkpoint"
            className="inline-flex items-center gap-2 text-sm text-blue-600 hover:underline mb-4"
          >
            <ArrowLeft className="w-4 h-4" /> Torna alla lista
          </Link>
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            <strong>Errore:</strong> {loadError ?? 'Funnel non trovato'}
          </div>
        </div>
      </div>
    );
  }

  const { funnel } = data;
  const overallScore = running
    ? computeOverall(liveResults)
    : activeRun?.score_overall ?? null;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header title={funnel.name} subtitle={funnel.url || 'Senza URL'} />

      <div className="px-6 py-6 space-y-6">
        {/* Top bar */}
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <Link
            href="/checkpoint"
            className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-blue-600"
          >
            <ArrowLeft className="w-4 h-4" /> Lista checkpoint
          </Link>
          <div className="flex items-center gap-2">
            {funnel.url && (
              <a
                href={funnel.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-3 py-2 bg-white border border-gray-300 text-sm text-gray-700 rounded-lg hover:bg-gray-50"
              >
                <ExternalLink className="w-4 h-4" /> Apri pagina
              </a>
            )}
            {running ? (
              <button
                onClick={handleStop}
                className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700"
              >
                <StopCircle className="w-4 h-4" />
                Interrompi
              </button>
            ) : (
              <button
                onClick={handleRun}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
              >
                {data.runs.length > 0 ? (
                  <>
                    <RefreshCw className="w-4 h-4" /> Ri-esegui Checkpoint
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" /> Esegui Checkpoint
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {runError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <strong>Run fallita:</strong> {runError}
            </div>
          </div>
        )}

        {/* Funnel meta strip */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-gray-500">URL:</span>
          <code className="text-xs bg-gray-100 px-2 py-0.5 rounded truncate max-w-[460px]">
            {funnel.url}
          </code>
          <span className="text-gray-300">·</span>
          <span className="text-gray-500">Aggiunto:</span>
          <span className="text-gray-700">
            {formatDateTime(funnel.created_at)}
          </span>
          <span className="text-gray-300">·</span>
          <span className="text-gray-500">
            {data.runs.length} run in storia
          </span>
        </div>

        {/* History selector — hidden during active runs to keep the
            dashboard front-and-center. */}
        {!running && data.runs.length > 1 && (
          <div className="bg-white rounded-lg border border-gray-200 p-3">
            <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">
              Storico run
            </div>
            <div className="flex flex-wrap gap-2">
              {data.runs.map((r, idx) => {
                const isActive = r.id === activeRun?.id;
                return (
                  <button
                    key={r.id}
                    onClick={() => setActiveRunId(r.id)}
                    className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                      isActive
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-blue-400'
                    }`}
                  >
                    <span className="font-medium">
                      {idx === 0 ? 'Ultima' : `#${data.runs.length - idx}`}
                    </span>{' '}
                    · {formatDateTime(r.created_at)} ·{' '}
                    {r.score_overall ?? '–'}/100
                    {r.triggered_by_name && (
                      <span className="opacity-70"> · {r.triggered_by_name}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty state when there are no runs yet AND we're not running. */}
        {!running && !activeRun && data.runs.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <HelpCircle className="w-10 h-10 mx-auto text-gray-300" />
            <h3 className="mt-3 font-medium text-gray-700">
              Nessun checkpoint ancora
            </h3>
            <p className="text-sm text-gray-500 mt-1 max-w-md mx-auto">
              Premi <strong>Esegui Checkpoint</strong> per lanciare l&apos;audit
              su CRO, Coerenza, Tone of Voice, Compliance e Copy Quality.
              Vedrai il bot lavorare step-by-step.
            </p>
          </div>
        ) : (
          <>
            {/* Score banner */}
            {!running && activeRun && (
              <ScoreBanner run={activeRun} />
            )}

            {/* Live / frozen step dashboard */}
            <LiveStepDashboard
              steps={dashboardSteps}
              isRunning={running}
              activeIndex={liveActiveIdx}
              startedAt={liveStartedAt}
            />

            {/* Aggregated findings */}
            <FindingsTable results={dashboardResults} />
          </>
        )}
      </div>
    </div>
  );
}

function ScoreBanner({ run }: { run: CheckpointRun }) {
  const overall = run.score_overall;
  const Icon =
    overall === null
      ? HelpCircle
      : overall >= 80
        ? CheckCircle2
        : overall >= 50
          ? AlertTriangle
          : XCircle;
  const cls =
    overall === null
      ? 'from-gray-50 to-white text-gray-600'
      : overall >= 80
        ? 'from-emerald-50 to-white text-emerald-700'
        : overall >= 50
          ? 'from-amber-50 to-white text-amber-700'
          : 'from-red-50 to-white text-red-700';

  return (
    <div
      className={`bg-gradient-to-r ${cls} rounded-xl border border-gray-200 p-5 flex flex-wrap items-center gap-6`}
    >
      <Icon className="w-10 h-10 shrink-0" />
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-500">
          Score complessivo · ultima run
        </div>
        <div className="text-4xl font-bold">
          {overall !== null ? overall : '–'}
          <span className="text-base text-gray-400 font-normal">/100</span>
        </div>
      </div>
      <div className="text-xs text-gray-500 flex flex-col gap-1 ml-auto">
        <span className="inline-flex items-center gap-1">
          <Clock className="w-3 h-3" />
          Eseguito {formatDateTime(run.created_at)}
        </span>
        {run.completed_at && (
          <span>
            Completato in {durationSec(run.created_at, run.completed_at)}s
          </span>
        )}
        {run.triggered_by_name && (
          <span>
            Da <strong className="text-gray-700">{run.triggered_by_name}</strong>
          </span>
        )}
      </div>
    </div>
  );
}

function computeOverall(results: CheckpointResults): number | null {
  const scores = Object.values(results)
    .map((r) => r?.score)
    .filter((s): s is number => typeof s === 'number');
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('it-IT', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function durationSec(startIso: string, endIso: string): number {
  try {
    return Math.round(
      (new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000,
    );
  } catch {
    return 0;
  }
}
