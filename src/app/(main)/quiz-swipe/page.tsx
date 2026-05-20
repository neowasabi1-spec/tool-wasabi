'use client';

/**
 * Clone / Swipe Quiz — sezione separata per quiz "single-URL multi-step".
 *
 * Sono le pagine (tipicamente React SPA) dove TUTTE le domande del quiz
 * vivono sullo stesso URL e cambiano via JS quando clicchi Next. Esempio
 * canonico: lpservhub.com/s7-yp7XapLudjms/de/?affiliate=0
 *
 * Pipeline:
 *   1. POST /api/walk-quiz {url, maxSteps}
 *      → inserisce funnel_crawl_jobs row con captureHtml=true
 *      → il worker locale (openclaw-worker.js, Playwright) la prende
 *      → loop "trova Next, click, cattura HTML+screenshot" fino a stop
 *   2. polling GET /api/walk-quiz/status/[jobId] ogni 1.5s
 *      → mostra gli step man mano che vengono catturati
 *   3. per ogni step, click Swipe → POST /api/walk-quiz/swipe-step
 *      → Claude riscrive i testi mantenendo struttura/CSS/HTML
 *   4. Export "single-page quiz": assembla tutti gli step swipati in
 *      un singolo HTML con script vanilla minimo per navigare i passi.
 *
 * Persistenza: il jobId viene salvato in localStorage cosi' un refresh
 * non fa perdere il walk in corso. Gli step swipati restano in memoria
 * (sessionStorage non e' adatto per HTML potenzialmente grossi).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
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
  Download,
  Wand2,
  RefreshCw,
  Trash2,
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

interface StepSwipeState {
  status: 'idle' | 'running' | 'done' | 'failed';
  swipedHtml?: string;
  replacements?: number;
  totalTexts?: number;
  error?: string;
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const LS_KEY = 'quizSwipe.activeJobId';

export default function QuizSwipePage() {
  const projects = useStore((s) => s.projects);

  const [url, setUrl] = useState('');
  const [maxSteps, setMaxSteps] = useState(15);
  const [productId, setProductId] = useState<string>('');
  const [customPrompt, setCustomPrompt] = useState('');

  const [jobId, setJobId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const [previewStep, setPreviewStep] = useState<{ step: QuizWalkStep; useSwiped: boolean } | null>(null);
  const [swipeStates, setSwipeStates] = useState<Record<number, StepSwipeState>>({});
  const [isExporting, setIsExporting] = useState(false);

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
          try { window.localStorage.removeItem(LS_KEY); } catch {}
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

  // Hydrate job-in-corso dal localStorage al primo mount: cosi' se l'utente
  // refresha la pagina mentre il worker sta ancora processando, vede
  // riprendere il polling automaticamente invece di trovare la pagina
  // vergine.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LS_KEY);
      if (saved && !jobId) {
        setJobId(saved);
        pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
        void pollOnce(saved);
      }
    } catch {
      /* localStorage non disponibile in SSR / privacy mode — non grave */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persisti jobId in localStorage ogni volta che cambia.
  useEffect(() => {
    try {
      if (jobId) window.localStorage.setItem(LS_KEY, jobId);
      else window.localStorage.removeItem(LS_KEY);
    } catch {}
  }, [jobId]);

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
    setSwipeStates({});
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

  function discardWalk() {
    stopPolling();
    setSnapshot(null);
    setJobId(null);
    setSwipeStates({});
    setError(null);
    try { window.localStorage.removeItem(LS_KEY); } catch {}
  }

  async function swipeStep(step: QuizWalkStep) {
    if (!step.html) {
      setSwipeStates((prev) => ({
        ...prev,
        [step.stepIndex]: { status: 'failed', error: 'HTML non disponibile per questo step' },
      }));
      return;
    }
    const product = projects.find((p) => p.id === productId);
    if (!product) {
      setSwipeStates((prev) => ({
        ...prev,
        [step.stepIndex]: { status: 'failed', error: 'Seleziona prima un prodotto/progetto per lo swipe.' },
      }));
      return;
    }
    setSwipeStates((prev) => ({
      ...prev,
      [step.stepIndex]: { status: 'running' },
    }));
    try {
      const res = await fetch('/api/walk-quiz/swipe-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: step.html,
          productName: product.name,
          productDescription: product.description || product.brief || '',
          customPrompt: customPrompt.trim() || undefined,
        }),
      });
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await res.json() : { ok: false, error: await res.text() };
      if (!res.ok || !data.ok) {
        setSwipeStates((prev) => ({
          ...prev,
          [step.stepIndex]: { status: 'failed', error: data.error || `HTTP ${res.status}` },
        }));
        return;
      }
      setSwipeStates((prev) => ({
        ...prev,
        [step.stepIndex]: {
          status: 'done',
          swipedHtml: data.html,
          replacements: data.replacements,
          totalTexts: data.totalTexts,
        },
      }));
    } catch (e) {
      setSwipeStates((prev) => ({
        ...prev,
        [step.stepIndex]: { status: 'failed', error: e instanceof Error ? e.message : String(e) },
      }));
    }
  }

  function exportSinglePageQuiz() {
    const steps = snapshot?.result?.steps || [];
    if (steps.length === 0) return;
    setIsExporting(true);
    try {
      // Per ogni step, prendi swipedHtml se disponibile, altrimenti html originale.
      const usable = steps.filter((s) => {
        const swiped = swipeStates[s.stepIndex]?.swipedHtml;
        return Boolean(swiped || s.html);
      });
      if (usable.length === 0) {
        setError('Nessuno step ha HTML disponibile da esportare.');
        return;
      }
      const bundle = buildSinglePageQuiz(usable, swipeStates, snapshot?.entryUrl || '');
      const blob = new Blob([bundle], { type: 'text/html' });
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u;
      const filename = (snapshot?.entryUrl || 'quiz')
        .replace(/^https?:\/\//, '')
        .replace(/[^a-z0-9]+/gi, '_')
        .slice(0, 60);
      a.download = `${filename}_quiz.html`;
      a.click();
      URL.revokeObjectURL(u);
    } finally {
      setIsExporting(false);
    }
  }

  const steps = snapshot?.result?.steps ?? [];
  const isRunning = snapshot?.status === 'running' || snapshot?.status === 'pending';
  const isDone = snapshot?.status === 'completed';
  const isFailed = snapshot?.status === 'failed';
  const stopDiag = snapshot?.result?.stopDiagnostic;
  const anySwipeDone = Object.values(swipeStates).some((s) => s.status === 'done');

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
                  cattura HTML + screenshot di ogni schermata. Poi swipi ogni step uno
                  per uno e a fine puoi esportare un singolo file HTML self-contained.
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

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">
                  Max step
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
                  Hard cap 30. Il walker si ferma prima se non trova piu&apos; Next o
                  vede checkout.
                </p>
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">
                  Prodotto target per lo swipe
                </label>
                <select
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                >
                  <option value="">— Nessuno (puoi solo clonare, non swipare) —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Claude riscrivera&apos; i testi per vendere questo prodotto.
                </p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">
                Custom prompt (opzionale)
              </label>
              <textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="es. Tono casual, niente percentuali sparate, parla in tedesco, ecc."
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
              />
            </div>

            <div className="flex items-center gap-3 pt-2 flex-wrap">
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
                <button
                  onClick={discardWalk}
                  className="px-3 py-2 text-sm text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg flex items-center gap-1.5 border border-gray-200"
                  title="Dimentica il job corrente (non lo cancella sul backend, solo localmente)"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Scarta
                </button>
              )}

              {jobId && (
                <span className="text-xs text-gray-500 font-mono">job {jobId.slice(0, 8)}…</span>
              )}
            </div>
          </div>

          {/* Error banner */}
          {error && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-sm text-amber-900 flex-1">{error}</div>
              <button onClick={() => setError(null)} className="text-amber-700 hover:text-amber-900">
                <XCircle className="w-4 h-4" />
              </button>
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
              <div className="text-sm text-emerald-900 flex-1">
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
              <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-purple-600" />
                  {steps.length} step
                </h2>
                <div className="flex items-center gap-2">
                  {snapshot?.result?.durationMs && (
                    <span className="text-xs text-gray-500">
                      {(snapshot.result.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                  {anySwipeDone && (
                    <button
                      onClick={exportSinglePageQuiz}
                      disabled={isExporting}
                      className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1.5 disabled:opacity-50"
                      title="Esporta un singolo file HTML self-contained con tutti gli step"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Esporta single-page
                    </button>
                  )}
                </div>
              </div>
              <ul className="divide-y divide-gray-100">
                {steps.map((s) => {
                  const sw = swipeStates[s.stepIndex];
                  return (
                    <li key={s.stepIndex} className="py-4 flex items-start gap-4">
                      <div className="w-10 h-10 rounded-lg bg-purple-100 text-purple-700 font-bold flex items-center justify-center shrink-0">
                        {s.stepIndex}
                      </div>
                      {s.screenshotUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={s.screenshotUrl}
                          alt={`Step ${s.stepIndex} screenshot`}
                          className="w-32 h-20 object-cover rounded border border-gray-200 shrink-0 bg-gray-50 cursor-pointer hover:opacity-80"
                          loading="lazy"
                          onClick={() => window.open(s.screenshotUrl!, '_blank')}
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
                          {!s.html && ' (HTML non disponibile — vecchia capture senza captureHtml)'}
                          {sw?.status === 'done' && (
                            <span className="text-emerald-600 ml-2">
                              · swiped: {sw.replacements}/{sw.totalTexts} testi
                            </span>
                          )}
                          {sw?.status === 'failed' && (
                            <span className="text-red-600 ml-2">· swipe failed: {sw.error}</span>
                          )}
                        </p>
                      </div>
                      <div className="flex flex-col gap-1.5 shrink-0">
                        {s.html && (
                          <button
                            onClick={() => setPreviewStep({ step: s, useSwiped: false })}
                            className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1.5"
                          >
                            <Code className="w-3 h-3" /> Original
                          </button>
                        )}
                        {sw?.swipedHtml && (
                          <button
                            onClick={() => setPreviewStep({ step: s, useSwiped: true })}
                            className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700 flex items-center gap-1.5"
                          >
                            <Code className="w-3 h-3" /> Swiped
                          </button>
                        )}
                        <button
                          onClick={() => swipeStep(s)}
                          disabled={!s.html || !productId || sw?.status === 'running'}
                          className="px-3 py-1.5 text-xs bg-purple-600 text-white rounded hover:bg-purple-700 flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                          title={!productId ? 'Seleziona prima un prodotto sopra' : 'Riscrivi i testi di questo step con Claude'}
                        >
                          {sw?.status === 'running' ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin" />
                              Swiping…
                            </>
                          ) : sw?.status === 'done' ? (
                            <>
                              <RefreshCw className="w-3 h-3" />
                              Re-swipe
                            </>
                          ) : (
                            <>
                              <Wand2 className="w-3 h-3" />
                              Swipe
                            </>
                          )}
                        </button>
                      </div>
                    </li>
                  );
                })}
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
                    Step {previewStep.step.stepIndex}
                    {previewStep.useSwiped ? ' · SWIPED' : ' · originale'}
                    {' — '}
                    {previewStep.step.quizStepLabel || previewStep.step.title}
                  </div>
                  <div className="text-white/80 text-xs truncate">{previewStep.step.url}</div>
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
              key={`${previewStep.step.stepIndex}-${previewStep.useSwiped ? 'swiped' : 'orig'}`}
              srcDoc={
                previewStep.useSwiped
                  ? swipeStates[previewStep.step.stepIndex]?.swipedHtml || ''
                  : previewStep.step.html || '<html><body>HTML non disponibile</body></html>'
              }
              sandbox="allow-same-origin"
              className="flex-1 w-full bg-white"
              title={`Step ${previewStep.step.stepIndex}`}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Assembla N step in un singolo HTML self-contained. Strategia:
 *  - estrae <body>...</body> di ogni step e lo wrappa in
 *    <div class="quiz-step" data-step="N" style="display:none">
 *  - prende il <head> dello step 1 (link CSS, meta, ecc.) come head comune
 *  - inietta uno script vanilla minimo che:
 *      a) all'avvio mostra lo step 1
 *      b) intercetta i click su [data-quiz-next], button, .next-button,
 *         .cta — ogni click avanza al prossimo .quiz-step
 *      c) keyboard arrow-right / Enter avanza pure
 *      d) ESC torna indietro
 *  - rimuove tutti i <script> originali (avrebbero fatto fetch interni
 *    che falliscono ovunque tranne sul dominio originale).
 */
function buildSinglePageQuiz(
  steps: QuizWalkStep[],
  swipeStates: Record<number, StepSwipeState>,
  entryUrl: string,
): string {
  function pick(step: QuizWalkStep): string {
    return swipeStates[step.stepIndex]?.swipedHtml || step.html || '';
  }
  function extractBody(html: string): string {
    const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return m ? m[1] : html;
  }
  function extractHead(html: string): string {
    const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    if (!m) return '';
    // togli tutti gli <script>: in standalone bundle gli script originali
    // farebbero fetch a endpoint che non esistono piu' fuori dal dominio.
    return m[1]
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<script\b[^>]*\/>/gi, '');
  }

  const firstHead = extractHead(pick(steps[0]));
  const baseHref = (() => {
    try {
      const u = new URL(entryUrl);
      return `<base href="${u.origin}/">`;
    } catch {
      return '';
    }
  })();

  const sections = steps.map((s, i) => {
    const body = extractBody(pick(s))
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<script\b[^>]*\/>/gi, '');
    const labelEsc = (s.quizStepLabel || s.title || `Step ${s.stepIndex}`)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<section class="qs-step" data-qs-index="${i}" data-qs-label="${labelEsc}" style="${i === 0 ? '' : 'display:none;'}">${body}</section>`;
  }).join('\n');

  const runner = `<style>
.qs-progress { position:fixed; top:0; left:0; right:0; height:4px; background:#eee; z-index:99999; }
.qs-progress > div { height:100%; background:linear-gradient(90deg,#7c3aed,#4f46e5); transition: width .25s; }
.qs-nav { position:fixed; bottom:16px; left:50%; transform:translateX(-50%); z-index:99999; display:flex; gap:8px; background:#111827cc; padding:8px 14px; border-radius:999px; color:#fff; font-family:system-ui,sans-serif; font-size:13px; backdrop-filter: blur(6px); }
.qs-nav button { background:transparent; color:#fff; border:1px solid #ffffff44; padding:4px 12px; border-radius:999px; cursor:pointer; font-size:12px; }
.qs-nav button:hover { background:#ffffff22; }
.qs-nav span { padding:4px 6px; opacity:.85; }
</style>
<div class="qs-progress"><div id="qs-bar" style="width:0%"></div></div>
<div class="qs-nav">
  <button id="qs-prev">← Prev</button>
  <span id="qs-pos">1 / ${steps.length}</span>
  <button id="qs-next">Next →</button>
</div>
<script>(function(){
  var idx = 0;
  var sections = document.querySelectorAll('.qs-step');
  var total = sections.length;
  function show(n){
    if (n < 0) n = 0;
    if (n >= total) n = total - 1;
    sections.forEach(function(s, i){ s.style.display = (i === n) ? '' : 'none'; });
    document.getElementById('qs-bar').style.width = (((n+1)/total)*100).toFixed(1) + '%';
    document.getElementById('qs-pos').textContent = (n+1) + ' / ' + total;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    idx = n;
  }
  document.getElementById('qs-prev').addEventListener('click', function(){ show(idx-1); });
  document.getElementById('qs-next').addEventListener('click', function(){ show(idx+1); });
  document.addEventListener('keydown', function(e){
    if (e.key === 'ArrowRight' || e.key === 'Enter') { show(idx+1); }
    else if (e.key === 'ArrowLeft' || e.key === 'Escape') { show(idx-1); }
  });
  // ogni click su button/CTA dentro la sezione attiva avanza al prossimo step
  document.addEventListener('click', function(e){
    var t = e.target;
    if (!t) return;
    var btn = t.closest && t.closest('button, [role="button"], a, .cta, .next-button, [class*="next"], [class*="cta"]');
    if (!btn) return;
    var sec = btn.closest('.qs-step');
    if (!sec) return;
    var i = parseInt(sec.getAttribute('data-qs-index') || '0', 10);
    if (i !== idx) return; // click su step nascosto, ignore
    e.preventDefault();
    show(idx+1);
  }, true);
  show(0);
})();<\/script>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
${baseHref}
<title>Quiz — assembled from ${steps.length} steps</title>
${firstHead}
</head>
<body>
${sections}
${runner}
</body>
</html>`;
}
