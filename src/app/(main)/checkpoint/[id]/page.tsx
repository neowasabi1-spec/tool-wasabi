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
  Stethoscope,
  X,
} from 'lucide-react';
import {
  type CheckpointCategory,
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
  params: { id: string } | Promise<{ id: string }>;
}) {
  // Next.js 14 hands a plain object here; Next.js 15 will hand a
  // Promise. Calling `use()` on a non-Promise throws React #438, so
  // we guard explicitly.
  const resolvedParams = params instanceof Promise ? use(params) : params;
  const funnelId = resolvedParams.id;

  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // Visual fetch diagnostic — lets the user see WHICH path the
  // SPA-aware fetcher took (plain fetch / Playwright / Jina / failed)
  // without having to dig into Netlify Function logs.
  interface DiagResult {
    ok: boolean;
    source: string | null;
    wasSpa: boolean;
    htmlLength: number;
    durationMs: number;
    attempts: string[];
    error: string | null;
    htmlPreview: string;
    env?: {
      NETLIFY: string | null;
      VERCEL: string | null;
      AWS_LAMBDA_FUNCTION_NAME: string | null;
      NODE_VERSION: string;
      isServerless: boolean;
    };
  }
  const [diag, setDiag] = useState<DiagResult | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  // Live state during a polling-driven run.
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>(() =>
    buildSteps(CATEGORIES),
  );
  const [liveActiveIdx, setLiveActiveIdx] = useState(-1);
  const [liveResults, setLiveResults] = useState<CheckpointResults>({});
  const [liveStartedAt, setLiveStartedAt] = useState<number | undefined>();
  const abortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Cleanup polling timer on unmount.
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  /**
   * Polling loop. Reads the in-progress run row every `intervalMs`
   * and translates `results` JSONB into the LiveStep[] dashboard.
   * Stops when the row's status leaves `running` (or after `maxMs`
   * as a safety net so we never poll forever).
   */
  const pollRun = async (
    runId: string,
    intervalMs = 1500,
    maxMs = 6 * 60 * 1000,
  ): Promise<void> => {
    const startedPolling = Date.now();
    const tick = async (): Promise<void> => {
      if (Date.now() - startedPolling > maxMs) {
        console.warn(`[checkpoint poll] giving up on ${runId} after ${maxMs}ms`);
        return;
      }
      try {
        const res = await fetch(`/api/checkpoint/runs/${runId}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          // Run not found yet (race) → try again.
          pollTimerRef.current = setTimeout(tick, intervalMs);
          return;
        }
        const { run } = (await res.json()) as { run: CheckpointRun | null };
        if (!run) {
          pollTimerRef.current = setTimeout(tick, intervalMs);
          return;
        }
        applyRunSnapshot(run);
        if (run.status === 'running') {
          pollTimerRef.current = setTimeout(tick, intervalMs);
        }
      } catch (err) {
        console.warn('[checkpoint poll] tick failed', err);
        pollTimerRef.current = setTimeout(tick, intervalMs * 2);
      }
    };
    return tick();
  };

  /**
   * Translate a polled run row into the dashboard's local state.
   * Each category in `results` becomes a `done`/`error` step; the
   * first category that hasn't reported yet is treated as the one
   * the bot is currently working on.
   */
  const applyRunSnapshot = (run: CheckpointRun) => {
    setActiveRunId(run.id);
    setLiveResults(run.results ?? {});

    const stillRunning = run.status === 'running';
    const next: LiveStep[] = CATEGORIES.map((category) => {
      const result = run.results?.[category];
      if (!result) {
        return { category, state: 'pending' as const };
      }
      return {
        category,
        state:
          result.status === 'error' ? ('error' as const) : ('done' as const),
        result,
      };
    });

    let activeIdx = -1;
    if (stillRunning) {
      activeIdx = next.findIndex((s) => s.state === 'pending');
      if (activeIdx >= 0) {
        next[activeIdx] = {
          ...next[activeIdx],
          state: 'running',
          startedAt:
            liveSteps[activeIdx]?.startedAt ?? Date.now(),
        };
      }
    }

    setLiveSteps(next);
    setLiveActiveIdx(activeIdx);
  };

  /**
   * Click handler. Kicks off the POST /run (which blocks until the
   * full audit completes) AND a polling loop in parallel. The
   * polling loop discovers the runId from /latest-run within ~1s of
   * the POST landing on the server, then tracks incremental DB
   * updates so the UI lights up step-by-step in near real time.
   */
  const handleDiagnose = async () => {
    if (!data?.funnel.url) return;
    setDiagLoading(true);
    setDiagOpen(true);
    setDiag(null);
    try {
      const res = await fetch('/api/checkpoint/diagnose-fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: data.funnel.url }),
      });
      const body = (await res.json()) as DiagResult & { error?: string };
      setDiag(body);
    } catch (err) {
      setDiag({
        ok: false,
        source: null,
        wasSpa: false,
        htmlLength: 0,
        durationMs: 0,
        attempts: [],
        error: err instanceof Error ? err.message : String(err),
        htmlPreview: '',
      });
    } finally {
      setDiagLoading(false);
    }
  };

  const handleRun = async () => {
    setRunning(true);
    setRunError(null);
    setLiveResults({});
    setLiveSteps(buildSteps(CATEGORIES));
    setLiveActiveIdx(-1);
    setLiveStartedAt(Date.now());

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Start polling in parallel — it'll discover the runId via
    // /latest-run as soon as the server inserts the row, even if the
    // POST response is still pending (or buffered by the platform).
    const pollerStarted = startPollingForLatestRun(ctrl.signal);

    try {
      const res = await fetch(`/api/checkpoint/${funnelId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          triggeredByName: getCurrentUserName(),
        }),
        signal: ctrl.signal,
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = (json as { error?: string }).error ?? `HTTP ${res.status}`;
        throw new Error(message);
      }
      // POST returned with the final state — ensure the polled view
      // reflects it (in case the last poll tick was missed).
      const final = json as {
        runId?: string;
        status?: string;
        score_overall?: number | null;
        results?: CheckpointResults;
      };
      if (final.results) setLiveResults(final.results);
      if (final.runId) setActiveRunId(final.runId);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setRunError("Run interrotta dall'utente.");
      } else {
        setRunError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      // Stop polling, allow any in-flight final tick to settle.
      await pollerStarted;
      stopPolling();
      setRunning(false);
      setLiveActiveIdx(-1);
      abortRef.current = null;
      await refetch(true);
    }
  };

  /**
   * Look up the most recent run for this funnel until we find one
   * created after we clicked "Run". Then switch to per-runId polling.
   */
  const startPollingForLatestRun = async (signal: AbortSignal) => {
    const clickedAt = Date.now();
    const giveUpAt = clickedAt + 30_000;
    while (!signal.aborted && Date.now() < giveUpAt) {
      try {
        const res = await fetch(
          `/api/checkpoint/${funnelId}/latest-run`,
          { cache: 'no-store', signal },
        );
        if (res.ok) {
          const { run } = (await res.json()) as { run: CheckpointRun | null };
          // Only accept a run whose created_at is fresher than the
          // moment we clicked — otherwise we'd attach to an old run.
          if (run && new Date(run.created_at).getTime() >= clickedAt - 2000) {
            applyRunSnapshot(run);
            await pollRun(run.id);
            return;
          }
        }
      } catch {
        // Abort or network blip — fall through to the delay.
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  };

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    stopPolling();
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
            {/* Diagnose: shows whether the SPA fallback is needed for
                this URL, which strategy worked (fetch / Playwright /
                Jina) and how many chars the audit will see. Surface
                level for the user — no Netlify-log digging. */}
            {!running && (
              <button
                onClick={handleDiagnose}
                disabled={diagLoading}
                className="inline-flex items-center gap-2 px-3 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50"
                title="Verifica come viene scaricato l'HTML di questa pagina"
              >
                {diagLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Stethoscope className="w-4 h-4" />
                )}
                Diagnosi
              </button>
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

      {diagOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setDiagOpen(false)}
        >
          <div
            className="bg-white rounded-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <Stethoscope className="w-5 h-5" /> Diagnosi fetch HTML
              </h3>
              <button
                onClick={() => setDiagOpen(false)}
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3 text-sm">
              <div className="text-gray-600">
                URL:{' '}
                <span className="font-mono text-xs break-all">
                  {data?.funnel.url}
                </span>
              </div>
              {diagLoading && (
                <div className="flex items-center gap-2 text-gray-700">
                  <Loader2 className="w-4 h-4 animate-spin" /> Sto provando a
                  scaricare l&apos;HTML…
                </div>
              )}
              {!diagLoading && diag && (
                <>
                  <div
                    className={`rounded-lg p-3 border ${
                      diag.ok
                        ? 'bg-green-50 border-green-200 text-green-900'
                        : 'bg-red-50 border-red-200 text-red-900'
                    }`}
                  >
                    {diag.ok ? (
                      <>
                        <div className="font-semibold">
                          Fetch riuscito ({diag.htmlLength.toLocaleString()}{' '}
                          caratteri in {(diag.durationMs / 1000).toFixed(1)}s)
                        </div>
                        <div className="mt-1">
                          Strategia usata: <strong>{diag.source}</strong>
                          {diag.wasSpa && ' — pagina rilevata come SPA'}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="font-semibold">Fetch fallito</div>
                        <div className="mt-1">{diag.error || 'Errore sconosciuto.'}</div>
                      </>
                    )}
                  </div>

                  {diag.env && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs">
                      <div className="font-semibold text-blue-900 mb-1">
                        Ambiente:{' '}
                        {diag.env.isServerless
                          ? 'serverless (Netlify/Lambda)'
                          : 'locale (npm run dev)'}
                      </div>
                      <div className="text-blue-800 font-mono">
                        NETLIFY={String(diag.env.NETLIFY)} | NODE=
                        {diag.env.NODE_VERSION}
                      </div>
                    </div>
                  )}

                  {diag.attempts.length > 0 && (
                    <div>
                      <div className="font-medium text-gray-800 mb-1">
                        Tentativi:
                      </div>
                      <ol className="list-decimal pl-5 space-y-1 text-gray-700">
                        {diag.attempts.map((a, i) => (
                          <li key={i} className="font-mono text-xs">
                            {a}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {diag.htmlPreview && (
                    <details className="bg-gray-50 rounded-lg p-3">
                      <summary className="cursor-pointer text-gray-700 font-medium">
                        Anteprima HTML (primi 1500 caratteri)
                      </summary>
                      <pre className="mt-2 text-xs bg-white p-2 rounded border overflow-x-auto whitespace-pre-wrap">
                        {diag.htmlPreview}
                      </pre>
                    </details>
                  )}

                  <div className="text-xs text-gray-500 border-t pt-2">
                    <strong>Cosa significa:</strong>
                    <ul className="list-disc pl-5 mt-1 space-y-0.5">
                      <li>
                        <code>fetch</code> = la pagina è server-rendered, fetch
                        normale OK
                      </li>
                      <li>
                        <code>playwright-spa</code> = la pagina è una SPA, il
                        browser headless ha funzionato
                      </li>
                      <li>
                        <code>jina-spa-fallback</code> = Playwright è fallito,
                        Jina Reader ha salvato il giorno
                      </li>
                      <li>
                        <code>fetch-spa-failed</code> = SPA ma nessun fallback
                        ha funzionato (audit avrà solo la shell vuota)
                      </li>
                    </ul>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
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
