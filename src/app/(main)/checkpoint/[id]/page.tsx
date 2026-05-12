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
  Code2,
  Megaphone,
  Eye,
  ListChecks,
  Crown,
  Lightbulb,
  Activity,
  Zap,
  Inbox,
  Bot,
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

// v2: the audit pipeline runs three categories. The legacy ones
// (cro, tov, compliance) are still in the type union for historical
// runs but we don't queue them by default any more.
const CATEGORIES: CheckpointCategory[] = ['navigation', 'coherence', 'copy'];

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

  // Which engine performs the audit. 'claude' = built-in Anthropic
  // pipeline (in-process, blocking, bound by the platform's serverless
  // timeout). 'openclaw:neo' / 'openclaw:morfeo' = enqueue the work to
  // the matching local OpenClaw worker via openclaw_messages
  // (target_agent column does the routing — no race between Neo and
  // Morfeo). Persisted in localStorage so refreshes don't reset the
  // user's choice.
  type AuditorOption = 'claude' | 'openclaw:neo' | 'openclaw:morfeo';
  const [auditor, setAuditor] = useState<AuditorOption>('claude');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem('checkpoint:auditor');
    if (saved === 'claude' || saved === 'openclaw:neo' || saved === 'openclaw:morfeo') {
      setAuditor(saved);
    }
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('checkpoint:auditor', auditor);
  }, [auditor]);

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

  // Activity feed: every transition we OBSERVE during polling becomes
  // a line in the monitor below. This is the user's window into "is
  // the auditor actually working or stuck?".
  type ActivityLevel = 'info' | 'success' | 'warn' | 'error';
  interface ActivityEvent {
    ts: number;
    level: ActivityLevel;
    message: string;
  }
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [lastChangeAt, setLastChangeAt] = useState<number | null>(null);
  const prevRunRef = useRef<CheckpointRun | null>(null);
  const lastChangeAtRef = useRef<number | null>(null);

  // OpenClaw queue status: tells us if the worker has even SEEN the
  // job yet. Without this the UI looks frozen for the first ~3-15s
  // while the worker's poll loop discovers the new pending row.
  interface QueueStatus {
    found: boolean;
    status?: 'pending' | 'processing' | 'completed' | 'error';
    target_agent?: string | null;
    error_message?: string | null;
    age_seconds?: number;
  }
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const queuePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastQueueStatusRef = useRef<string | null>(null);

  const pushEvent = (level: ActivityLevel, message: string) => {
    setEvents((prev) =>
      [...prev, { ts: Date.now(), level, message }].slice(-80),
    );
    lastChangeAtRef.current = Date.now();
    setLastChangeAt(lastChangeAtRef.current);
  };

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
      if (queuePollRef.current) clearInterval(queuePollRef.current);
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
   *
   * Side effect: diff against the previously-observed snapshot and
   * emit an activity event for every transition (new category result,
   * status change, etc.). This is what powers the activity monitor
   * below the dashboard so the user can SEE work happening.
   */
  const applyRunSnapshot = (run: CheckpointRun) => {
    setActiveRunId(run.id);
    setLiveResults(run.results ?? {});

    // ── Diff against last snapshot to extract events ───────────────
    const prev = prevRunRef.current;
    const isNewRun = !prev || prev.id !== run.id;
    if (isNewRun) {
      pushEvent(
        'info',
        `Run #${run.id.slice(0, 8)} osservata (status: ${run.status})`,
      );
    }
    if (prev && prev.id === run.id) {
      // Status transitions
      if (prev.status !== run.status) {
        if (run.status === 'completed') {
          pushEvent(
            'success',
            `Run completata · score finale ${run.score_overall ?? '–'}/100`,
          );
        } else if (run.status === 'failed') {
          pushEvent(
            'error',
            `Run fallita${run.error ? `: ${run.error}` : ''}`,
          );
        } else if (run.status === 'partial') {
          pushEvent(
            'warn',
            'Run completata parzialmente — alcune categorie hanno avuto errori',
          );
        }
      }
    }
    // New category results that just landed in this poll
    for (const cat of CATEGORIES) {
      const before = prev?.results?.[cat];
      const after = run.results?.[cat];
      if (!before && after) {
        if (after.status === 'error') {
          pushEvent('error', `${cat} · errore: ${after.error ?? 'sconosciuto'}`);
        } else if (after.status === 'skipped') {
          pushEvent('warn', `${cat} · skippata (${after.summary || 'non applicabile'})`);
        } else {
          pushEvent(
            'success',
            `${cat} · completata (${after.score ?? '–'}/100, ${after.issues?.length ?? 0} criticità, ${after.suggestions?.length ?? 0} azioni)`,
          );
        }
      }
    }
    prevRunRef.current = run;

    // ── Translate to LiveStep[] for the existing dashboard ─────────
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

    // Reset activity feed for this fresh run.
    setEvents([]);
    prevRunRef.current = null;
    lastChangeAtRef.current = Date.now();
    setLastChangeAt(lastChangeAtRef.current);
    setQueueStatus(null);
    lastQueueStatusRef.current = null;
    pushEvent('info', `Run avviata · auditor: ${auditorLabel(auditor)}`);

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
          auditor,
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
      if (final.runId) {
        setActiveRunId(final.runId);
        // For OpenClaw audits the POST returns instantly with the
        // runId and the heavy work happens in the worker — start a
        // dedicated queue poller so we can show "in coda → preso →
        // processing" before the first category lands.
        if (auditor.startsWith('openclaw:')) {
          startQueuePolling(final.runId);
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setRunError("Run interrotta dall'utente.");
        pushEvent('warn', "Run interrotta dall'utente");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setRunError(msg);
        pushEvent('error', `POST /run fallita: ${msg}`);
      }
    } finally {
      // Stop polling, allow any in-flight final tick to settle.
      await pollerStarted;
      stopPolling();
      stopQueuePolling();
      setRunning(false);
      setLiveActiveIdx(-1);
      abortRef.current = null;
      await refetch(true);
    }
  };

  /**
   * For OpenClaw audits the work happens off-platform in a Node worker
   * polling `openclaw_messages`. The dashboard is otherwise blind to
   * "has the worker even noticed the new row yet?" — this poller
   * fills that gap by hitting /queue-status every 1.5s and emitting
   * an event whenever the message's status changes
   * (pending → processing → completed/error).
   */
  const startQueuePolling = (runId: string) => {
    stopQueuePolling();
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/checkpoint/runs/${runId}/queue-status`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const data = (await res.json()) as QueueStatus;
        setQueueStatus(data);
        if (!data.found || !data.status) return;
        if (lastQueueStatusRef.current !== data.status) {
          const target = data.target_agent ?? 'worker';
          if (data.status === 'pending') {
            pushEvent(
              'info',
              `In coda OpenClaw · in attesa che ${target} prenda il job…`,
            );
          } else if (data.status === 'processing') {
            pushEvent('success', `${target} ha preso il job · sta processando`);
          } else if (data.status === 'completed') {
            pushEvent('success', `${target} · prep completato lato worker`);
          } else if (data.status === 'error') {
            pushEvent(
              'error',
              `${target} · errore worker: ${data.error_message ?? 'sconosciuto'}`,
            );
          }
          lastQueueStatusRef.current = data.status;
        }
      } catch {
        // Network blip — silent retry on next interval.
      }
    };
    tick();
    queuePollRef.current = setInterval(tick, 1500);
  };

  const stopQueuePolling = () => {
    if (queuePollRef.current) {
      clearInterval(queuePollRef.current);
      queuePollRef.current = null;
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

  const pageCount = funnel.pages?.length ?? 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title={funnel.name}
        subtitle={
          pageCount > 1
            ? `Funnel multi-step · ${pageCount} pagine in sequenza`
            : funnel.url || 'Senza URL'
        }
      />

      <div className="px-6 py-6 space-y-6">
        {/* Funnel steps overview — visible whenever the funnel has
            more than one page so the user can see the full sequence
            the audit will walk through. */}
        {pageCount > 1 && (
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-900">
                Sequenza del funnel ({pageCount} step)
              </h3>
              <span className="text-xs text-gray-500">
                Il check &quot;Navigazione&quot; verifica le transizioni 1→{pageCount}.
              </span>
            </div>
            <ol className="space-y-1.5">
              {funnel.pages.map((p, i) => (
                <li
                  key={`${i}-${p.url}`}
                  className="flex items-start gap-3 text-sm"
                >
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold flex items-center justify-center mt-0.5">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    {p.name && (
                      <div className="font-medium text-gray-800 truncate">
                        {p.name}
                      </div>
                    )}
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-gray-500 hover:text-blue-600 break-all flex items-start gap-1"
                    >
                      <ExternalLink className="w-3 h-3 shrink-0 mt-0.5" />
                      <span className="break-all">{p.url}</span>
                    </a>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

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
              <div className="inline-flex rounded-lg shadow-sm overflow-hidden">
                <select
                  value={auditor}
                  onChange={(e) => setAuditor(e.target.value as AuditorOption)}
                  className="px-3 py-2 bg-white border border-r-0 border-gray-300 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-l-lg"
                  title="Chi esegue l'audit (Neo/Morfeo girano sui PC OpenClaw)"
                >
                  <option value="claude">Claude (built-in)</option>
                  <option value="openclaw:neo">Neo (OpenClaw)</option>
                  <option value="openclaw:morfeo">Morfeo (OpenClaw)</option>
                </select>
                <button
                  onClick={handleRun}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 rounded-r-lg"
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
              </div>
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

            {/* Live activity monitor — shows the user WHAT is happening
                second by second (auditor selected, queue pickup, each
                category landing/erroring, stalled detection). Stays
                mounted after the run completes so the user can scroll
                back through what happened. Resets on next Run. */}
            <RunActivityMonitor
              isRunning={running}
              auditor={auditor}
              events={events}
              lastChangeAt={lastChangeAt}
              startedAt={liveStartedAt ?? null}
              queueStatus={queueStatus}
            />

            {/* Live / frozen step dashboard */}
            <LiveStepDashboard
              steps={dashboardSteps}
              isRunning={running}
              activeIndex={liveActiveIdx}
              startedAt={liveStartedAt}
            />

            {/* "Foglio" findings: 5 colonne, una per step di analisi.
                Si popolano in tempo reale durante l'audit con le
                criticità (issues critical/warning) trovate per ogni
                categoria. Mapping di partenza:
                  Tech/Detail → navigation
                  Marketing   → copy
                  Visual      → coherence
                  Copy Chief  → cro (legacy column re-purposed)
                  All Step    → unione di tutte le categorie eseguite */}
            <FindingsSheet
              results={dashboardResults}
              isRunning={running}
            />

            {/* "Cose da fare": checklist unica con tutte le riscritture
                proposte dall'audit (Ora è → Cambialo in). Sta sotto
                la tabella, raggruppata per colonna/categoria. */}
            <ActionChecklist
              results={dashboardResults}
              isRunning={running}
              runId={activeRun?.id ?? null}
            />
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

function auditorLabel(a: 'claude' | 'openclaw:neo' | 'openclaw:morfeo'): string {
  if (a === 'claude') return 'Claude (built-in)';
  if (a === 'openclaw:neo') return 'Neo (OpenClaw)';
  if (a === 'openclaw:morfeo') return 'Morfeo (OpenClaw)';
  return a;
}

function formatHms(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatHmsShort(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function formatTime(ts: number): string {
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

/**
 * RunActivityMonitor — live "what is the auditor doing right now?"
 * panel. Sits between the score banner and the LiveStepDashboard.
 *
 * Three signals to the user:
 *   1. Header: which auditor is running, current state badge,
 *      elapsed time (ticks every 1s), seconds since last activity.
 *   2. Stalled warning: if `running` and no observed change for >25s,
 *      a yellow banner suggests checking the worker / Netlify logs.
 *   3. Console-style event feed: every transition observed by the
 *      polling loop becomes a colored line with a timestamp.
 *
 * Stays mounted after the run completes so the user can scroll the
 * history of what happened. Resets on the next "Run".
 */
function RunActivityMonitor({
  isRunning,
  auditor,
  events,
  lastChangeAt,
  startedAt,
  queueStatus,
}: {
  isRunning: boolean;
  auditor: 'claude' | 'openclaw:neo' | 'openclaw:morfeo';
  events: Array<{ ts: number; level: 'info' | 'success' | 'warn' | 'error'; message: string }>;
  lastChangeAt: number | null;
  startedAt: number | null;
  queueStatus: { found: boolean; status?: string; target_agent?: string | null } | null;
}) {
  // Tick every second to keep the elapsed clock fresh.
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  // Auto-scroll feed to bottom when new events arrive.
  const feedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events.length]);

  if (!isRunning && events.length === 0) return null;

  const elapsedMs = startedAt ? nowTs - startedAt : 0;
  const sinceLastMs = lastChangeAt ? nowTs - lastChangeAt : 0;
  const stalled = isRunning && sinceLastMs > 25_000;

  // Header state badge.
  let stateBadge: { label: string; cls: string; icon: React.ReactNode };
  if (!isRunning) {
    stateBadge = {
      label: 'completata',
      cls: 'bg-emerald-100 text-emerald-700 border-emerald-200',
      icon: <CheckCircle2 className="w-3.5 h-3.5" />,
    };
  } else if (stalled) {
    stateBadge = {
      label: 'nessuna risposta',
      cls: 'bg-amber-100 text-amber-700 border-amber-200',
      icon: <AlertTriangle className="w-3.5 h-3.5" />,
    };
  } else if (
    auditor.startsWith('openclaw:') &&
    queueStatus?.found &&
    queueStatus.status === 'pending'
  ) {
    stateBadge = {
      label: `in coda · attesa ${queueStatus.target_agent ?? 'worker'}`,
      cls: 'bg-blue-100 text-blue-700 border-blue-200',
      icon: <Inbox className="w-3.5 h-3.5" />,
    };
  } else {
    stateBadge = {
      label: 'in elaborazione',
      cls: 'bg-blue-100 text-blue-700 border-blue-200',
      icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    };
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 bg-gradient-to-r from-slate-50 to-white flex flex-wrap items-center gap-3">
        <Activity className="w-4 h-4 text-slate-500 shrink-0" />
        <h3 className="text-sm font-semibold text-gray-900">Attività audit</h3>

        <span
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold border ${stateBadge.cls}`}
        >
          {stateBadge.icon}
          {stateBadge.label}
        </span>

        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-700 border border-slate-200">
          <Bot className="w-3.5 h-3.5" />
          {auditorLabel(auditor)}
        </span>

        {startedAt && (
          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-mono text-gray-700"
            title="Tempo dall'avvio della run"
          >
            <Clock className="w-3.5 h-3.5 text-gray-400" />
            {formatHms(elapsedMs)}
          </span>
        )}

        {isRunning && lastChangeAt && (
          <span
            className={`inline-flex items-center gap-1.5 text-[11px] ${stalled ? 'text-amber-700 font-semibold' : 'text-gray-500'}`}
            title="Tempo trascorso dall'ultima attività osservata"
          >
            <Zap className="w-3.5 h-3.5" />
            ultimo aggiornamento {formatHmsShort(sinceLastMs)} fa
          </span>
        )}
      </div>

      {stalled && (
        <div className="px-4 py-2 border-b border-amber-200 bg-amber-50 text-xs text-amber-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <strong>Nessun aggiornamento da {formatHmsShort(sinceLastMs)}.</strong>{' '}
            {auditor.startsWith('openclaw:')
              ? `Verifica che il worker ${queueStatus?.target_agent ?? auditor.split(':')[1]} sia avviato (terminale Cursor con "node openclaw-worker.js"). Se è online il job potrebbe richiedere ancora qualche secondo.`
              : "L'API Claude potrebbe essere lenta o la function su Netlify è andata in timeout (504). Il run continua in background, riprova fra poco a refreshare la pagina."}
          </div>
        </div>
      )}

      <div
        ref={feedRef}
        className="max-h-56 overflow-y-auto bg-slate-950 text-slate-200 font-mono text-[11px] leading-relaxed px-3 py-2"
      >
        {events.length === 0 ? (
          <div className="text-slate-500 italic">In attesa del primo evento…</div>
        ) : (
          events.map((ev, i) => (
            <div key={i} className="flex gap-2 items-start">
              <span className="text-slate-500 shrink-0">{formatTime(ev.ts)}</span>
              <span
                className={`shrink-0 w-3 text-center ${
                  ev.level === 'success'
                    ? 'text-emerald-400'
                    : ev.level === 'error'
                      ? 'text-red-400'
                      : ev.level === 'warn'
                        ? 'text-amber-400'
                        : 'text-sky-400'
                }`}
              >
                {ev.level === 'success' ? '✓' : ev.level === 'error' ? '✗' : ev.level === 'warn' ? '!' : '·'}
              </span>
              <span className="text-slate-200 break-words">{ev.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** "Foglio" findings: 4 colonne (Tech/Detail · Marketing · Visual ·
 *  All Step) che si popolano in tempo reale durante l'audit con le
 *  criticità trovate. Ogni colonna è una mini-tabella con header
 *  sticky + righe numerate. Il mapping categorie → colonne è
 *  configurato in SHEET_COLUMNS qui sotto.
 *
 *  Per popolarsi senza ulteriore polling, usa direttamente
 *  `results` (CheckpointResults) e `isRunning`, gli stessi dati che
 *  alimentavano FindingsTable e LiveStepDashboard. */
type SheetAccent = 'blue' | 'emerald' | 'violet' | 'amber' | 'gray';

interface SheetColumnConfig {
  id: 'tech' | 'marketing' | 'visual' | 'copychief' | 'all';
  title: string;
  icon: React.ReactNode;
  accent: SheetAccent;
  /** Categorie sorgenti da cui pescare le issues. '*' include
   *  qualunque categoria presente in results (deduplicato per titolo). */
  sources: CheckpointCategory[] | '*';
}

const SHEET_COLUMNS: SheetColumnConfig[] = [
  {
    id: 'tech',
    title: 'Tech/Detail',
    icon: <Code2 className="w-4 h-4" />,
    accent: 'blue',
    sources: ['navigation'],
  },
  {
    id: 'marketing',
    title: 'Marketing',
    icon: <Megaphone className="w-4 h-4" />,
    accent: 'emerald',
    sources: ['copy'],
  },
  {
    id: 'visual',
    title: 'Visual',
    icon: <Eye className="w-4 h-4" />,
    accent: 'violet',
    sources: ['coherence'],
  },
  {
    id: 'copychief',
    title: 'Copy Chief',
    icon: <Crown className="w-4 h-4" />,
    accent: 'amber',
    sources: ['cro'],
  },
  {
    id: 'all',
    title: 'All Step',
    icon: <ListChecks className="w-4 h-4" />,
    accent: 'gray',
    sources: '*',
  },
];

interface SheetRow {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail?: string;
  sourceCategory: CheckpointCategory;
}

/** "Cose da fare" row: a concrete rewrite proposed by the audit.
 *  When `currentText` + `targetText` are present we render the
 *  before/after pair; otherwise we fall back to title + detail. */
interface SheetActionRow {
  title: string;
  detail?: string;
  currentText?: string;
  targetText?: string;
  sourceCategory: CheckpointCategory;
}

function FindingsSheet({
  results,
  isRunning,
}: {
  results: CheckpointResults;
  isRunning: boolean;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-gray-200">
        {SHEET_COLUMNS.map((col) => (
          <SheetColumn
            key={col.id}
            config={col}
            results={results}
            isRunning={isRunning}
          />
        ))}
      </div>
    </div>
  );
}

function SheetColumn({
  config,
  results,
  isRunning,
}: {
  config: SheetColumnConfig;
  results: CheckpointResults;
  isRunning: boolean;
}) {
  // Categorie effettivamente analizzate per questa colonna.
  const sourceCats: CheckpointCategory[] =
    config.sources === '*'
      ? (Object.keys(results) as CheckpointCategory[])
      : config.sources;

  // Aggrega tutte le issues critical+warning dalle categorie sorgenti.
  // Per "All Step" deduplichiamo per titolo per non ripetere lo stesso
  // problema due volte se più categorie l'hanno sollevato.
  const seen = new Set<string>();
  const rows: SheetRow[] = [];
  for (const cat of sourceCats) {
    const r = results[cat];
    if (!r || !Array.isArray(r.issues)) continue;
    for (const iss of r.issues) {
      if (iss.severity === 'info') continue;
      const dedupeKey = `${iss.severity}::${iss.title.toLowerCase()}`;
      if (config.sources === '*' && seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      rows.push({
        severity: iss.severity,
        title: iss.title,
        detail: iss.detail,
        sourceCategory: cat,
      });
    }
  }
  rows.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.title.localeCompare(b.title),
  );

  // Stato della colonna per il badge in header.
  // - in corso (almeno una source è running senza risultato ancora)
  // - completata (tutte le source hanno una risposta)
  // - vuota (nessuna source ha risultati)
  const sourcesWithResult = sourceCats.filter((c) => results[c]);
  const allDone =
    sourcesWithResult.length > 0 &&
    sourcesWithResult.length === sourceCats.length;
  const status: 'idle' | 'running' | 'done' = isRunning
    ? sourcesWithResult.length === 0
      ? 'running'
      : allDone
        ? 'done'
        : 'running'
    : sourcesWithResult.length > 0
      ? 'done'
      : 'idle';

  const headerBg =
    config.accent === 'blue'
      ? 'bg-blue-50 text-blue-700'
      : config.accent === 'emerald'
        ? 'bg-emerald-50 text-emerald-700'
        : config.accent === 'violet'
          ? 'bg-violet-50 text-violet-700'
          : config.accent === 'amber'
            ? 'bg-amber-50 text-amber-700'
            : 'bg-gray-50 text-gray-700';

  return (
    <div className="flex flex-col min-h-[260px]">
      {/* Header sticky in cima alla colonna */}
      <div
        className={`px-3 py-2 border-b border-gray-200 flex items-center justify-between gap-2 ${headerBg}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0">{config.icon}</span>
          <span className="font-semibold text-sm truncate">{config.title}</span>
        </div>
        <SheetStatusBadge status={status} count={rows.length} />
      </div>

      {/* Body: ANALISI (righe stile foglio con le criticità) */}
      <div className="flex-1">
        <div className="divide-y divide-gray-100 overflow-y-auto max-h-[320px]">
          {rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-gray-400">
              {status === 'idle' && 'In attesa di analisi…'}
              {status === 'running' && (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Analisi in corso…
                </span>
              )}
              {status === 'done' && 'Nessuna criticità trovata.'}
            </div>
          ) : (
            rows.map((row, i) => (
              <SheetRowView key={`${config.id}-${i}`} index={i + 1} row={row} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * "Cose da fare" — single checklist that lives below the findings
 * sheet. Aggregates suggestions from ALL categories, groups them by
 * the column they would have shown up in (Tech/Marketing/Visual/Copy
 * Chief), and renders each one as a checkable card with the
 * "Ora è → Cambialo in" rewrite, plus a copy-to-clipboard button on
 * the target text. Checked state is persisted in localStorage keyed
 * by runId so toggles survive refreshes for that specific run.
 */
function ActionChecklist({
  results,
  isRunning,
  runId,
}: {
  results: CheckpointResults;
  isRunning: boolean;
  runId: string | null;
}) {
  // Build grouped action rows. A category belongs to a column based
  // on the same SHEET_COLUMNS mapping used above (excluding "all"
  // which is just a union view).
  const grouped = useMemo(() => {
    type Group = {
      id: string;
      title: string;
      icon: React.ReactNode;
      accent: SheetAccent;
      actions: SheetActionRow[];
    };
    const out: Group[] = [];
    for (const col of SHEET_COLUMNS) {
      if (col.id === 'all') continue;
      const sources = (col.sources === '*' ? [] : col.sources) as CheckpointCategory[];
      const actions: SheetActionRow[] = [];
      const seen = new Set<string>();
      for (const cat of sources) {
        const r = results[cat];
        if (!r || !Array.isArray(r.suggestions)) continue;
        for (const sug of r.suggestions) {
          const key = (sug.title || '').toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          actions.push({
            title: sug.title,
            detail: sug.detail,
            currentText: sug.currentText,
            targetText: sug.targetText,
            sourceCategory: cat,
          });
        }
      }
      if (actions.length > 0) {
        out.push({
          id: col.id,
          title: col.title,
          icon: col.icon,
          accent: col.accent,
          actions,
        });
      }
    }
    return out;
  }, [results]);

  const totalActions = grouped.reduce((acc, g) => acc + g.actions.length, 0);

  // Persist per-run checkbox state in localStorage.
  const storageKey = runId ? `checkpoint:done:${runId}` : null;
  const [done, setDone] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') {
      setDone({});
      return;
    }
    try {
      const raw = window.localStorage.getItem(storageKey);
      setDone(raw ? (JSON.parse(raw) as Record<string, boolean>) : {});
    } catch {
      setDone({});
    }
  }, [storageKey]);
  const toggleDone = (key: string) => {
    setDone((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (storageKey && typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // localStorage full / private mode — silently ignore.
        }
      }
      return next;
    });
  };

  const completed = grouped.reduce((acc, g) => {
    return (
      acc +
      g.actions.reduce(
        (a, act) => (done[`${g.id}::${act.title.toLowerCase()}`] ? a + 1 : a),
        0,
      )
    );
  }, 0);

  // Empty state — nothing to do yet (still running or no rewrites).
  if (totalActions === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center gap-2 mb-2">
          <Lightbulb className="w-5 h-5 text-amber-500" />
          <h3 className="font-semibold text-gray-900">Cose da fare</h3>
        </div>
        <div className="text-sm text-gray-500">
          {isRunning ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              In arrivo… le riscritture concrete compariranno qui mano a mano
              che le categorie completano l&apos;analisi.
            </span>
          ) : (
            "Nessuna azione consigliata per quest'ultima run."
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 bg-gradient-to-r from-amber-50 to-white flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-5 h-5 text-amber-500" />
          <h3 className="font-semibold text-gray-900">Cose da fare</h3>
          <span className="text-xs text-gray-500">
            riscritture pronte da incollare in pagina
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-600">
            <strong className="text-gray-900">{completed}</strong> /{' '}
            {totalActions} completate
          </span>
          <div className="w-32 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{
                width: `${totalActions === 0 ? 0 : Math.round((completed / totalActions) * 100)}%`,
              }}
            />
          </div>
        </div>
      </div>

      <div className="divide-y divide-gray-100">
        {grouped.map((g) => (
          <div key={g.id} className="px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold ${accentChipClass(g.accent)}`}
              >
                {g.icon}
                {g.title}
              </span>
              <span className="text-[11px] text-gray-400">
                {g.actions.length} {g.actions.length === 1 ? 'azione' : 'azioni'}
              </span>
            </div>
            <ul className="space-y-2">
              {g.actions.map((act, i) => {
                const key = `${g.id}::${act.title.toLowerCase()}`;
                const isDone = !!done[key];
                return (
                  <ChecklistItem
                    key={`${g.id}-${i}`}
                    row={act}
                    isDone={isDone}
                    onToggle={() => toggleDone(key)}
                  />
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChecklistItem({
  row,
  isDone,
  onToggle,
}: {
  row: SheetActionRow;
  isDone: boolean;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const hasRewrite = !!(row.currentText && row.targetText);
  const handleCopy = async () => {
    if (!row.targetText) return;
    try {
      await navigator.clipboard.writeText(row.targetText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Browser blocked clipboard — silently no-op.
    }
  };

  return (
    <li
      className={`rounded-lg border p-3 transition-colors ${
        isDone
          ? 'bg-gray-50 border-gray-200 opacity-60'
          : 'bg-white border-gray-200 hover:border-amber-300'
      }`}
    >
      <div className="flex items-start gap-3">
        <button
          onClick={onToggle}
          className={`mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
            isDone
              ? 'bg-emerald-500 border-emerald-500'
              : 'bg-white border-gray-300 hover:border-emerald-400'
          }`}
          title={isDone ? 'Segna come da fare' : 'Segna come fatta'}
        >
          {isDone && <CheckCircle2 className="w-3 h-3 text-white" />}
        </button>
        <div className="flex-1 min-w-0 space-y-2">
          <div
            className={`text-sm font-medium leading-snug ${
              isDone ? 'line-through text-gray-500' : 'text-gray-900'
            }`}
          >
            {row.title}
          </div>
          {row.detail && (
            <div className="text-xs text-gray-500 leading-snug">
              {row.detail}
            </div>
          )}
          {hasRewrite && (
            <div className="grid sm:grid-cols-2 gap-2 mt-1">
              <div className="rounded-md border border-red-100 bg-red-50/40 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-red-600 mb-1">
                  Ora è
                </div>
                <div className="text-xs italic text-gray-700 leading-snug whitespace-pre-wrap">
                  &ldquo;{row.currentText}&rdquo;
                </div>
              </div>
              <div className="rounded-md border border-emerald-100 bg-emerald-50/40 px-3 py-2 relative">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 mb-1 flex items-center justify-between">
                  <span>Cambialo in</span>
                  <button
                    onClick={handleCopy}
                    className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 hover:text-emerald-900 underline-offset-2 hover:underline"
                  >
                    {copied ? 'copiato ✓' : 'copia'}
                  </button>
                </div>
                <div className="text-xs text-gray-800 leading-snug whitespace-pre-wrap">
                  {row.targetText}
                </div>
              </div>
            </div>
          )}
          {!hasRewrite && row.targetText && (
            <div className="rounded-md border border-emerald-100 bg-emerald-50/40 px-3 py-2 relative">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 mb-1 flex items-center justify-between">
                <span>Da aggiungere</span>
                <button
                  onClick={handleCopy}
                  className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 hover:text-emerald-900 underline-offset-2 hover:underline"
                >
                  {copied ? 'copiato ✓' : 'copia'}
                </button>
              </div>
              <div className="text-xs text-gray-800 leading-snug whitespace-pre-wrap">
                {row.targetText}
              </div>
            </div>
          )}
          <div className="text-[10px] text-gray-400 uppercase tracking-wide">
            fonte: {row.sourceCategory}
          </div>
        </div>
      </div>
    </li>
  );
}

function accentChipClass(accent: SheetAccent): string {
  switch (accent) {
    case 'blue':
      return 'bg-blue-50 text-blue-700 border border-blue-200';
    case 'emerald':
      return 'bg-emerald-50 text-emerald-700 border border-emerald-200';
    case 'violet':
      return 'bg-violet-50 text-violet-700 border border-violet-200';
    case 'amber':
      return 'bg-amber-50 text-amber-700 border border-amber-200';
    default:
      return 'bg-gray-50 text-gray-700 border border-gray-200';
  }
}

function SheetRowView({ index, row }: { index: number; row: SheetRow }) {
  const sevColor =
    row.severity === 'critical'
      ? 'text-red-600'
      : row.severity === 'warning'
        ? 'text-amber-600'
        : 'text-blue-600';
  const SevIcon =
    row.severity === 'critical'
      ? AlertCircle
      : row.severity === 'warning'
        ? AlertTriangle
        : CheckCircle2;
  return (
    <div className="px-3 py-2 hover:bg-gray-50 flex items-start gap-2">
      <span className="text-[10px] font-mono text-gray-300 w-5 text-right pt-0.5 select-none shrink-0">
        {index}
      </span>
      <SevIcon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${sevColor}`} />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-gray-900 leading-snug">
          {row.title}
        </div>
        {row.detail && (
          <div className="text-[11px] text-gray-500 mt-0.5 line-clamp-2 leading-snug">
            {row.detail}
          </div>
        )}
        <div className="text-[10px] text-gray-400 uppercase tracking-wide mt-1">
          {row.sourceCategory}
        </div>
      </div>
    </div>
  );
}

function SheetStatusBadge({
  status,
  count,
}: {
  status: 'idle' | 'running' | 'done';
  count: number;
}) {
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-white/80 text-gray-700 border border-gray-200">
        <Loader2 className="w-3 h-3 animate-spin" />
        live
      </span>
    );
  }
  if (status === 'done') {
    const tone =
      count === 0
        ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
        : 'bg-red-100 text-red-700 border-red-200';
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${tone}`}
      >
        {count} criticità
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-white/70 text-gray-400 border border-gray-200">
      idle
    </span>
  );
}

function severityRank(s: 'critical' | 'warning' | 'info'): number {
  if (s === 'critical') return 0;
  if (s === 'warning') return 1;
  return 2;
}
