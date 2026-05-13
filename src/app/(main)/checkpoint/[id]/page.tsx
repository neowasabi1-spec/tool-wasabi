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
  SkipForward,
  Ban,
  ChevronUp,
  ChevronDown,
  Info,
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

  const refetch = async (preserveActive = false, silent = false) => {
    if (!silent) setLoading(true);
    if (!silent) setLoadError(null);
    try {
      const res = await fetch(`/api/checkpoint/${funnelId}`, {
        cache: 'no-store',
      });
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
      if (!silent) setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
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

  // Background sync: while ANY visible run is still in 'running'
  // state (or the user just clicked Run and we're waiting for the
  // first row to appear), silently re-fetch the funnel detail
  // every 2.5s. This is the "user shouldn't have to F5 to see new
  // results" safety net — it sits on top of the per-run pollRun
  // loop, so even when that loop has a hiccup (network blip, tab
  // backgrounded then refocused, deploy mid-session, etc.) the
  // dashboard still catches up. Only runs while either the local
  // state says we're running OR the most recent server snapshot
  // shows a 'running' row, and stops automatically when both are
  // false. `silent` skips the loading spinner so this never makes
  // the page flicker. We depend on a derived BOOLEAN (not on
  // `data.runs` itself) so the interval isn't torn down and
  // recreated on every refetch — only when the running-vs-done
  // state actually flips.
  const hasRunningRowFromData = useMemo(
    () => !!data?.runs.some((r) => r.status === 'running'),
    [data?.runs],
  );
  useEffect(() => {
    if (!running && !hasRunningRowFromData) return;
    const id = setInterval(() => {
      refetch(true, true).catch(() => {});
    }, 2500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, hasRunningRowFromData]);

  /**
   * Polling loop. Reads the in-progress run row every `intervalMs`
   * and translates `results` JSONB into the LiveStep[] dashboard.
   * Stops when the row's status leaves `running` (or after `maxMs`
   * as a safety net so we never poll forever, or when the supplied
   * `signal` is aborted by the user clicking Stop / leaving the page).
   *
   * Implemented as a real async while-loop (NOT setTimeout-callback
   * chaining): the previous version returned its promise as soon as
   * the FIRST tick scheduled the next one, so `await pollRun(...)`
   * resolved in ~1s and the parent finally block setRunning(false)
   * way too early. On the OpenClaw fast-fork path that meant the UI
   * marked the run "completata" verde at ~31s while the worker was
   * still in prep. With the while loop the promise resolves only
   * when the run actually reaches a terminal status, so the parent
   * setRunning(false) fires at the right moment.
   *
   * `maxMs` defaults to 12 minutes — quiz funnels with 5+ steps and
   * mobile screenshots can take 4-6 minutes wall-clock on Claude,
   * and the OpenClaw worker can take longer with Trinity-sized
   * prompts. We want the UI to wait, not give up at 6 min.
   */
  const pollRun = async (
    runId: string,
    opts: {
      intervalMs?: number;
      maxMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> => {
    const intervalMs = opts.intervalMs ?? 1500;
    const maxMs = opts.maxMs ?? 12 * 60 * 1000;
    const signal = opts.signal;
    const startedPolling = Date.now();
    let consecutiveFailures = 0;

    while (true) {
      if (signal?.aborted) {
        console.log(`[checkpoint poll] aborted by user (runId=${runId})`);
        return;
      }
      if (Date.now() - startedPolling > maxMs) {
        console.warn(
          `[checkpoint poll] giving up on ${runId} after ${maxMs}ms`,
        );
        return;
      }
      let terminal = false;
      try {
        const res = await fetch(`/api/checkpoint/runs/${runId}`, {
          cache: 'no-store',
          signal,
        });
        if (res.ok) {
          const { run } = (await res.json()) as { run: CheckpointRun | null };
          if (run) {
            applyRunSnapshot(run);
            if (run.status !== 'running') {
              terminal = true;
            }
            consecutiveFailures = 0;
          }
        }
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        consecutiveFailures++;
        console.warn(
          `[checkpoint poll] tick failed (${consecutiveFailures})`,
          err,
        );
      }
      if (terminal) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        // If we're aborted mid-sleep, resolve immediately so the
        // next iteration's signal.aborted check exits the loop.
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
    }
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
            `Run fallita${run.error && !run.error.startsWith('[stage]') ? `: ${run.error}` : ''}`,
          );
        } else if (run.status === 'partial') {
          pushEvent(
            'warn',
            'Run completata parzialmente — alcune categorie hanno avuto errori',
          );
        }
      }
      // Stage hints: while status='running' the server (ab)uses
      // `error` to broadcast prep-pipeline progress with a literal
      // "[stage] " prefix. Surface every transition as an info-line
      // in the activity feed so the user sees the page-fetch /
      // screenshot pipeline ticking instead of staring at "0/3 step
      // completati" for a minute.
      const prevStage =
        prev.status === 'running' && prev.error?.startsWith('[stage] ')
          ? prev.error.slice('[stage] '.length)
          : null;
      const currStage =
        run.status === 'running' && run.error?.startsWith('[stage] ')
          ? run.error.slice('[stage] '.length)
          : null;
      if (currStage && currStage !== prevStage) {
        pushEvent('info', `Prep · ${currStage}`);
      }
    } else if (
      run.status === 'running' &&
      run.error?.startsWith('[stage] ')
    ) {
      // First snapshot already inside prep — emit the current stage
      // line so the user sees it without waiting for the next tick.
      pushEvent('info', `Prep · ${run.error.slice('[stage] '.length)}`);
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

    // Shared ref the discovery loop reads on every tick: as soon as
    // the POST returns the runId we set this and the loop pivots
    // straight to `pollRun(runId)` without depending on the
    // created_at/clickedAt heuristic (which can fail on clock skew).
    const knownRunIdRef = { current: null as string | null };

    // Start polling in parallel — it'll discover the runId via
    // /latest-run as soon as the server inserts the row, even if the
    // POST response is still pending (or buffered by the platform).
    const pollerStarted = startPollingForLatestRun(ctrl.signal, knownRunIdRef);

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
        // Hand the runId to the discovery loop so it stops guessing
        // via /latest-run and polls THIS specific row directly.
        knownRunIdRef.current = final.runId;
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
            // The worker died/errored before it could call
            // /openclaw-finalize → the funnel_checkpoints row would
            // sit on status='running' forever and the dashboard
            // would just hang on "in corso (in background)".
            // Auto-force-fail it so the user gets a real terminal
            // status (and the column-fill-up logic in finalize
            // marks the missing categories as 'error' instead of
            // leaving them spectral). Fire-and-forget; if the
            // call fails the user can still hit the manual
            // "Marca come fallita" button in the banner.
            handleForceFail(
              runId,
              `Worker ${target} ha riportato errore: ${data.error_message ?? 'sconosciuto'}`,
            ).catch(() => {});
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
   * created after we clicked "Run", then switch to per-runId polling
   * via `pollRun` (which itself runs until terminal status).
   *
   * `giveUpAt` is 60s — generous because the OpenClaw enqueue path
   * is fast (≈500ms) but Claude's POST can take 5-10s to even
   * insert the row on cold lambda.
   *
   * `knownRunIdRef` is a fast-path: as soon as the user-facing POST
   * comes back with the runId we set this ref so this loop bypasses
   * the latest-run discovery entirely and pivots straight to
   * `pollRun(knownRunId)`. Without it, any clock skew between the
   * browser and the Supabase DB (only a few seconds is enough!)
   * makes the "created_at >= clickedAt - 2000" guard fail forever
   * → loop times out at 60s → setRunning(false) fires → UI shows
   * "polling client si è chiuso" while the run is still going.
   */
  const startPollingForLatestRun = async (
    signal: AbortSignal,
    knownRunIdRef?: { current: string | null },
  ) => {
    const clickedAt = Date.now();
    const giveUpAt = clickedAt + 60_000;
    while (!signal.aborted && Date.now() < giveUpAt) {
      // Fast path: POST already told us the runId — go directly.
      if (knownRunIdRef?.current) {
        await pollRun(knownRunIdRef.current, { signal });
        return;
      }
      try {
        const res = await fetch(
          `/api/checkpoint/${funnelId}/latest-run`,
          { cache: 'no-store', signal },
        );
        if (res.ok) {
          const { run } = (await res.json()) as { run: CheckpointRun | null };
          // Accept a run if it's still in flight (it can only be ours
          // — UI doesn't allow concurrent audits) OR if its created_at
          // is reasonably close to our click (30s tolerance to absorb
          // clock skew between browser and DB; the original 2s window
          // was way too tight and caused the loop to give up at 60s
          // even on a healthy run).
          if (
            run &&
            (run.status === 'running' ||
              new Date(run.created_at).getTime() >= clickedAt - 30_000)
          ) {
            applyRunSnapshot(run);
            // pollRun is now a real async while-loop that resolves
            // ONLY when the run reaches a terminal status (or the
            // signal is aborted, or maxMs elapses). The previous
            // setTimeout-callback impl resolved after the very first
            // tick, which broke the OpenClaw fast-fork path.
            await pollRun(run.id, { signal });
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

  /** Last-resort kill switch for runs stuck in `running`. Used when
   *  the worker died mid-job (or never picked it up) and the row
   *  hasn't been finalized — without this the badge stays on
   *  "in corso (in background)" forever. */
  const handleForceFail = async (runId: string, reason?: string) => {
    try {
      pushEvent('warn', 'Marco la run come fallita su richiesta utente…');
      const res = await fetch(
        `/api/checkpoint/runs/${runId}/force-fail`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      pushEvent('error', 'Run marcata come fallita.');
      // Stop the polling loop and refresh the row so the badge
      // and history flip to the new state immediately.
      abortRef.current?.abort();
      stopPolling();
      stopQueuePolling();
      setRunning(false);
      await refetch(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushEvent('error', `force-fail fallita: ${msg}`);
    }
  };

  const activeRun = useMemo(() => {
    if (!data) return null;
    return (
      data.runs.find((r) => r.id === activeRunId) ?? data.runs[0] ?? null
    );
  }, [data, activeRunId]);

  // The dashboard always has SOMETHING to show:
  //   - if a run is in progress, show the live state — picking
  //     whichever source is RICHER between liveResults (per-run
  //     pollRun loop, every 1.5s) and activeRun.results (background
  //     refetch, every 2.5s). They normally agree, but if pollRun
  //     hits a hiccup the background sync keeps the columns moving
  //     so the user never has to F5 to see new findings appear.
  //   - else if a historical run is selected, show its frozen state
  //   - else show 5 pending placeholders
  const dashboardResults: CheckpointResults = useMemo(() => {
    if (running) {
      const activeResults = activeRun?.results ?? {};
      const liveCount = Object.keys(liveResults).length;
      const activeCount = Object.keys(activeResults).length;
      return activeCount > liveCount ? activeResults : liveResults;
    }
    if (activeRun) return activeRun.results;
    return {};
  }, [running, liveResults, activeRun]);

  const dashboardSteps: LiveStep[] = useMemo(() => {
    if (running) {
      // Same "richest source wins" rule as dashboardResults so the
      // step states (running / done / error indicators) stay in
      // sync with the column contents.
      const liveDoneOrErr = liveSteps.filter(
        (s) => s.state === 'done' || s.state === 'error',
      ).length;
      const activeFromBg = buildSteps(CATEGORIES, activeRun?.results ?? {});
      const bgDoneOrErr = activeFromBg.filter(
        (s) => s.state === 'done' || s.state === 'error',
      ).length;
      return bgDoneOrErr > liveDoneOrErr ? activeFromBg : liveSteps;
    }
    if (activeRun) return buildSteps(CATEGORIES, activeRun.results);
    return buildSteps(CATEGORIES);
  }, [running, liveSteps, activeRun]);

  // Pull the current "[stage] …" hint out of activeRun.error while
  // the run is still running. The server uses error as a sneaky
  // progress channel during the prep phase (page fetch + screenshot
  // capture); we strip the prefix and feed the rest to the
  // dashboard so the user sees what's happening instead of a
  // static "0/N step completati".
  const prepStage: string | null = useMemo(() => {
    if (!running || !activeRun) return null;
    const err = activeRun.error;
    if (typeof err === 'string' && err.startsWith('[stage] ')) {
      return err.slice('[stage] '.length);
    }
    return null;
  }, [running, activeRun]);

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
            <ol className="space-y-2">
              {funnel.pages.map((p, i) => (
                <li
                  key={`${i}-${p.url}-${i}`}
                  className="flex items-start gap-3 text-sm"
                >
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold flex items-center justify-center mt-1">
                    {i + 1}
                  </span>
                  {p.screenshotUrl ? (
                    // For SPA quiz funnels every step shares one URL, so the
                    // thumbnail is the only visual cue distinguishing rows.
                    // Click opens full-res in a new tab.
                    // eslint-disable-next-line @next/next/no-img-element
                    <a
                      href={p.screenshotUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-shrink-0"
                      title="Apri screenshot full size"
                    >
                      <img
                        src={p.screenshotUrl}
                        alt={`Step ${i + 1}`}
                        className="w-28 h-20 object-cover object-top rounded border border-gray-200 bg-gray-50"
                        loading="lazy"
                      />
                    </a>
                  ) : null}
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
              runStatus={activeRun?.status ?? null}
              runId={activeRun?.id ?? null}
              onForceFail={handleForceFail}
            />

            {/* Live / frozen step dashboard */}
            <LiveStepDashboard
              steps={dashboardSteps}
              isRunning={running}
              activeIndex={liveActiveIdx}
              startedAt={liveStartedAt}
              prepStage={prepStage}
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
  runStatus,
  runId,
  onForceFail,
}: {
  isRunning: boolean;
  auditor: 'claude' | 'openclaw:neo' | 'openclaw:morfeo';
  events: Array<{ ts: number; level: 'info' | 'success' | 'warn' | 'error'; message: string }>;
  lastChangeAt: number | null;
  startedAt: number | null;
  queueStatus: { found: boolean; status?: string; target_agent?: string | null } | null;
  /** True terminal status of the active run (from the DB), used to
   *  pick the right "completata / fallita / parziale" badge instead
   *  of always showing "completata" green when isRunning flips false. */
  runStatus: 'running' | 'completed' | 'partial' | 'failed' | null;
  /** Active run id, needed to wire the "Marca come fallita" kill
   *  switch in the stalled banner. */
  runId: string | null;
  onForceFail: (runId: string, reason?: string) => Promise<void> | void;
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

  // Header state badge. When the run has actually terminated we
  // pick the badge from the persisted `runStatus` so a partial /
  // failed run is not falsely shown as "completata" verde just
  // because the polling loop exited.
  let stateBadge: { label: string; cls: string; icon: React.ReactNode };
  if (!isRunning) {
    if (runStatus === 'failed') {
      stateBadge = {
        label: 'fallita',
        cls: 'bg-red-100 text-red-700 border-red-200',
        icon: <XCircle className="w-3.5 h-3.5" />,
      };
    } else if (runStatus === 'partial') {
      stateBadge = {
        label: 'parziale',
        cls: 'bg-amber-100 text-amber-700 border-amber-200',
        icon: <AlertTriangle className="w-3.5 h-3.5" />,
      };
    } else if (runStatus === 'running') {
      // Polling loop dropped out (timeout / abort / page reload)
      // but the DB row says we're still going. Tell the user.
      stateBadge = {
        label: 'in corso (in background)',
        cls: 'bg-blue-100 text-blue-700 border-blue-200',
        icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
      };
    } else {
      stateBadge = {
        label: 'completata',
        cls: 'bg-emerald-100 text-emerald-700 border-emerald-200',
        icon: <CheckCircle2 className="w-3.5 h-3.5" />,
      };
    }
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
          <div className="flex-1">
            <strong>Nessun aggiornamento da {formatHmsShort(sinceLastMs)}.</strong>{' '}
            {auditor.startsWith('openclaw:')
              ? queueStatus?.status === 'error'
                ? `Il worker ${queueStatus?.target_agent ?? auditor.split(':')[1]} ha riportato un errore (${queueStatus?.error_message ?? 'sconosciuto'}). Probabile versione del worker non aggiornata: nel terminale Cursor fai "git pull" e riavvia "node openclaw-worker.js", poi rilancia l'audit.`
                : `Verifica che il worker ${queueStatus?.target_agent ?? auditor.split(':')[1]} sia avviato (terminale Cursor con "node openclaw-worker.js"). Se è online il job potrebbe richiedere ancora qualche secondo.`
              : "L'API Claude potrebbe essere lenta o la function su Netlify è andata in timeout (504). Il run continua in background, riprova fra poco a refreshare la pagina."}
          </div>
          {runId && sinceLastMs > 90_000 && (
            <button
              onClick={() => onForceFail(runId, `Run interrotta dall'utente dopo ${formatHmsShort(sinceLastMs)} di inattività.`)}
              className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded bg-red-600 text-white text-[11px] font-semibold hover:bg-red-700"
              title="Marca questa run come fallita nel DB così la UI smette di mostrarla 'in corso'"
            >
              <XCircle className="w-3 h-3" />
              Marca come fallita
            </button>
          )}
        </div>
      )}

      {/* Polling exited but DB still says 'running' (e.g. user
          reloaded the page, or the page-fetch ate the worker's
          node process and openclaw-finalize never landed). Offer
          a force-fail so the orphan row doesn't stay 'running'
          forever. */}
      {!isRunning && runStatus === 'running' && runId && (
        <div className="px-4 py-2 border-b border-blue-200 bg-blue-50 text-xs text-blue-800 flex items-start gap-2">
          <Loader2 className="w-4 h-4 shrink-0 mt-0.5 animate-spin" />
          <div className="flex-1">
            <strong>Questa run risulta ancora in corso nel DB.</strong>{' '}
            Il polling client si è chiuso ma il worker potrebbe ancora
            essere vivo (controlla il terminale dove gira{' '}
            <code className="px-1 py-0.5 rounded bg-white/70 font-mono text-[10px]">node openclaw-worker.js</code>).
            Se sei certa che sia bloccato, chiudila a forza qui sotto.
          </div>
          <button
            onClick={() => onForceFail(runId, 'Run marcata come fallita dall\'utente — DB ancora in stato running ma worker presumibilmente morto.')}
            className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded bg-red-600 text-white text-[11px] font-semibold hover:bg-red-700"
          >
            <XCircle className="w-3 h-3" />
            Marca come fallita
          </button>
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
  /** Section code parsed from the leading "[CC1] …" / "[1A] …" /
   *  "[QV-4A] …" prefix the prompts force on every issue title.
   *  When present we render it as a small uppercase pill so the
   *  user can scan the audit by checklist code (e.g. all CC* are
   *  Copy Chief findings). null when the title doesn't follow the
   *  convention. */
  sectionCode: string | null;
  /** Title with the [code] prefix stripped — used as the visible
   *  bold headline. The original raw title stays in `rawTitle`
   *  for dedup keys. */
  title: string;
  rawTitle: string;
  detail?: string;
  /** Verbatim quote of the on-page copy the issue references.
   *  Rendered as a left-bordered grey blockquote under detail
   *  when present. The prompts require this for almost every
   *  finding — without it the whole audit feels hand-wavy. */
  evidence?: string;
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

/** Pull "[CC1]" / "[1A]" / "[QV-4A]" / "[NOT VERIFIED — 1B]" out
 *  of the leading bracket, return both the bare code and the
 *  cleaned-up title so the renderer can put the code in a pill
 *  and the rest as the headline. */
function parseSectionCode(rawTitle: string): {
  sectionCode: string | null;
  cleanTitle: string;
} {
  const m = rawTitle.match(/^\[([^\]]{1,40})\]\s*/);
  if (!m) return { sectionCode: null, cleanTitle: rawTitle };
  return {
    sectionCode: m[1].trim(),
    cleanTitle: rawTitle.slice(m[0].length).trim() || rawTitle,
  };
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

  // Aggrega tutte le issues dalle categorie sorgenti, separando
  // critical+warning ("rows" = ciò che mostriamo sempre) dagli
  // info ("infoRows" = collassabili sotto un toggle "+ N punti
  // non verificati / info"). Per "All Step" deduplichiamo per
  // titolo per non ripetere lo stesso problema due volte se più
  // categorie l'hanno sollevato.
  const seen = new Set<string>();
  const rows: SheetRow[] = [];
  const infoRows: SheetRow[] = [];
  for (const cat of sourceCats) {
    const r = results[cat];
    if (!r || !Array.isArray(r.issues)) continue;
    for (const iss of r.issues) {
      const dedupeKey = `${iss.severity}::${iss.title.toLowerCase()}`;
      if (config.sources === '*' && seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const { sectionCode, cleanTitle } = parseSectionCode(iss.title);
      const row: SheetRow = {
        severity: iss.severity,
        sectionCode,
        title: cleanTitle,
        rawTitle: iss.title,
        detail: iss.detail,
        evidence: iss.evidence,
        sourceCategory: cat,
      };
      if (iss.severity === 'info') {
        infoRows.push(row);
      } else {
        rows.push(row);
      }
    }
  }
  rows.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.title.localeCompare(b.title),
  );

  // Aggrega anche le rewrite suggestions a livello colonna così
  // possiamo mostrarle DENTRO la stessa colonna invece di tenerle
  // sepolte nell'aggregato "Cose da fare". Questo è metà della
  // densità che mancava: il modello produce currentText/targetText
  // ma fino a ieri li vedevi solo nell'altra sezione, e quindi le
  // colonne sembravano "scarne".
  const suggestionRows: SheetActionRow[] = [];
  const seenSuggestions = new Set<string>();
  for (const cat of sourceCats) {
    const r = results[cat];
    if (!r || !Array.isArray(r.suggestions)) continue;
    for (const s of r.suggestions) {
      const key = `${s.title.toLowerCase()}::${(s.currentText || '').slice(0, 80)}`;
      if (config.sources === '*' && seenSuggestions.has(key)) continue;
      seenSuggestions.add(key);
      suggestionRows.push({
        title: s.title,
        detail: s.detail,
        currentText: s.currentText,
        targetText: s.targetText,
        sourceCategory: cat,
      });
    }
  }

  // Stato della colonna per il badge in header.
  //
  // Per le colonne "single-source" (Tech/Detail, Marketing, Visual,
  // Copy Chief) leggiamo lo status REALE della categoria sorgente, in
  // modo da distinguere:
  //   - 'skipped' (es. navigation richiede ≥2 pagine, qui il funnel
  //     ne ha 1) → mostriamo il summary invece del bugiardo "Nessuna
  //     criticità trovata"
  //   - 'error'  (audit fallito sul worker / parsing JSON fallito /
  //     timeout Claude) → mostriamo il messaggio di errore
  //   - 'running' (la run è ancora in corso e questa categoria non
  //     ha ancora consegnato il proprio risultato)
  //   - 'done'   (risultato presente, 0 issues critical/warning)
  //   - 'idle'   (la run non è in corso e questa categoria non ha
  //     mai prodotto un risultato — accade nelle run vecchie pre-
  //     v2 o quando il worker non ha reportato la categoria affatto)
  //
  // Per "All Step" (sources='*') manteniamo la logica semplice di
  // prima: aggrega tutto, niente skip/error a livello di colonna.
  const isAggregate = config.sources === '*';
  const sourcesWithResult = sourceCats.filter((c) => results[c]);
  const firstSourceResult = !isAggregate
    ? results[sourceCats[0]]
    : undefined;

  let status: 'idle' | 'running' | 'done' | 'skipped' | 'error';
  let stateMessage: string | undefined;
  if (!isAggregate && firstSourceResult?.status === 'skipped') {
    status = 'skipped';
    stateMessage = firstSourceResult.summary;
  } else if (!isAggregate && firstSourceResult?.status === 'error') {
    status = 'error';
    stateMessage =
      firstSourceResult.error ||
      firstSourceResult.summary ||
      'Audit fallito su questa categoria.';
  } else {
    const allDone =
      sourcesWithResult.length > 0 &&
      sourcesWithResult.length === sourceCats.length;
    status = isRunning
      ? sourcesWithResult.length === 0
        ? 'running'
        : allDone
          ? 'done'
          : 'running'
      : sourcesWithResult.length > 0
        ? 'done'
        : 'idle';
  }

  const palette = accentClasses(config.accent);

  return (
    <div className={`flex flex-col min-h-[260px] ${palette.body}`}>
      {/* Header sticky in cima alla colonna — pastello "deep" sopra
          un body pastello "soft" così la colonna intera è colorata. */}
      <div
        className={`px-3 py-2 border-b ${palette.headerBorder} flex items-center justify-between gap-2 ${palette.header} ${palette.headerText}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0">{config.icon}</span>
          <span className="font-semibold text-sm truncate">{config.title}</span>
        </div>
        <SheetStatusBadge status={status} count={rows.length} />
      </div>

      {/* Body: ANALISI (righe stile foglio con le criticità) */}
      <div className="flex-1">
        <div
          className={`overflow-y-auto max-h-[640px] ${palette.divide}`}
        >
          {rows.length === 0 && infoRows.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs">
              {status === 'idle' && (
                <span className="text-gray-500/80">In attesa di analisi…</span>
              )}
              {status === 'running' && (
                <span className="inline-flex items-center gap-1 text-gray-500/80">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Analisi in corso…
                </span>
              )}
              {status === 'done' && (
                <span className="text-gray-500/80">
                  Nessuna criticità trovata.
                </span>
              )}
              {status === 'skipped' && (
                <div className="flex flex-col items-center gap-2 px-2 text-gray-700">
                  <SkipForward className="w-4 h-4 text-gray-500" />
                  <div className="font-medium">Categoria non eseguita</div>
                  {stateMessage && (
                    <div className="text-[11px] leading-snug text-gray-600">
                      {stateMessage}
                    </div>
                  )}
                </div>
              )}
              {status === 'error' && (
                <div className="flex flex-col items-center gap-2 px-2 text-red-700">
                  <Ban className="w-4 h-4" />
                  <div className="font-medium">Audit fallito</div>
                  {stateMessage && (
                    <div className="text-[11px] leading-snug text-red-700/80 break-words">
                      {stateMessage}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              {rows.length > 0 && (
                <div className={`divide-y ${palette.divide}`}>
                  {rows.map((row, i) => (
                    <SheetRowView
                      key={`${config.id}-iss-${i}`}
                      index={i + 1}
                      row={row}
                      hoverBg={palette.rowHover}
                    />
                  ))}
                </div>
              )}

              {/* Suggestions: i fix proposti dal modello (currentText
                  → targetText) per QUESTA colonna. Il modello li
                  produce sempre ma fino a ieri venivano sepolti
                  nell'aggregato "Cose da fare" — qui li mostriamo
                  in linea sotto le criticità così la colonna è
                  completamente azionabile da sola. */}
              {suggestionRows.length > 0 && (
                <ColumnSuggestionsBlock
                  rows={suggestionRows}
                  paletteBorder={palette.headerBorder}
                />
              )}

              {/* "Punti non verificati / info" — collassabili così non
                  saturano la colonna ma sono comunque accessibili. Il
                  modello segnala con severity='info' tutti i check che
                  non riesce a verificare (head stripped, screenshot
                  assente, single-page funnel, ecc.) e averli a portata
                  di mano dimostra che l'audit è stato esaustivo, non
                  superficiale. */}
              {infoRows.length > 0 && (
                <ColumnInfoBlock
                  rows={infoRows}
                  paletteBorder={palette.headerBorder}
                  hoverBg={palette.rowHover}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Collapsible block under the issues that lists the rewrite
 *  suggestions for the same column. Each suggestion is rendered
 *  as a "Now → Change to" pair when both currentText and
 *  targetText are present (the high-value case), or as a plain
 *  title + detail otherwise (structural fixes). Open by default
 *  whenever there's at least one before/after pair so the user
 *  immediately sees the actionable copy changes. */
function ColumnSuggestionsBlock({
  rows,
  paletteBorder,
}: {
  rows: SheetActionRow[];
  paletteBorder: string;
}) {
  const hasRewrite = rows.some((r) => r.currentText && r.targetText);
  const [open, setOpen] = useState<boolean>(hasRewrite);
  return (
    <div className={`border-t-2 ${paletteBorder}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-2 flex items-center justify-between gap-2 bg-white/60 hover:bg-white/90 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <Lightbulb className="w-3.5 h-3.5 text-amber-600" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-700">
            Fix proposti · {rows.length}
          </span>
        </div>
        {open ? (
          <ChevronUp className="w-3.5 h-3.5 text-gray-500" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
        )}
      </button>
      {open && (
        <div className="divide-y divide-gray-200 bg-white/40">
          {rows.map((s, i) => (
            <div key={`sug-${i}`} className="px-3 py-2">
              <div className="text-xs font-semibold text-gray-900 leading-snug">
                {s.title}
              </div>
              {s.detail && (
                <div className="text-[11px] text-gray-600 mt-1 leading-relaxed whitespace-pre-line">
                  {s.detail}
                </div>
              )}
              {s.currentText && s.targetText && (
                <div className="mt-2 grid grid-cols-1 gap-1.5">
                  <div className="rounded border border-red-200 bg-red-50/60 px-2 py-1.5">
                    <div className="text-[9px] font-bold uppercase tracking-wider text-red-700 mb-0.5">
                      Adesso
                    </div>
                    <div className="text-[11px] text-red-900 leading-snug whitespace-pre-line">
                      {s.currentText}
                    </div>
                  </div>
                  <div className="rounded border border-emerald-200 bg-emerald-50/60 px-2 py-1.5">
                    <div className="text-[9px] font-bold uppercase tracking-wider text-emerald-700 mb-0.5">
                      Sostituisci con
                    </div>
                    <div className="text-[11px] text-emerald-900 leading-snug whitespace-pre-line">
                      {s.targetText}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Collapsible block under the issues + suggestions that lists the
 *  info-severity findings (NOT VERIFIED items, low-priority nits).
 *  Closed by default so the column stays focused on what matters,
 *  but still discoverable so the user can confirm "yes the model
 *  did think about meta tags / pixels / mobile rendering / etc." */
function ColumnInfoBlock({
  rows,
  paletteBorder,
  hoverBg,
}: {
  rows: SheetRow[];
  paletteBorder: string;
  hoverBg: string;
}) {
  const [open, setOpen] = useState(false);
  const notVerifiedCount = rows.filter(
    (r) =>
      r.title.toLowerCase().includes('not verified') ||
      r.detail?.toLowerCase().startsWith('not verified'),
  ).length;
  return (
    <div className={`border-t-2 ${paletteBorder}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-2 flex items-center justify-between gap-2 bg-white/60 hover:bg-white/90 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <Info className="w-3.5 h-3.5 text-blue-600" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-700">
            {notVerifiedCount > 0
              ? `${notVerifiedCount} non verificati · ${rows.length - notVerifiedCount} info`
              : `${rows.length} note informative`}
          </span>
        </div>
        {open ? (
          <ChevronUp className="w-3.5 h-3.5 text-gray-500" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
        )}
      </button>
      {open && (
        <div className="divide-y divide-gray-200 bg-white/40">
          {rows.map((row, i) => (
            <SheetRowView
              key={`info-${i}`}
              index={i + 1}
              row={row}
              hoverBg={hoverBg}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Pastello centralizzato per le 5 colonne dello sheet.
 *  Saturazione media: i `100` per il body sono pienamente percepibili
 *  ma non spengono il testo (testo reso a `text-{color}-900`). Gli
 *  header passano a `200` per gerarchia. Niente opacity modifier sul
 *  body così il colore arriva pieno anche su sfondi chiari del
 *  layout. Cambiare qui = cambia ovunque. */
function accentClasses(accent: SheetAccent): {
  body: string;
  header: string;
  headerText: string;
  headerBorder: string;
  divide: string;
  rowHover: string;
} {
  switch (accent) {
    case 'blue':
      return {
        body: 'bg-sky-100',
        header: 'bg-sky-200',
        headerText: 'text-sky-900',
        headerBorder: 'border-sky-300',
        divide: 'divide-sky-200/70',
        rowHover: 'hover:bg-sky-200/70',
      };
    case 'emerald':
      return {
        body: 'bg-emerald-100',
        header: 'bg-emerald-200',
        headerText: 'text-emerald-900',
        headerBorder: 'border-emerald-300',
        divide: 'divide-emerald-200/70',
        rowHover: 'hover:bg-emerald-200/70',
      };
    case 'violet':
      return {
        body: 'bg-violet-100',
        header: 'bg-violet-200',
        headerText: 'text-violet-900',
        headerBorder: 'border-violet-300',
        divide: 'divide-violet-200/70',
        rowHover: 'hover:bg-violet-200/70',
      };
    case 'amber':
      return {
        body: 'bg-amber-100',
        header: 'bg-amber-200',
        headerText: 'text-amber-900',
        headerBorder: 'border-amber-300',
        divide: 'divide-amber-200/70',
        rowHover: 'hover:bg-amber-200/70',
      };
    default:
      return {
        body: 'bg-slate-100',
        header: 'bg-slate-200',
        headerText: 'text-slate-800',
        headerBorder: 'border-slate-300',
        divide: 'divide-slate-200/70',
        rowHover: 'hover:bg-slate-200/70',
      };
  }
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

function SheetRowView({
  index,
  row,
  hoverBg = 'hover:bg-gray-50',
}: {
  index: number;
  row: SheetRow;
  /** Tailwind hover class injected by the parent column so the
   *  per-row hover stays in the same pastel family as the column. */
  hoverBg?: string;
}) {
  // Severity-driven palette: the badge, the icon, and the left
  // border all use the same colour so the user can scan the
  // column at a glance and spot critical rows immediately.
  const sevPalette =
    row.severity === 'critical'
      ? {
          icon: 'text-red-600',
          badge: 'bg-red-100 text-red-800 border-red-200',
          stripe: 'border-l-red-400',
          label: 'CRITICA',
        }
      : row.severity === 'warning'
        ? {
            icon: 'text-amber-600',
            badge: 'bg-amber-100 text-amber-800 border-amber-200',
            stripe: 'border-l-amber-400',
            label: 'WARNING',
          }
        : {
            icon: 'text-blue-600',
            badge: 'bg-blue-100 text-blue-800 border-blue-200',
            stripe: 'border-l-blue-300',
            label: 'INFO',
          };
  const SevIcon =
    row.severity === 'critical'
      ? AlertCircle
      : row.severity === 'warning'
        ? AlertTriangle
        : CheckCircle2;
  return (
    <div
      className={`px-3 py-3 border-l-4 ${sevPalette.stripe} transition-colors ${hoverBg}`}
    >
      {/* Header riga: numero · severity badge · section code pill */}
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className="text-[10px] font-mono text-gray-400 select-none">
          #{index}
        </span>
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${sevPalette.badge}`}
        >
          <SevIcon className={`w-3 h-3 ${sevPalette.icon}`} />
          {sevPalette.label}
        </span>
        {row.sectionCode && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold font-mono uppercase tracking-wider bg-gray-900 text-white">
            {row.sectionCode}
          </span>
        )}
        <span className="text-[9px] text-gray-400 uppercase tracking-wide ml-auto">
          {row.sourceCategory}
        </span>
      </div>

      {/* Title — bold headline, no clamp */}
      <div className="text-[13px] font-semibold text-gray-900 leading-snug">
        {row.title}
      </div>

      {/* Detail — FULL TEXT, no line-clamp. The model is instructed
          to write 2-4 sentences with problem + WHY + impact + fix
          direction; clamping it to 2 lines was the single biggest
          reason the audit looked "superficial" even when the AI
          had produced a dense paragraph. */}
      {row.detail && (
        <div className="text-[12px] text-gray-700 mt-1.5 leading-relaxed whitespace-pre-line">
          {row.detail}
        </div>
      )}

      {/* Evidence — verbatim quote of the on-page copy the issue
          references. Rendered as a left-bordered blockquote so it
          looks like the snippet of source it actually is. The
          prompts mandate this for almost every finding; without
          surfacing it, the audit reads as opinion instead of
          observation. */}
      {row.evidence && (
        <blockquote className="mt-2 px-2 py-1.5 border-l-2 border-gray-300 bg-gray-50/60 text-[11px] italic text-gray-600 leading-snug">
          “{row.evidence}”
        </blockquote>
      )}
    </div>
  );
}

function SheetStatusBadge({
  status,
  count,
}: {
  status: 'idle' | 'running' | 'done' | 'skipped' | 'error';
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
  if (status === 'skipped') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-white/80 text-gray-600 border border-gray-300">
        skipped
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700 border border-red-300">
        errore
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
