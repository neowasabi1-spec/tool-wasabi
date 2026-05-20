'use client';

/**
 * Clone / Swipe Quiz — sezione separata per quiz "single-URL multi-step".
 *
 * Sono le pagine (tipicamente React SPA) dove TUTTE le domande del quiz
 * vivono sullo stesso URL e cambiano via JS quando clicchi Next. Esempio
 * canonico: lpservhub.com/s7-yp7XapLudjms/de/?affiliate=0
 *
 * Il clone tradizionale (sezione "Clone / Swipe") cattura solo lo step 1
 * perche' il restante DOM viene generato a runtime dal bundle, spesso
 * dietro fetch /api/. Per clonare l'intero quiz servono:
 *   1. un walker Playwright (worker locale) che apre la URL, clicca Next,
 *      cattura HTML+screenshot ad ogni step;
 *   2. il job viene enqueato in `funnel_crawl_jobs` con flag
 *      `captureHtml=true` (il worker quel flag lo legge e fa page.content()
 *      a ogni step in piu' rispetto al solo screenshot);
 *   3. questa pagina mostra lo stato del walk in tempo reale + l'array
 *      degli step catturati, ciascuno con anteprima e bottoni per
 *      preview / swipe (lo swipe per-step e' lo step successivo).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import Header from '@/components/Header';
import {
  HelpCircle,
  Play,
  AlertCircle,
  Sparkles,
  Loader2,
  Image as ImageIcon,
  Code,
  XCircle,
  CheckCircle,
} from 'lucide-react';

interface QuizWalkStep {
  stepIndex: number;
  url: string;
  title?: string;
  quizStepLabel?: string;
  screenshotUrl?: string | null;
  html?: string | null;
  htmlLength?: number;
  timestamp?: string;
}

interface QuizWalkResult {
  success?: boolean;
  entryUrl?: string;
  steps?: QuizWalkStep[];
  totalSteps?: number;
  durationMs?: number;
  visitedUrls?: string[];
  isQuizFunnel?: boolean;
  stopDiagnostic?: {
    reason?: string;
    atStep?: number;
    hint?: string;
  } | null;
}

type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'not_found';

interface JobSnapshot {
  ok: boolean;
  jobId: string;
  status: JobStatus;
  entryUrl: string;
  currentStep: number;
  totalSteps: number;
  result: QuizWalkResult | null;
  error: string | null;
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export default function QuizSwipePage() {
  const [url, setUrl] = useState('');
  const [maxSteps, setMaxSteps] = useState(15);
  const [jobId, setJobId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [previewStep, setPreviewStep] = useState<QuizWalkStep | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDeadlineRef = useRef<number>(0);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const pollOnce = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/walk-quiz/status/${id}`, { cache: 'no-store' });
      const ct = res.headers.get('content-type') || '';
      if (!res.ok) {
        if (res.status === 404) {
          setError('Job non trovato sul backend. Forse e\' stato cancellato.');
          stopPolling();
          return;
        }
        const body = ct.includes('application/json') ? JSON.stringify(await res.json()) : await res.text();
        setError(`Errore ${res.status}: ${body.slice(0, 300)}`);
        stopPolling();
        return;
      }
      const data = (await res.json()) as JobSnapshot;
      setSnapshot(data);

      if (data.status === 'completed' || data.status === 'failed') {
        stopPolling();
        return;
      }

      if (Date.now() > pollDeadlineRef.current) {
        setError(`Timeout: il walk non si e' completato entro ${Math.round(POLL_TIMEOUT_MS / 60000)} minuti. Il worker e\' acceso? (node openclaw-worker.js).`);
        stopPolling();
        return;
      }

      pollTimerRef.current = setTimeout(() => void pollOnce(id), POLL_INTERVAL_MS);
    } catch (e) {
      setError(`Polling fallito: ${e instanceof Error ? e.message : String(e)}`);
      stopPolling();
    }
  }, [stopPolling]);

  async function startWalk() {
    if (!url.trim()) {
      setError('Inserisci la URL del quiz.');
      return;
    }
    try {
      new URL(url.trim());
    } catch {
      setError('URL non valida.');
      return;
    }
    setError(null);
    setSnapshot(null);
    setJobId(null);
    setIsStarting(true);
    try {
      const res = await fetch('/api/walk-quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), maxSteps }),
      });
      const ct = res.headers.get('content-type') || '';
      if (!res.ok) {
        const body = ct.includes('application/json') ? JSON.stringify(await res.json()) : await res.text();
        setError(`Errore ${res.status}: ${body.slice(0, 300)}`);
        return;
      }
      if (!ct.includes('application/json')) {
        setError('Risposta non JSON dal server.');
        return;
      }
      const data = (await res.json()) as { ok?: boolean; jobId?: string; error?: string };
      if (!data.ok || !data.jobId) {
        setError(data.error || 'Risposta inattesa dal server.');
        return;
      }
      setJobId(data.jobId);
      pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
      void pollOnce(data.jobId);
    } catch (e) {
      setError(`Errore di rete: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsStarting(false);
    }
  }

  const steps = snapshot?.result?.steps ?? [];
  const isRunning = snapshot?.status === 'running' || snapshot?.status === 'pending';
  const isDone = snapshot?.status === 'completed';
  const isFailed = snapshot?.status === 'failed';
  const stopDiag = snapshot?.result?.stopDiagnostic;

  return (
    <div className="flex-1 flex flex-col bg-gray-50">
      <Header />

      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-5xl mx-auto space-y-6">
          {/* Hero */}
          <div className="bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-2xl p-6 shadow-lg">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
                <HelpCircle className="w-7 h-7" />
              </div>
              <div className="flex-1">
                <h1 className="text-2xl font-bold">Clone / Swipe Quiz</h1>
                <p className="text-white/85 text-sm mt-1 max-w-2xl">
                  Per quiz e funnel single-URL multi-step (React/Vue SPA dove tutte le
                  domande vivono sullo stesso link e cambiano via JS). Il walker apre la
                  pagina con Playwright sul worker locale, clicca Next ad ogni step,
                  cattura HTML + screenshot di ogni schermata.
                </p>
              </div>
            </div>
          </div>

          {/* Form input */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">URL del quiz</label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://esempio.com/quiz/?affiliate=0"
                disabled={isStarting || isRunning}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent disabled:opacity-60"
              />
              <p className="text-xs text-gray-500 mt-1">
                Tipico: quiz dove la URL non cambia mai mentre rispondi alle domande.
              </p>
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">
                Numero massimo di step da catturare
              </label>
              <input
                type="number"
                min={1}
                max={30}
                value={maxSteps}
                onChange={(e) => setMaxSteps(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
                disabled={isStarting || isRunning}
                className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent disabled:opacity-60"
              />
              <p className="text-xs text-gray-500 mt-1">
                Hard cap a 30 (Lambda budget). Il walker si ferma prima se non trova piu&apos;
                un Next o se vede una schermata di checkout.
              </p>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={startWalk}
                disabled={isStarting || isRunning || !url.trim()}
                className="px-5 py-2.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              >
                {isStarting || isRunning ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {isStarting ? 'Avvio job...' : `Walking step ${snapshot?.currentStep ?? 0}/${snapshot?.totalSteps ?? maxSteps}...`}
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    Walk Quiz
                  </>
                )}
              </button>

              {jobId && (
                <span className="text-xs text-gray-500 font-mono">job {jobId.slice(0, 8)}…</span>
              )}
            </div>
          </div>

          {/* Error banner */}
          {error && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-sm text-amber-900">{error}</div>
            </div>
          )}

          {/* Failed banner */}
          {isFailed && snapshot?.error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
              <XCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div className="text-sm text-red-900">
                <div className="font-semibold">Walk fallito</div>
                <div className="mt-1 break-words">{snapshot.error}</div>
              </div>
            </div>
          )}

          {/* Done banner */}
          {isDone && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              <div className="text-sm text-emerald-900">
                <div className="font-semibold">
                  Walk completato — {steps.length} step catturati
                </div>
                {stopDiag?.reason && (
                  <div className="mt-1 text-emerald-800/90">
                    Motivo stop: <code className="bg-emerald-100 px-1 rounded">{stopDiag.reason}</code>
                    {stopDiag.hint && <span className="block mt-1 italic text-xs">{stopDiag.hint}</span>}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Steps list */}
          {steps.length > 0 && (
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-purple-600" />
                  {steps.length} step
                </h2>
                {snapshot?.result?.durationMs && (
                  <span className="text-xs text-gray-500">
                    {(snapshot.result.durationMs / 1000).toFixed(1)}s
                  </span>
                )}
              </div>
              <ul className="divide-y divide-gray-100">
                {steps.map((s) => (
                  <li key={s.stepIndex} className="py-4 flex items-start gap-4">
                    <div className="w-10 h-10 rounded-lg bg-purple-100 text-purple-700 font-bold flex items-center justify-center shrink-0">
                      {s.stepIndex}
                    </div>
                    {s.screenshotUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={s.screenshotUrl}
                        alt={`Step ${s.stepIndex} screenshot`}
                        className="w-32 h-20 object-cover rounded border border-gray-200 shrink-0 bg-gray-50"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-32 h-20 rounded border border-dashed border-gray-300 flex items-center justify-center text-gray-400 shrink-0">
                        <ImageIcon className="w-5 h-5" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {s.quizStepLabel || s.title || `Step ${s.stepIndex}`}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{s.url}</p>
                      <p className="text-xs text-gray-400 mt-1">
                        HTML: {(s.htmlLength || s.html?.length || 0).toLocaleString()} chars
                        {s.html ? '' : ' (HTML non disponibile — vecchia capture senza captureHtml)'}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {s.html && (
                        <button
                          onClick={() => setPreviewStep(s)}
                          className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1.5"
                        >
                          <Code className="w-3 h-3" /> Preview
                        </button>
                      )}
                      <button
                        disabled
                        title="Swipe per step — prossimo commit"
                        className="px-3 py-1.5 text-xs bg-purple-100 text-purple-400 rounded cursor-not-allowed flex items-center gap-1.5"
                      >
                        <Sparkles className="w-3 h-3" /> Swipe (soon)
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </main>

      {/* Preview modal */}
      {previewStep && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setPreviewStep(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-[95vw] h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between bg-gradient-to-r from-purple-600 to-indigo-600">
              <div className="flex items-center gap-3 min-w-0">
                <Code className="w-5 h-5 text-white" />
                <div className="min-w-0">
                  <div className="text-white font-semibold truncate">
                    Step {previewStep.stepIndex} — {previewStep.quizStepLabel || previewStep.title}
                  </div>
                  <div className="text-white/80 text-xs truncate">{previewStep.url}</div>
                </div>
              </div>
              <button
                onClick={() => setPreviewStep(null)}
                className="text-white/80 hover:text-white text-2xl font-bold"
              >
                ×
              </button>
            </div>
            <iframe
              key={previewStep.stepIndex}
              srcDoc={previewStep.html || '<html><body>HTML non disponibile</body></html>'}
              sandbox="allow-same-origin"
              className="flex-1 w-full bg-white"
              title={`Step ${previewStep.stepIndex}`}
            />
          </div>
        </div>
      )}
    </div>
  );
}
