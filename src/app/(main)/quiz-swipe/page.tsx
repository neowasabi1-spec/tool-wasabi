'use client';

/**
 * Clone / Swipe Quiz — sezione dedicata ai quiz "single-URL multi-step".
 *
 * Sono le pagine (tipicamente React/Vue SPA) dove TUTTE le domande del quiz
 * vivono sullo stesso URL e cambiano via JS al click di Next. Esempio
 * canonico: bioma.health/intro-question, lpservhub.com/.../?affiliate=0
 *
 * Pipeline:
 *   1. Walk Quiz dialog: utente incolla URL + max steps + opzionali (custom
 *      prompt, target project per lo swipe).
 *   2. POST /api/walk-quiz {url, maxSteps, captureHtml:true} → crea un
 *      funnel_crawl_jobs row.  Il worker locale (openclaw-worker.js,
 *      Playwright) la prende e fa il loop "trova Next, click, cattura
 *      HTML+screenshot" fino a stop (no-more-Next o checkout-detected o
 *      maxSteps).
 *   3. Polling GET /api/walk-quiz/status/[jobId] ogni 1.5s; man mano che
 *      gli step arrivano popolano la tabella.
 *   4. Per ogni step l'utente può:
 *        - Preview (iframe full-screen, originale o swiped)
 *        - Edit (apre VisualHtmlEditor con tutte le sue feature: AI
 *          editor, Brand Colors, Tracking inject, ecc.)
 *        - Swipe (Claude riscrive i testi mantenendo struttura/CSS)
 *        - Save to Project (singolo o bulk via checkbox) → crea righe
 *          funnel_steps nel progetto scelto, da lì editabili anche da
 *          /projects/[id]
 *   5. Export single-page HTML: bundle self-contained con tutti gli
 *      step swipati.
 *
 * Chrome visuale: identico a /front-end-funnel — Header in alto, toolbar
 * bianca con azioni primarie, tabella step con per-row actions. Il
 * Walk-Quiz dialog è un modal separato (analogo al pattern Save in
 * front-end-funnel) per tenere la toolbar compatta.
 *
 * Persistenza: jobId in localStorage cosi' un refresh non fa perdere il
 * walk in corso.  Gli step swipati + edit locali vivono in state (non
 * persistiti finche' non clicchi Save to Project).
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import VisualHtmlEditor from '@/components/VisualHtmlEditor';
import {
  HelpCircle,
  Play,
  AlertCircle,
  Loader2,
  Image as ImageIcon,
  Eye,
  XCircle,
  CheckCircle,
  Download,
  Wand2,
  RefreshCw,
  Trash2,
  Pencil,
  BookmarkPlus,
  Target,
  FileCode,
  X,
  ExternalLink,
  Sparkles,
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
  result?: QuizWalkResult;
  error?: string | null;
}

interface StepSwipeState {
  status: 'running' | 'done' | 'failed';
  swipedHtml?: string;
  replacements?: number;
  totalTexts?: number;
  error?: string;
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const LS_KEY = 'quizSwipe.activeJobId';

export default function QuizSwipePage() {
  const projects = useStore((s) => s.projects);

  // ── Walk Quiz form (vive nel modal) ───────────────────────────────
  const [url, setUrl] = useState('');
  const [maxSteps, setMaxSteps] = useState(15);
  // Worker che eseguira' il walk. 'auto' = qualunque worker libero
  // (lotteria, sconsigliato se hai worker con codice diverso); 'neo' /
  // 'morfeo' = forza un worker specifico via target_agent, esattamente
  // come fa front-end-funnel. Cosi' eviti che un worker vecchio prenda
  // il job e si fermi presto.
  const [workerTarget, setWorkerTarget] = useState<'auto' | 'neo' | 'morfeo'>('neo');
  const [productId, setProductId] = useState<string>('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [showWalkDialog, setShowWalkDialog] = useState(false);

  // ── Walk job state ────────────────────────────────────────────────
  const [jobId, setJobId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  // ── Per-step state ────────────────────────────────────────────────
  const [previewStep, setPreviewStep] = useState<{ step: QuizWalkStep; useSwiped: boolean } | null>(null);
  const [swipeStates, setSwipeStates] = useState<Record<number, StepSwipeState>>({});
  const [isExporting, setIsExporting] = useState(false);
  // Edit nel VisualHtmlEditor.  Tracciamo step + flag se sta editando
  // la versione swiped o l'originale, cosi' al Save dell'editor
  // sovrascriviamo la fonte corretta.
  const [editingStep, setEditingStep] = useState<{ step: QuizWalkStep; useSwiped: boolean } | null>(null);
  // Modifiche locali fatte dall'utente nel VisualHtmlEditor che
  // sovrascrivono l'HTML originale (chiave: stepIndex).
  const [editedOriginalHtml, setEditedOriginalHtml] = useState<Record<number, string>>({});
  // Bulk select per Save to Project.
  const [selectedStepIndices, setSelectedStepIndices] = useState<Set<number>>(new Set());

  // ── Full-quiz preview (bundle) ────────────────────────────────────
  // Apre un iframe con il bundle single-page: l'utente vede il quiz
  // clonato funzionare esattamente come l'originale (Next avanza, no
  // cambio URL).  Serve a verificare visivamente PRIMA di salvare.
  const [showFullQuizPreview, setShowFullQuizPreview] = useState(false);

  // ── Save to Project modal ─────────────────────────────────────────
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveProjectId, setSaveProjectId] = useState<string>('');
  const [saveFlowName, setSaveFlowName] = useState('');
  const [saveReplace, setSaveReplace] = useState(false);
  // single-page  = 1 funnel_step con bundle interattivo (Bioma-like:
  //                quiz SPA single-URL, Next interno avanza al div
  //                successivo, no cambio URL).  Comportamento "uguale
  //                all'originale" che chiedeva l'utente.
  // multi-page   = N funnel_steps, uno per snapshot (vecchio behaviour).
  //                Utile per quiz dove ogni step E' una pagina diversa
  //                gia' linkata via href.
  const [saveMode, setSaveMode] = useState<'single-page' | 'multi-page'>('single-page');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

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

  // Riprendi job in corso dal localStorage al primo mount.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LS_KEY);
      if (saved && !jobId) {
        setJobId(saved);
        pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
        void pollOnce(saved);
      }
    } catch {
      /* localStorage non disponibile in SSR / privacy mode */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setEditedOriginalHtml({});
    setSelectedStepIndices(new Set());
    setJobId(null);
    setIsStarting(true);
    setShowWalkDialog(false);
    try {
      const res = await fetch('/api/walk-quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          maxSteps,
          targetAgent: workerTarget === 'auto' ? null : workerTarget,
        }),
      });
      const ct = res.headers.get('content-type') || '';
      if (!res.ok) {
        const body = ct.includes('application/json') ? JSON.stringify(await res.json()) : await res.text();
        setError(`Errore ${res.status}: ${body.slice(0, 300)}`);
        return;
      }
      const data = (await res.json()) as { ok: boolean; jobId?: string; error?: string };
      if (!data.ok || !data.jobId) {
        setError(data.error || 'Risposta inattesa dal backend.');
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
    setEditedOriginalHtml({});
    setSelectedStepIndices(new Set());
    setError(null);
    try { window.localStorage.removeItem(LS_KEY); } catch {}
  }

  async function swipeStep(step: QuizWalkStep) {
    const sourceHtml = editedOriginalHtml[step.stepIndex] ?? step.html;
    if (!sourceHtml) {
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
        [step.stepIndex]: { status: 'failed', error: 'Seleziona prima un progetto target nel dialog Walk Quiz (o riapri il dialog).' },
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
          html: sourceHtml,
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
      const usable = steps.filter((s) => {
        const swiped = swipeStates[s.stepIndex]?.swipedHtml;
        const edited = editedOriginalHtml[s.stepIndex];
        return Boolean(swiped || edited || s.html);
      });
      if (usable.length === 0) {
        setError('Nessuno step ha HTML disponibile da esportare.');
        return;
      }
      const bundle = buildSinglePageQuiz(
        usable,
        swipeStates,
        editedOriginalHtml,
        snapshot?.entryUrl || '',
      );
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

  // ── Editor save handler ──
  // L'utente ha appena salvato modifiche nel VisualHtmlEditor. A seconda
  // se stava editando la versione swiped o l'originale, scriviamo nel
  // posto giusto cosi' il prossimo Preview / Export usa il nuovo HTML.
  const handleEditorSave = useCallback(
    (html: string) => {
      if (!editingStep) return;
      const idx = editingStep.step.stepIndex;
      if (editingStep.useSwiped) {
        setSwipeStates((prev) => ({
          ...prev,
          [idx]: {
            ...(prev[idx] ?? { status: 'done' as const }),
            status: 'done',
            swipedHtml: html,
          },
        }));
      } else {
        setEditedOriginalHtml((prev) => ({ ...prev, [idx]: html }));
      }
    },
    [editingStep],
  );

  // ── Build the single-page quiz bundle on demand ──────────────────
  // Usato da: Export, Preview-quiz modal, Save (single-page mode).
  // Sempre la stessa identica funzione cosi' quello che vedi nel
  // Preview === quello che esporti === quello che salvi nel progetto.
  const buildBundle = useCallback((): string => {
    const stepsToBundle = (snapshot?.result?.steps || []).filter((s) => {
      const swiped = swipeStates[s.stepIndex]?.swipedHtml;
      const edited = editedOriginalHtml[s.stepIndex];
      return Boolean(swiped || edited || s.html);
    });
    if (stepsToBundle.length === 0) return '';
    return buildSinglePageQuiz(
      stepsToBundle,
      swipeStates,
      editedOriginalHtml,
      snapshot?.entryUrl || '',
    );
  }, [snapshot, swipeStates, editedOriginalHtml]);

  // ── Save selected steps to a project ──
  // Bulk insert in funnel_steps via /api/projecthub/projects/[id]/funnel-steps
  // (POST con body { steps: [...] }).  La route usa supabaseAdmin quindi
  // bypassa RLS, e l'JWT viene attaccato automaticamente dall'interceptor
  // globale (FetchAuthBootstrap) per attribuire l'owner_user_id.
  //
  // Due modalita':
  // - 'single-page': inseriamo UN solo funnel_step il cui result_content
  //   e' il bundle interattivo (Bioma-like).  Aperto da /projects/[id]
  //   diventa un quiz funzionante 1:1 come l'originale.
  // - 'multi-page': inseriamo N funnel_steps, uno per snapshot.  Utile
  //   per quiz dove ogni step e' una pagina con URL propria.
  async function handleSaveToProject() {
    if (!saveProjectId) {
      setSaveError('Seleziona un progetto.');
      return;
    }
    const allSteps = snapshot?.result?.steps || [];
    const target = selectedStepIndices.size > 0
      ? allSteps.filter((s) => selectedStepIndices.has(s.stepIndex))
      : allSteps;
    if (target.length === 0) {
      setSaveError('Nessuno step da salvare.');
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const flowName = saveFlowName.trim() || `Quiz · ${new Date().toLocaleDateString()}`;
      let rows: Array<Record<string, unknown>>;
      if (saveMode === 'single-page') {
        // Costruisci il bundle SOLO con gli step selezionati (rispetta
        // la selezione checkbox dell'utente).
        const bundleHtml = buildSinglePageQuiz(
          target,
          swipeStates,
          editedOriginalHtml,
          snapshot?.entryUrl || '',
        );
        const anySwiped = target.some((s) => swipeStates[s.stepIndex]?.swipedHtml);
        rows = [{
          step_number: 1,
          page_name: snapshot?.result?.steps?.[0]?.title || 'Quiz',
          step_type: 'quiz',
          url: snapshot?.entryUrl || '',
          status: anySwiped ? 'swiped' : 'cloned',
          result_content: bundleHtml,
          flow_name: flowName,
        }];
      } else {
        rows = target.map((s, i) => {
          const html =
            swipeStates[s.stepIndex]?.swipedHtml ||
            editedOriginalHtml[s.stepIndex] ||
            s.html ||
            '';
          return {
            step_number: i + 1,
            page_name: s.quizStepLabel || s.title || `Step ${s.stepIndex}`,
            step_type: 'quiz',
            url: s.url,
            status: swipeStates[s.stepIndex]?.swipedHtml ? 'swiped' : 'cloned',
            result_content: html,
            flow_name: flowName,
          };
        });
      }
      const res = await fetch(
        `/api/projecthub/projects/${encodeURIComponent(saveProjectId)}/funnel-steps`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ steps: rows, replace: saveReplace }),
        },
      );
      const ct = res.headers.get('content-type') || '';
      const body = ct.includes('application/json') ? await res.json() : { error: await res.text() };
      if (!res.ok) {
        setSaveError(typeof body === 'object' && body && 'error' in body ? String(body.error) : `HTTP ${res.status}`);
        return;
      }
      const insertedCount = Array.isArray(body) ? body.length : rows.length;
      setSaveSuccess(
        saveMode === 'single-page'
          ? `Salvato come quiz interattivo (1 step con tutti i ${target.length} pannelli).  Aprilo da My Projects.`
          : `Salvati ${insertedCount} step nel progetto.  Aprilo da My Projects.`
      );
      setTimeout(() => {
        setShowSaveDialog(false);
        setSaveSuccess(null);
      }, 2000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSaving(false);
    }
  }

  function toggleStepSelected(idx: number) {
    setSelectedStepIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  // ── Derived state ────────────────────────────────────────────────
  const steps = snapshot?.result?.steps ?? [];
  const isRunning = snapshot?.status === 'running' || snapshot?.status === 'pending';
  const isDone = snapshot?.status === 'completed';
  const isFailed = snapshot?.status === 'failed';
  const stopDiag = snapshot?.result?.stopDiagnostic;
  const anySwipeDone = Object.values(swipeStates).some((s) => s.status === 'done');
  const targetProject = useMemo(
    () => projects.find((p) => p.id === productId),
    [projects, productId],
  );
  const selectedCount = selectedStepIndices.size;
  const allSelected = steps.length > 0 && steps.every((s) => selectedStepIndices.has(s.stepIndex));

  return (
    <div className="min-h-screen">
      <Header
        title="Clone / Swipe Quiz"
        subtitle="Walk single-URL quizzes (SPA) step-by-step, then edit / swipe / save each step"
      />

      <div className="p-6">
        {/* ═══ Toolbar (same chrome as /front-end-funnel) ═══ */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4 flex-wrap">
              <button
                onClick={() => setShowWalkDialog(true)}
                disabled={isStarting || isRunning}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isStarting || isRunning ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {isStarting
                      ? 'Starting job…'
                      : `Walking ${snapshot?.currentStep ?? 0}/${snapshot?.totalSteps ?? maxSteps}…`}
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    Walk Quiz
                  </>
                )}
              </button>

              <span className="text-gray-500">
                {steps.length} step{steps.length === 1 ? '' : 's'}
              </span>

              {selectedCount > 0 && (
                <button
                  onClick={() => {
                    setSaveError(null);
                    setSaveSuccess(null);
                    setShowSaveDialog(true);
                  }}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 transition-colors"
                >
                  <BookmarkPlus className="w-4 h-4" />
                  Save {selectedCount} step{selectedCount === 1 ? '' : 's'} to project
                </button>
              )}

              {steps.length > 0 && selectedCount === 0 && (
                <button
                  onClick={() => {
                    setSaveError(null);
                    setSaveSuccess(null);
                    setShowSaveDialog(true);
                  }}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 transition-colors"
                >
                  <BookmarkPlus className="w-4 h-4" />
                  Save all to project
                </button>
              )}

              {steps.length > 0 && (
                <button
                  onClick={() => setShowFullQuizPreview(true)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 transition-colors"
                  title="Open the cloned quiz exactly as it works on the original site — Next button advances, no URL change"
                >
                  <Eye className="w-4 h-4" />
                  Preview Quiz
                </button>
              )}

              {steps.length > 0 && (
                <button
                  onClick={exportSinglePageQuiz}
                  disabled={isExporting}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200 transition-colors disabled:opacity-50"
                  title="Download the cloned quiz as a single self-contained HTML file"
                >
                  <Download className="w-4 h-4" />
                  Export .html
                </button>
              )}

              {/* Target project pill — identico al "Project for all" di front-end-funnel */}
              {projects.length > 0 && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
                  <Target className="w-4 h-4 text-amber-600" />
                  <span className="text-sm font-medium text-amber-800 whitespace-nowrap">Swipe target:</span>
                  <select
                    value={productId}
                    onChange={(e) => setProductId(e.target.value)}
                    className="min-w-[160px] px-2 py-1 border border-amber-300 rounded-md text-sm bg-white focus:ring-2 focus:ring-amber-400 focus:border-amber-400"
                  >
                    <option value="">— None —</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              {jobId && (
                <span className="text-xs text-gray-500 font-mono">job {jobId.slice(0, 8)}…</span>
              )}
              {jobId && (
                <button
                  onClick={discardWalk}
                  className="px-3 py-1.5 text-sm text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg flex items-center gap-1.5 border border-gray-200"
                  title="Forget the current job (does not cancel it on the backend, only locally)"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Discard
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ═══ Banners ═══ */}
        {error && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3 mb-6">
            <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm text-amber-900 flex-1">{error}</div>
            <button onClick={() => setError(null)} className="text-amber-700 hover:text-amber-900">
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        )}

        {isFailed && snapshot?.error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3 mb-6">
            <XCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div className="text-sm text-red-900">
              <div className="font-semibold">Walk failed</div>
              <div className="mt-1 break-words">{snapshot.error}</div>
            </div>
          </div>
        )}

        {isDone && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 flex items-start gap-3 mb-6">
            <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            <div className="text-sm text-emerald-900 flex-1">
              <div className="font-semibold">
                Walk completed — {steps.length} steps captured
                {snapshot?.result?.durationMs && (
                  <span className="font-normal text-emerald-800/80 ml-2">
                    ({(snapshot.result.durationMs / 1000).toFixed(1)}s)
                  </span>
                )}
              </div>
              {stopDiag?.reason && (
                <div className="mt-1 text-emerald-800/90 text-xs">
                  Stop reason: <code className="bg-emerald-100 px-1 rounded">{stopDiag.reason}</code>
                  {stopDiag.hint && <span className="block mt-1 italic">{stopDiag.hint}</span>}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══ Steps table (front-end-funnel style) ═══ */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200 text-xs uppercase text-gray-600 font-semibold">
                <tr>
                  <th className="w-8 px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      aria-label="Select all steps"
                      className="cursor-pointer accent-purple-600"
                      checked={allSelected}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedStepIndices(new Set(steps.map((s) => s.stepIndex)));
                        } else {
                          setSelectedStepIndices(new Set());
                        }
                      }}
                    />
                  </th>
                  <th className="w-12 px-2 py-2 text-left">Step</th>
                  <th className="w-32 px-2 py-2 text-left">Preview</th>
                  <th className="min-w-[200px] px-2 py-2 text-left">Title</th>
                  <th className="min-w-[200px] px-2 py-2 text-left">URL</th>
                  <th className="w-28 px-2 py-2 text-left">HTML</th>
                  <th className="w-28 px-2 py-2 text-left">Status</th>
                  <th className="min-w-[260px] px-2 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {steps.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-12 text-gray-500">
                      <HelpCircle className="w-10 h-10 mx-auto mb-2 text-gray-300" />
                      <div className="font-medium">No steps yet.</div>
                      <div className="text-xs mt-1">Click <span className="font-semibold text-blue-600">Walk Quiz</span> to scan a single-URL quiz step by step.</div>
                    </td>
                  </tr>
                ) : (
                  steps.map((s) => {
                    const sw = swipeStates[s.stepIndex];
                    const editedHtml = editedOriginalHtml[s.stepIndex];
                    const isSelected = selectedStepIndices.has(s.stepIndex);
                    const hasHtml = Boolean(s.html);
                    const hasSwiped = Boolean(sw?.swipedHtml);
                    const hasEdits = Boolean(editedHtml);
                    return (
                      <tr key={s.stepIndex} className={`border-b border-gray-100 ${isSelected ? 'bg-purple-50/50' : 'hover:bg-gray-50/50'}`}>
                        <td className="text-center px-2 py-2 bg-gray-50/30">
                          <input
                            type="checkbox"
                            aria-label={`Select step ${s.stepIndex}`}
                            className="cursor-pointer accent-purple-600"
                            checked={isSelected}
                            onChange={() => toggleStepSelected(s.stepIndex)}
                          />
                        </td>
                        <td className="px-2 py-2 font-medium text-gray-700 bg-gray-50/30">
                          {s.stepIndex}
                        </td>
                        <td className="px-2 py-2">
                          {s.screenshotUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={s.screenshotUrl}
                              alt={`Step ${s.stepIndex}`}
                              className="w-28 h-16 object-cover rounded border border-gray-200 bg-gray-50 cursor-pointer hover:opacity-80"
                              loading="lazy"
                              onClick={() => window.open(s.screenshotUrl!, '_blank')}
                              title="Click to open full-size screenshot"
                            />
                          ) : (
                            <div className="w-28 h-16 rounded border border-dashed border-gray-300 flex items-center justify-center text-gray-400">
                              <ImageIcon className="w-5 h-5" />
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <div className="font-medium text-gray-900 truncate max-w-[280px]">
                            {s.quizStepLabel || s.title || `Step ${s.stepIndex}`}
                          </div>
                          {hasEdits && (
                            <span className="inline-flex items-center gap-1 text-[10px] uppercase font-semibold text-blue-700 bg-blue-100 rounded px-1.5 py-0.5 mt-1">
                              <Pencil className="w-3 h-3" /> edited
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline text-xs truncate inline-flex items-center gap-1 max-w-[260px]"
                          >
                            <span className="truncate">{s.url}</span>
                            <ExternalLink className="w-3 h-3 shrink-0" />
                          </a>
                        </td>
                        <td className="px-2 py-2 text-xs text-gray-600">
                          {hasHtml ? (
                            <span title={`${(s.htmlLength || s.html?.length || 0).toLocaleString()} chars`}>
                              {Math.round((s.htmlLength || s.html?.length || 0) / 1024)} KB
                            </span>
                          ) : (
                            <span className="text-gray-400 italic">no html</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {sw?.status === 'running' ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-purple-700">
                              <Loader2 className="w-3 h-3 animate-spin" /> swiping…
                            </span>
                          ) : hasSwiped ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                              <CheckCircle className="w-3 h-3" /> swiped
                            </span>
                          ) : sw?.status === 'failed' ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5" title={sw.error}>
                              <XCircle className="w-3 h-3" /> failed
                            </span>
                          ) : hasHtml ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 bg-gray-100 rounded px-1.5 py-0.5">
                              cloned
                            </span>
                          ) : (
                            <span className="text-xs text-gray-400 italic">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1 flex-wrap">
                            {hasHtml && (
                              <button
                                onClick={() => setPreviewStep({ step: s, useSwiped: hasSwiped })}
                                className="p-1.5 bg-blue-100 text-blue-700 hover:bg-blue-200 rounded transition-colors"
                                title={hasSwiped ? 'Preview swiped HTML' : 'Preview original HTML'}
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {hasHtml && (
                              <button
                                onClick={() => setEditingStep({ step: s, useSwiped: hasSwiped })}
                                className="p-1.5 bg-purple-100 text-purple-700 hover:bg-purple-200 rounded transition-colors"
                                title={hasSwiped ? 'Edit swiped HTML in Visual Editor' : 'Edit original HTML in Visual Editor'}
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              onClick={() => swipeStep(s)}
                              disabled={!hasHtml || !productId || sw?.status === 'running'}
                              className="p-1.5 bg-amber-100 text-amber-700 hover:bg-amber-200 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              title={!productId ? 'Pick a "Swipe target" project first' : hasSwiped ? 'Re-swipe' : 'Swipe this step with Claude'}
                            >
                              {sw?.status === 'running' ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : hasSwiped ? (
                                <RefreshCw className="w-3.5 h-3.5" />
                              ) : (
                                <Wand2 className="w-3.5 h-3.5" />
                              )}
                            </button>
                            {hasSwiped && (
                              <button
                                onClick={() => setPreviewStep({ step: s, useSwiped: false })}
                                className="p-1.5 bg-gray-100 text-gray-700 hover:bg-gray-200 rounded transition-colors"
                                title="Preview ORIGINAL (pre-swipe)"
                              >
                                <FileCode className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Empty state if no job at all */}
        {!jobId && !isStarting && steps.length === 0 && !error && (
          <div className="mt-6 bg-gradient-to-br from-blue-50 to-purple-50 border border-blue-100 rounded-lg p-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-white shadow-sm border border-blue-200 flex items-center justify-center shrink-0">
                <Sparkles className="w-5 h-5 text-purple-600" />
              </div>
              <div className="text-sm text-gray-700 flex-1">
                <div className="font-semibold text-gray-900">How it works</div>
                <ol className="list-decimal list-inside mt-2 space-y-1 text-gray-600">
                  <li>Click <span className="font-medium text-blue-700">Walk Quiz</span> and paste a single-URL quiz (e.g. <code className="bg-white px-1 rounded">bioma.health/intro-question</code>).</li>
                  <li>Playwright opens it on the local worker, clicks Next on every step, captures HTML + screenshot.</li>
                  <li>For each step you can <b>Preview</b>, <b>Edit</b> in the Visual Editor, or <b>Swipe</b> the copy with Claude.</li>
                  <li>Select the steps you want and <b>Save to project</b> — they land in <code className="bg-white px-1 rounded">funnel_steps</code> and become editable from My Projects.</li>
                </ol>
                <div className="mt-3 text-xs text-gray-500">
                  Worker must be running: <code className="bg-white border border-gray-200 px-1 rounded">node openclaw-worker.js</code>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ═══ Walk Quiz Dialog ═══ */}
      {showWalkDialog && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={() => !isStarting && setShowWalkDialog(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-[560px] max-w-[95vw] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 bg-gradient-to-r from-purple-600 to-indigo-600 text-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-white/15">
                  <HelpCircle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-base">Walk Quiz</h3>
                  <p className="text-xs text-white/80">Single-URL multi-step (SPA) scan</p>
                </div>
              </div>
              <button
                onClick={() => setShowWalkDialog(false)}
                className="p-1 rounded-lg hover:bg-white/20 transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Quiz URL</label>
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://bioma.health/intro-question"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                  autoFocus
                />
                <p className="text-[11px] text-gray-500 mt-1">
                  Typical quiz: URL doesn&apos;t change while you answer questions (React/Vue SPA).
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Max steps</label>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={maxSteps}
                    onChange={(e) => setMaxSteps(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                  />
                  <p className="text-[11px] text-gray-500 mt-1">Hard cap 60.</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Swipe target (project)</label>
                  <select
                    value={productId}
                    onChange={(e) => setProductId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm bg-white"
                  >
                    <option value="">— None (clone only) —</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-gray-500 mt-1">Claude will rewrite copy for this project.</p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Worker</label>
                <select
                  value={workerTarget}
                  onChange={(e) => setWorkerTarget(e.target.value as 'auto' | 'neo' | 'morfeo')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm bg-white"
                >
                  <option value="neo">Neo (OpenClaw locale)</option>
                  <option value="morfeo">Morfeo (OpenClaw locale)</option>
                  <option value="auto">Auto (primo worker libero)</option>
                </select>
                <p className="text-[11px] text-gray-500 mt-1">
                  Forza il worker aggiornato. &quot;Auto&quot; lascia il job al primo libero: usalo solo se tutti i worker hanno l&apos;ultimo codice.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Custom prompt (optional)</label>
                <textarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="e.g. Casual tone, no fake percentages, German language, etc."
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm resize-none"
                />
              </div>
            </div>

            <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-end gap-2">
              <button
                onClick={() => setShowWalkDialog(false)}
                className="px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={startWalk}
                disabled={isStarting || !url.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold text-white bg-purple-600 hover:bg-purple-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isStarting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Walk Quiz
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Save to Project Dialog ═══ */}
      {showSaveDialog && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={() => !isSaving && setShowSaveDialog(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-[520px] max-w-[95vw] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 bg-gradient-to-r from-emerald-500 to-teal-500 text-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-white/15">
                  <BookmarkPlus className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-base">Save quiz steps to project</h3>
                  <p className="text-xs text-white/80">
                    Saving {selectedCount > 0 ? selectedCount : steps.length} step{(selectedCount || steps.length) === 1 ? '' : 's'} as funnel_steps
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowSaveDialog(false)}
                className="p-1 rounded-lg hover:bg-white/20 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Save mode</label>
                <div className="space-y-2">
                  <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${saveMode === 'single-page' ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                    <input
                      type="radio"
                      name="saveMode"
                      value="single-page"
                      checked={saveMode === 'single-page'}
                      onChange={() => setSaveMode('single-page')}
                      className="mt-1 accent-emerald-600"
                    />
                    <div className="flex-1 text-xs">
                      <div className="font-semibold text-gray-900">Single-page quiz <span className="text-emerald-700">(works like the original)</span></div>
                      <div className="text-gray-600 mt-0.5">
                        Bundles every step into ONE funnel_step.  Click Next inside the quiz → next step appears, URL stays the same.  Pick this for SPA quizzes (bioma-style).
                      </div>
                    </div>
                  </label>
                  <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${saveMode === 'multi-page' ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                    <input
                      type="radio"
                      name="saveMode"
                      value="multi-page"
                      checked={saveMode === 'multi-page'}
                      onChange={() => setSaveMode('multi-page')}
                      className="mt-1 accent-emerald-600"
                    />
                    <div className="flex-1 text-xs">
                      <div className="font-semibold text-gray-900">Multi-page funnel</div>
                      <div className="text-gray-600 mt-0.5">
                        Each captured step becomes a separate funnel_step (independent HTML).  Pick this only if the original quiz uses a real URL per step.
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Target project</label>
                <select
                  value={saveProjectId}
                  onChange={(e) => setSaveProjectId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm bg-white"
                >
                  <option value="">— Select a project —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Flow name (optional)</label>
                <input
                  type="text"
                  value={saveFlowName}
                  onChange={(e) => setSaveFlowName(e.target.value)}
                  placeholder={`Quiz · ${new Date().toLocaleDateString()}`}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm"
                />
                <p className="text-[11px] text-gray-500 mt-1">Groups these steps under a named flow inside the project.</p>
              </div>

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={saveReplace}
                  onChange={(e) => setSaveReplace(e.target.checked)}
                  className="mt-0.5 accent-emerald-600"
                />
                <div className="text-xs text-gray-700">
                  <div className="font-medium">Replace existing steps</div>
                  <div className="text-gray-500">
                    Delete every existing funnel_step in this project before inserting. Use only if you&apos;re re-importing the same flow.
                  </div>
                </div>
              </label>

              {saveError && (
                <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">{saveError}</div>
              )}
              {saveSuccess && (
                <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-700 flex items-center gap-2">
                  <CheckCircle className="w-4 h-4" /> {saveSuccess}
                </div>
              )}
            </div>

            <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-end gap-2">
              <button
                onClick={() => setShowSaveDialog(false)}
                className="px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveToProject}
                disabled={isSaving || !saveProjectId}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookmarkPlus className="w-4 h-4" />}
                {isSaving ? 'Saving…' : 'Save to project'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Preview Modal ═══ */}
      {previewStep && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setPreviewStep(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-[95vw] h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between bg-gradient-to-r from-blue-600 to-indigo-600">
              <div className="flex items-center gap-3 min-w-0">
                <Eye className="w-5 h-5 text-white" />
                <div className="min-w-0">
                  <div className="text-white font-semibold truncate">
                    Step {previewStep.step.stepIndex}
                    {previewStep.useSwiped ? ' · SWIPED' : ' · original'}
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
                  : editedOriginalHtml[previewStep.step.stepIndex] ||
                    previewStep.step.html ||
                    '<html><body>HTML non disponibile</body></html>'
              }
              sandbox="allow-same-origin"
              className="flex-1 w-full bg-white"
              title={`Step ${previewStep.step.stepIndex}`}
            />
          </div>
        </div>
      )}

      {/* ═══ Full-quiz Preview Modal (bundle, exactly like Export) ═══ */}
      {showFullQuizPreview && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setShowFullQuizPreview(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-[95vw] h-[92vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between bg-gradient-to-r from-indigo-600 to-purple-600">
              <div className="flex items-center gap-3 min-w-0">
                <Eye className="w-5 h-5 text-white" />
                <div className="min-w-0">
                  <div className="text-white font-semibold truncate">Quiz preview — exactly like the original</div>
                  <div className="text-white/80 text-xs truncate">{snapshot?.entryUrl} · {steps.length} step{steps.length === 1 ? '' : 's'} · Click Next inside → next step appears</div>
                </div>
              </div>
              <button
                onClick={() => setShowFullQuizPreview(false)}
                className="text-white/80 hover:text-white text-2xl font-bold"
              >
                ×
              </button>
            </div>
            <iframe
              key={`quiz-bundle-${steps.length}-${Object.keys(swipeStates).length}-${Object.keys(editedOriginalHtml).length}`}
              srcDoc={buildBundle()}
              sandbox="allow-same-origin allow-scripts"
              className="flex-1 w-full bg-white"
              title="Full quiz preview"
            />
          </div>
        </div>
      )}

      {/* ═══ Visual Editor (full-screen overlay) ═══ */}
      {editingStep && (
        <div className="fixed inset-0 z-[60] bg-white">
          <VisualHtmlEditor
            initialHtml={
              editingStep.useSwiped
                ? swipeStates[editingStep.step.stepIndex]?.swipedHtml || ''
                : editedOriginalHtml[editingStep.step.stepIndex] ||
                  editingStep.step.html ||
                  ''
            }
            onSave={handleEditorSave}
            onClose={() => setEditingStep(null)}
            pageTitle={editingStep.step.quizStepLabel || editingStep.step.title || `Step ${editingStep.step.stepIndex}`}
            sourceUrl={editingStep.step.url}
            availableProducts={projects.map((p) => ({ id: p.id, name: p.name }))}
            currentProductId={productId || undefined}
            onProductChange={(id) => setProductId(id)}
            productContext={targetProject ? {
              name: targetProject.name,
              description: targetProject.description || targetProject.brief || '',
            } : undefined}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Bundle N step in un singolo HTML self-contained che si comporta come
 * il quiz originale single-URL.
 *
 * Per ogni step prendiamo, in ordine:
 *   1) swipedHtml (priorita' massima — riscritto da Claude)
 *   2) editedOriginalHtml (modifiche manuali dal VisualHtmlEditor)
 *   3) html originale catturato dal walker
 *
 * STRATEGIA NAVIGAZIONE (importante):
 *
 *   Il problema dei quiz SPA tipo Bioma e' che ogni step ha layout
 *   diversi: a volte un bottone "Continue" enorme in fondo, a volte
 *   delle answer-cards (radio nascoste) che auto-avanzano al click,
 *   a volte entrambi.  Intercettare TUTTI i <button> e' sbagliato
 *   (rompe toggle, accordion, language switcher, ecc.).
 *
 *   Quindi facciamo detection PER-STEP a build-time:
 *     1) Cerchiamo in HTML il bottone con testo che matcha
 *        /next|continue|avanti|.../ → e' il primary advance.
 *     2) Marchiamo TUTTI gli input[type=radio] + le answer-card
 *        come "tap to advance" (mimica del comportamento Bioma).
 *     3) Marchiamo input[type=submit] dentro form come advance.
 *
 *   A runtime, il navScript:
 *     - Intercetta SOLO click su elementi marcati [data-wq-advance]
 *     - I click su un radio/option fanno highlight visivo e avanzano
 *       dopo 300ms (come fa Bioma davvero)
 *     - Frecce destra/Invio = next, Frecce sinistra/Esc = prev
 *     - Mostra un piccolo progress bar in alto (step N di M)
 *
 *   Stripping degli script originali: i <script> del React/Vue bundle
 *   originale farebbero fetch 404 fuori dal dominio sorgente, quindi
 *   vanno via.  Lasciamo solo lo head dello step 1 (CSS, font, meta).
 */
function buildSinglePageQuiz(
  steps: QuizWalkStep[],
  swipeStates: Record<number, StepSwipeState>,
  editedOriginalHtml: Record<number, string>,
  entryUrl: string,
): string {
  function pick(step: QuizWalkStep): string {
    return (
      swipeStates[step.stepIndex]?.swipedHtml ||
      editedOriginalHtml[step.stepIndex] ||
      step.html ||
      ''
    );
  }
  function extractBody(html: string): string {
    const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return m ? m[1] : html;
  }
  function extractHead(html: string): string {
    const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    if (!m) return '';
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

  const stepsHtml = steps
    .map((s, i) => {
      const body = extractBody(pick(s))
        // Via tutti gli script originali: rifarebbero fetch a backend
        // che non risponde (CORS / 404) e potrebbero anche fare redirect
        // fuori dal nostro bundle.
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        // Disarma i form: un submit su un form esterno porta via dal bundle.
        // Preferiamo che il navScript li gestisca come advance.
        .replace(/<form\b/gi, '<form data-wq-form action="#" onsubmit="return false;"');
      return `<section class="quiz-step" data-step="${s.stepIndex}" data-step-index="${i}"${i === 0 ? '' : ' hidden'}>${body}</section>`;
    })
    .join('\n');

  // navScript: detection runtime perche' i regex su HTML grezzo sono
  // fragili.  Cosi' lavoriamo sul DOM vero costruito dal browser.
  const navScript = `
<script>
(function(){
  var ADVANCE_TEXT_RE = /^\\s*(next|continue|avanti|continua|prossimo|submit|invia|inizia|start|begin|go|vai|proceed|finish|done|fatto|see\\s*(my|the)?\\s*result|get\\s*(my|your)?\\s*result|claim|ottieni|scopri|siguiente|weiter|suivant|continuer|próximo|next\\s*step|→)\\s*$/i;
  var STOP_BUBBLE_TARGETS = 'a[href],button,[role=button],input[type=submit],label,[role=radio]';
  var steps = Array.prototype.slice.call(document.querySelectorAll('.quiz-step'));
  if (!steps.length) return;
  var idx = 0;

  // Progress bar UI in alto
  var bar = document.createElement('div');
  bar.id = '__wq_bar';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:4px;background:rgba(0,0,0,0.08);z-index:2147483647;pointer-events:none';
  var fill = document.createElement('div');
  fill.style.cssText = 'height:100%;background:linear-gradient(90deg,#6366f1,#8b5cf6);width:0%;transition:width .25s ease';
  bar.appendChild(fill);
  document.body.appendChild(bar);

  function show(i){
    if (i < 0 || i >= steps.length) return;
    steps.forEach(function(el, k){
      if (k === i) { el.removeAttribute('hidden'); el.style.display = 'block'; }
      else { el.setAttribute('hidden', ''); el.style.display = 'none'; }
    });
    idx = i;
    fill.style.width = ((i + 1) / steps.length * 100) + '%';
    window.scrollTo(0, 0);
  }
  function next(){ if (idx < steps.length - 1) show(idx + 1); }
  function prev(){ if (idx > 0) show(idx - 1); }

  function markAdvanceInStep(stepEl){
    // 1) Bottoni con testo che matcha "Next/Continue/Avanti/..."
    var btns = stepEl.querySelectorAll('button,[role=button],input[type=submit],a.btn,a.button,a[class*=btn],a[class*=cta]');
    var primary = null;
    var primaryArea = 0;
    Array.prototype.forEach.call(btns, function(b){
      var txt = (b.innerText || b.value || '').trim();
      if (!txt) return;
      if (ADVANCE_TEXT_RE.test(txt)) {
        b.setAttribute('data-wq-advance', 'btn');
        return;
      }
      // Fallback: bottone piu' grande dello step (visivamente il primary CTA)
      var r = b.getBoundingClientRect();
      var area = r.width * r.height;
      if (area > primaryArea) { primaryArea = area; primary = b; }
    });
    if (primary && !primary.hasAttribute('data-wq-advance')) {
      primary.setAttribute('data-wq-advance', 'primary');
    }
    // 2) Radio / answer-cards / option / choice → tap to advance (Bioma-style)
    var opts = stepEl.querySelectorAll(
      'input[type=radio],label[for],[class*=option]:not(form),[class*=answer]:not(form),[class*=choice]:not(form),[role=radio]'
    );
    Array.prototype.forEach.call(opts, function(o){
      // Evita di marcare label che contengono input non-radio
      if (o.tagName === 'LABEL') {
        var forId = o.getAttribute('for');
        if (forId) {
          var input = document.getElementById(forId);
          if (input && input.type && input.type !== 'radio' && input.type !== 'checkbox') return;
        }
      }
      o.setAttribute('data-wq-advance', 'option');
    });
  }
  steps.forEach(markAdvanceInStep);

  // Highlight visivo quando clicco un'opzione, poi avanzo
  var pendingTimer = null;
  function highlightAndAdvance(el){
    if (pendingTimer) return; // debounce
    el.style.outline = '3px solid #8b5cf6';
    el.style.outlineOffset = '2px';
    pendingTimer = setTimeout(function(){ pendingTimer = null; next(); }, 280);
  }

  // Intercetta SOLO elementi marcati
  document.addEventListener('click', function(e){
    var t = e.target;
    while (t && t !== document.body){
      if (t.nodeType === 1 && t.hasAttribute && t.hasAttribute('data-wq-advance')){
        var kind = t.getAttribute('data-wq-advance');
        e.preventDefault();
        e.stopPropagation();
        if (kind === 'option') {
          highlightAndAdvance(t);
        } else {
          next();
        }
        return;
      }
      t = t.parentElement;
    }
  }, true);

  // Keyboard nav
  document.addEventListener('keydown', function(e){
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
    if (e.key === 'ArrowLeft' || e.key === 'Escape') { e.preventDefault(); prev(); }
  });

  // Disarma i form (gia' fatto a build-time, ridondanza runtime se srcDoc-mangled)
  Array.prototype.forEach.call(document.querySelectorAll('form'), function(f){
    f.addEventListener('submit', function(e){ e.preventDefault(); next(); return false; });
  });

  show(0);
})();
</script>`;

  return `<!DOCTYPE html>
<html>
<head>
${baseHref}
${firstHead}
<style>
.quiz-step { width: 100%; min-height: 100vh; }
.quiz-step[hidden] { display: none !important; }
[data-wq-advance] { cursor: pointer; }
[data-wq-advance='option']:hover { filter: brightness(0.97); }
</style>
</head>
<body>
${stepsHtml}
${navScript}
</body>
</html>`;
}
