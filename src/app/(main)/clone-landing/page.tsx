'use client';

import { useState, useRef, useEffect } from 'react';
import Header from '@/components/Header';
import {
  Copy,
  Loader2,
  ExternalLink,
  Download,
  Maximize2,
  Minimize2,
  Code,
  Eye,
  RefreshCw,
  Sparkles,
  AlertCircle,
  CheckCircle,
  Wand2,
  ChevronDown,
  ChevronUp,
  Paintbrush,
} from 'lucide-react';
import VisualHtmlEditor from '@/components/VisualHtmlEditor';
import { parseJsonResponse } from '@/lib/safe-fetch';

interface ProductInfo {
  name: string;
  description: string;
  benefits: string[];
  target_audience: string;
  price: string;
  cta_text: string;
  cta_url: string;
  brand_name: string;
  social_proof: string;
}

const defaultProduct: ProductInfo = {
  name: '',
  description: '',
  benefits: ['', '', ''],
  target_audience: '',
  price: '',
  cta_text: 'Get Started',
  cta_url: '',
  brand_name: '',
  social_proof: '',
};

type Auditor = 'claude' | 'neo' | 'morfeo';

const AUDITOR_LABEL: Record<Auditor, string> = {
  claude: 'Claude (server)',
  neo: 'Neo (OpenClaw locale)',
  morfeo: 'Morfeo (OpenClaw locale)',
};

const AUDITOR_TARGET_AGENT: Record<Auditor, string | null> = {
  claude: null,
  neo: 'openclaw:neo',
  morfeo: 'openclaw:morfeo',
};

export default function CloneLandingPage() {
  const [url, setUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSwiping, setIsSwiping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    html: string;
    url: string;
    isSwipedVersion?: boolean;
    swipeInfo?: {
      originalTitle?: string;
      newTitle?: string;
      changesMade?: string[];
      processingTime?: number;
    };
  } | null>(null);
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showSwipeForm, setShowSwipeForm] = useState(false);
  const [product, setProduct] = useState<ProductInfo>(defaultProduct);
  const [tone, setTone] = useState<'professional' | 'friendly' | 'urgent' | 'luxury'>('professional');
  const [language, setLanguage] = useState<'it' | 'en'>('it');
  const [showEditor, setShowEditor] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Auditor selection (Claude server-side vs Neo/Morfeo via OpenClaw queue).
  // Claude path = current synchronous behaviour (single POST, await response).
  // Neo/Morfeo path = enqueue swipe_job in openclaw_messages with a target_agent
  // and poll until status='completed'. The worker fetches the page locally with
  // Playwright (no Netlify timeout, no edge 504) and posts back the cleaned HTML.
  const [auditor, setAuditor] = useState<Auditor>('claude');
  // Live activity log shown while a Neo/Morfeo job is running, so the user
  // sees what's happening instead of staring at a generic spinner for ~30s.
  const [progress, setProgress] = useState<string[]>([]);

  // ── Project picker ─────────────────────────────────────────────────
  // Permette all'utente di legare lo swipe a un progetto esistente
  // (con brief + market research). Quando viene selezionato, passiamo
  // il projectId a /api/swipe/load-knowledge cosi' Neo/Morfeo ricevono
  // anche il brief del progetto e non solo la libreria saved_prompts.
  type ProjectPick = {
    id: string;
    name: string;
    description?: string | null;
    brief?: string | null;
  };
  const [availableProjects, setAvailableProjects] = useState<ProjectPick[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [knowledgeBadge, setKnowledgeBadge] = useState<{
    techniques: number;
    hasBrief: boolean;
    hasMarketResearch: boolean;
    projectName?: string;
  } | null>(null);
  // Brief + market research editabili nel form Swipe.
  // Pre-popolati dal progetto se selezionato. Modificabili a mano.
  // Quello che parte al worker e' SEMPRE questo valore (non quello del DB),
  // cosi' l'utente puo' aggiustare al volo senza andare in Projects.
  const [briefText, setBriefText] = useState<string>('');
  const [marketResearchText, setMarketResearchText] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/projects/list');
        if (!r.ok) return;
        const j = (await r.json()) as { projects?: ProjectPick[] };
        if (!cancelled && Array.isArray(j.projects)) {
          setAvailableProjects(j.projects);
        }
      } catch {/* ignore */}
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSelectProject = async (id: string) => {
    setSelectedProjectId(id);
    if (!id) return;
    const proj = availableProjects.find((p) => p.id === id);
    if (proj) {
      setProduct((curr) => ({
        ...curr,
        name: curr.name?.trim() ? curr.name : proj.name,
        description:
          curr.description?.trim()
            ? curr.description
            : (proj.description || proj.brief || '').slice(0, 1500),
      }));
    }
    // Tira giu' brief + market research del progetto selezionato e
    // pre-popola le textarea, ma solo se sono attualmente vuote
    // (cosi' non sovrascriviamo eventuali modifiche dell'utente).
    try {
      const r = await fetch(`/api/swipe/load-knowledge?projectId=${encodeURIComponent(id)}`);
      if (!r.ok) return;
      const j = await r.json();
      const p = (j?.project || null) as { brief?: string | null; market_research?: unknown } | null;
      if (p) {
        const projBrief = (p.brief || '').toString().trim();
        const projMR = (() => {
          if (!p.market_research) return '';
          if (typeof p.market_research === 'string') return p.market_research.trim();
          try { return JSON.stringify(p.market_research, null, 2); } catch { return ''; }
        })();
        setBriefText((curr) => curr.trim() ? curr : projBrief);
        setMarketResearchText((curr) => curr.trim() ? curr : projMR);
      }
    } catch {/* ignore */}
  };

  const pushProgress = (msg: string) => {
    const t = new Date().toLocaleTimeString();
    setProgress((p) => [...p, `${t}  ${msg}`]);
  };

  /**
   * Clone via OpenClaw worker (Neo or Morfeo). The worker fetches the
   * page locally with Playwright — no Netlify timeout — and posts the
   * cleaned HTML back. We just enqueue + poll openclaw_messages until
   * the row's status flips to completed.
   */
  const handleCloneViaOpenclaw = async (chosen: Auditor) => {
    const targetAgent = AUDITOR_TARGET_AGENT[chosen];
    pushProgress(`Coda OpenClaw → ${AUDITOR_LABEL[chosen]}`);

    const enqueueRes = await fetch('/api/openclaw/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        section: 'swipe_job',
        message: JSON.stringify({
          action: 'clone_landing_local',
          url,
          removeScripts: true,
        }),
        targetAgent,
      }),
    });
    const enqueued = (await enqueueRes.json()) as { id?: string; error?: string };
    if (!enqueueRes.ok || !enqueued.id) {
      throw new Error(`Enqueue fallito: ${enqueued.error || `HTTP ${enqueueRes.status}`}`);
    }
    pushProgress(`Job #${enqueued.id.slice(0, 8)} in coda · in attesa che il worker lo prenda`);

    // Poll for completion. The worker's own fetchCheckpointPageHtml has a
    // 20s plain-fetch + 30s Playwright budget per page, so we give it
    // plenty of headroom — but cap at 5min so a dead worker doesn't
    // block the UI forever (matches the server-side stale-run watchdog).
    const t0 = Date.now();
    const POLL_TIMEOUT_MS = 5 * 60 * 1000;
    const POLL_INTERVAL_MS = 2000;
    let lastStatus: string | null = null;
    while (true) {
      if (Date.now() - t0 > POLL_TIMEOUT_MS) {
        throw new Error(`Timeout: il worker non ha completato il job in ${POLL_TIMEOUT_MS / 1000}s.`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const pollRes = await fetch(`/api/openclaw/queue?id=${encodeURIComponent(enqueued.id)}`);
      const polled = (await pollRes.json()) as {
        status?: string;
        content?: string;
        error?: string;
      };
      if (polled.status && polled.status !== lastStatus) {
        lastStatus = polled.status;
        if (polled.status === 'processing') pushProgress(`Worker ha preso il job · sta scaricando la pagina in locale…`);
      }
      if (polled.status === 'completed' && polled.content) {
        pushProgress(`Job completato`);
        let parsed: { success?: boolean; html?: string; url?: string; method_used?: string; error?: string } = {};
        try {
          parsed = JSON.parse(polled.content);
        } catch {
          throw new Error('Risposta del worker non è JSON valido');
        }
        if (parsed.success === false || !parsed.html) {
          throw new Error(parsed.error || 'Worker ha completato senza HTML');
        }
        return { html: parsed.html, url: parsed.url ?? url, methodUsed: parsed.method_used };
      }
      if (polled.status === 'error' || polled.status === 'failed') {
        throw new Error(polled.error || 'Worker ha fallito il job');
      }
    }
  };

  const handleClone = async () => {
    if (!url.trim()) {
      setError('Enter a valid URL');
      return;
    }

    try {
      new URL(url);
    } catch {
      setError('Invalid URL. Make sure to include http:// or https://');
      return;
    }

    setIsLoading(true);
    setError(null);
    setResult(null);
    setProgress([]);

    try {
      // ── OpenClaw path (Neo / Morfeo) ───────────────────────────
      if (auditor !== 'claude') {
        const cloned = await handleCloneViaOpenclaw(auditor);
        setResult({
          html: cloned.html,
          url: cloned.url,
          isSwipedVersion: false,
        });
        setShowSwipeForm(true);
        return;
      }

      // ── Claude path (server-side, current behaviour) ───────────
      const response = await fetch('/api/landing/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const parsed = await parseJsonResponse<{
        html?: string;
        data?: unknown;
        url?: string;
        error?: string;
      }>(response);

      if (!parsed.ok) {
        throw new Error(parsed.error || `HTTP ${parsed.status}`);
      }
      const data = parsed.data!;

      if (data.html) {
        setResult({
          html: data.html,
          url: data.url ?? url,
          isSwipedVersion: false,
        });
        setShowSwipeForm(true);
      } else if (data.data) {
        setResult({
          html: `<pre style="padding: 20px; font-family: monospace;">${JSON.stringify(data.data, null, 2)}</pre>`,
          url: data.url ?? url,
        });
      } else {
        throw new Error('No content received');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Swipe via OpenClaw worker (Neo or Morfeo). The worker reuses the
   * already-cloned HTML we have in `result.html` (no second fetch),
   * runs the LLM rewrite loop against the local OpenClaw model, and
   * comes back with the same shape /api/landing/swipe returns.
   */
  const handleSwipeViaOpenclaw = async (chosen: Auditor) => {
    if (!result?.html) throw new Error('No cloned HTML to swipe — clone first');
    const targetAgent = AUDITOR_TARGET_AGENT[chosen];

    pushProgress(`Coda OpenClaw → ${AUDITOR_LABEL[chosen]} (swipe)`);

    // Carica la libreria saved_prompts E il progetto (se selezionato).
    // PRECEDENZA brief/MR: textarea manuali > brief/MR del progetto. Cosi'
    // l'utente puo' overrideare a mano, ma se le textarea sono vuote NON
    // perdiamo il brief del progetto (era il bug: Neo/Morfeo non sostituivano
    // nome dottore / durata audio / prezzi perche' il brief non arrivava).
    pushProgress('Carico libreria tecniche dal tool…');
    let prompts: unknown[] = [];
    let projName: string | undefined;
    let projBriefFromDb = '';
    let projMrFromDb: unknown = null;
    try {
      const qs = selectedProjectId
        ? `?projectId=${encodeURIComponent(selectedProjectId)}`
        : '';
      const kRes = await fetch(`/api/swipe/load-knowledge${qs}`);
      if (kRes.ok) {
        const kj = await kRes.json();
        prompts = Array.isArray(kj.prompts) ? kj.prompts : [];
        const kproj = kj?.project as { name?: string; brief?: string | null; market_research?: unknown } | null;
        projName = (kproj?.name as string | undefined) || availableProjects.find((p) => p.id === selectedProjectId)?.name;
        projBriefFromDb = (kproj?.brief && String(kproj.brief).trim()) || '';
        projMrFromDb = kproj?.market_research ?? null;
      }
    } catch {/* non fatale */}

    const briefManual = (briefText || '').trim();
    const mrManual = (marketResearchText || '').trim();
    const briefForJob = briefManual || projBriefFromDb;
    const mrForJob = (() => {
      if (mrManual) return mrManual;
      if (!projMrFromDb) return '';
      if (typeof projMrFromDb === 'string') return projMrFromDb;
      try { return JSON.stringify(projMrFromDb); } catch { return ''; }
    })();
    const briefSource = briefManual ? 'manuale' : (projBriefFromDb ? 'progetto' : 'mancante');
    const mrSource = mrManual ? 'manuale' : (projMrFromDb ? 'progetto' : 'mancante');

    if (!briefForJob || !mrForJob) {
      const missing: string[] = [];
      if (!briefForJob) missing.push('brief');
      if (!mrForJob) missing.push('market research');
      pushProgress(
        `Nessun ${missing.join(' + ')} fornito (ne' a mano ne' dal progetto) — Neo/Morfeo li ricostruira' dai LORO archivi nel primer step.`,
      );
    }

    setKnowledgeBadge({
      techniques: prompts.length,
      hasBrief: !!briefForJob,
      hasMarketResearch: !!mrForJob,
      projectName: projName,
    });
    pushProgress(
      `Knowledge: ${prompts.length} tecniche + brief ${briefForJob.length} char (${briefSource}) + MR ${mrForJob.length} char (${mrSource})${projName ? ` · progetto "${projName}"` : ''}`,
    );

    const knowledge = {
      prompts,
      project: {
        name: projName || product.name?.trim() || 'Custom',
        brief: briefForJob,
        market_research: mrForJob,
        notes: null,
      },
    };

    const payload = {
      action: 'swipe_landing_local',
      // Always ship the clone result so the worker doesn't re-fetch.
      html: result.html,
      sourceUrl: result.url,
      product: {
        ...product,
        benefits: product.benefits.filter((b) => b.trim()),
      },
      tone,
      language,
      knowledge,
    };

    const enqueueRes = await fetch('/api/openclaw/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        section: 'swipe_job',
        message: JSON.stringify(payload),
        targetAgent,
      }),
    });
    const enqueued = (await enqueueRes.json()) as { id?: string; error?: string };
    if (!enqueueRes.ok || !enqueued.id) {
      throw new Error(`Enqueue fallito: ${enqueued.error || `HTTP ${enqueueRes.status}`}`);
    }
    pushProgress(`Job #${enqueued.id.slice(0, 8)} in coda · in attesa che il worker lo prenda`);

    // Swipe takes a LONG time on local agents: per ogni testo il modello
    // locale (Trinity / equiv) processa ~25K char di system prompt (KB
    // built-in + knowledge tool) e genera la rewrite. ~40s per batch di 5,
    // moltiplicato per ~30 batch su una landing media = 20 min.
    // Tetto a 30 min per non far scadere il polling prima che il worker
    // finisca davvero. La task gira COMUNQUE in background — meglio
    // mostrare "in corso" per 30 min che dare timeout finto a 10 min e
    // perdere il risultato che e' gia' in Supabase.
    const t0 = Date.now();
    const POLL_TIMEOUT_MS = 30 * 60 * 1000;
    const POLL_INTERVAL_MS = 2500;
    let lastStatus: string | null = null;
    while (true) {
      if (Date.now() - t0 > POLL_TIMEOUT_MS) {
        throw new Error(
          `Timeout: il worker non ha completato lo swipe in ${POLL_TIMEOUT_MS / 1000}s. `
          + 'Controlla openclaw-worker.log: se il worker era ancora in elaborazione, il risultato e\' '
          + 'salvato in Supabase ma la UI non puo\' piu\' recuperarlo. Riduci la dimensione della landing '
          + 'o usa un LLM piu\' veloce.',
        );
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const pollRes = await fetch(`/api/openclaw/queue?id=${encodeURIComponent(enqueued.id)}`);
      const polled = (await pollRes.json()) as {
        status?: string;
        content?: string;
        error?: string;
      };
      if (polled.status && polled.status !== lastStatus) {
        lastStatus = polled.status;
        if (polled.status === 'processing') {
          pushProgress(`Worker ha preso il job · estrazione testi → rewrite locale → finalize`);
        }
      }
      if (polled.status === 'completed' && polled.content) {
        pushProgress(`Job completato`);
        let parsed: {
          success?: boolean;
          html?: string;
          original_title?: string;
          new_title?: string;
          changes_made?: Array<string | { from: string; to: string }>;
          replacements?: number;
          totalTexts?: number;
          unresolved_text_ids?: number[];
          finalize_duration_ms?: number;
          error?: string;
        } = {};
        try {
          parsed = JSON.parse(polled.content);
        } catch {
          throw new Error('Risposta del worker non è JSON valido');
        }
        if (parsed.success === false || !parsed.html) {
          throw new Error(parsed.error || 'Worker ha completato senza HTML swipato');
        }
        // changes_made shape differs slightly: server returns
        // [{from,to}], UI expects string[]. Normalise.
        const changesArr = Array.isArray(parsed.changes_made)
          ? parsed.changes_made.map((c) =>
              typeof c === 'string' ? c : `${c.from} → ${c.to}`,
            )
          : undefined;
        if (parsed.replacements !== undefined && parsed.totalTexts !== undefined) {
          pushProgress(
            `${parsed.replacements}/${parsed.totalTexts} testi sostituiti${
              parsed.unresolved_text_ids?.length
                ? ` · ${parsed.unresolved_text_ids.length} non risolti`
                : ''
            }`,
          );
        }
        return {
          html: parsed.html,
          original_title: parsed.original_title,
          new_title: parsed.new_title,
          changes_made: changesArr,
          processing_time_seconds: parsed.finalize_duration_ms
            ? parsed.finalize_duration_ms / 1000
            : undefined,
        };
      }
      if (polled.status === 'error' || polled.status === 'failed') {
        throw new Error(polled.error || 'Worker ha fallito lo swipe');
      }
    }
  };

  const handleSwipe = async () => {
    if (!result?.url) return;
    
    // Validate required fields
    if (!product.name.trim()) {
      setError('Enter the product name');
      return;
    }

    setIsSwiping(true);
    setError(null);
    setProgress([]);

    try {
      // ── OpenClaw path (Neo / Morfeo) ─────────────────────────────
      // Reuses `result.html` so the worker doesn't re-fetch the page.
      // The actual rewrite happens against the local LLM via
      // runRewriteInBatches in openclaw-worker.js.
      if (auditor !== 'claude') {
        const data = await handleSwipeViaOpenclaw(auditor);
        if (!data.html) throw new Error('No HTML received from worker');
        setResult({
          html: data.html,
          url: result.url,
          isSwipedVersion: true,
          swipeInfo: {
            originalTitle: data.original_title,
            newTitle: data.new_title,
            changesMade: data.changes_made,
            processingTime: data.processing_time_seconds,
          },
        });
        setShowSwipeForm(false);
        return;
      }

      // ── Claude path (server-side, current behaviour) ─────────────
      const response = await fetch('/api/landing/swipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_url: result.url,
          product: {
            ...product,
            benefits: product.benefits.filter(b => b.trim()),
          },
          tone,
          language,
        }),
      });

      // Don't call response.json() directly: when Netlify kills the
      // function (504 Gateway Timeout) the body is an HTML error page
      // and the parser dies with "Unexpected token '<'". parseJsonResponse
      // converts that into a human-readable error.
      const parsed = await parseJsonResponse<{
        html?: string;
        error?: string;
        original_title?: string;
        new_title?: string;
        changes_made?: string[];
        processing_time_seconds?: number;
      }>(response);

      if (!parsed.ok) {
        throw new Error(parsed.error || `HTTP ${parsed.status}`);
      }

      const data = parsed.data!;

      if (data.html) {
        setResult({
          html: data.html,
          url: result.url,
          isSwipedVersion: true,
          swipeInfo: {
            originalTitle: data.original_title,
            newTitle: data.new_title,
            changesMade: data.changes_made,
            processingTime: data.processing_time_seconds,
          },
        });
        setShowSwipeForm(false);
      } else {
        throw new Error(data.error || 'No HTML received');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsSwiping(false);
    }
  };

  const handleDownload = () => {
    if (!result?.html) return;
    const filename = result.isSwipedVersion 
      ? `swiped-landing-${product.brand_name || 'custom'}-${Date.now()}.html`
      : `cloned-landing-${Date.now()}.html`;
    
    const blob = new Blob([result.html], { type: 'text/html' });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
  };

  const handleCopyCode = () => {
    if (!result?.html) return;
    navigator.clipboard.writeText(result.html);
  };

  const updateBenefit = (index: number, value: string) => {
    const newBenefits = [...product.benefits];
    newBenefits[index] = value;
    setProduct({ ...product, benefits: newBenefits });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isLoading) {
      handleClone();
    }
  };

  return (
    <div className={`min-h-screen ${isFullscreen ? 'fixed inset-0 z-50 bg-white' : ''}`}>
      {!isFullscreen && (
        <Header
          title="Clone & Swipe Landing"
          subtitle="Clone landing pages and adapt them to your product"
        />
      )}

      <div className={`${isFullscreen ? 'h-full flex flex-col' : 'p-6'}`}>
        {/* Input Section */}
        <div className={`bg-white rounded-xl shadow-sm border border-gray-200 p-4 ${isFullscreen ? 'mx-4 mt-4' : 'mb-6'}`}>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <input
                type="url"
                placeholder="https://example.com/landing-page"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyPress={handleKeyPress}
                disabled={isLoading || isSwiping}
                className="w-full px-4 py-3 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 disabled:bg-gray-100"
              />
              <ExternalLink className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            </div>
            <button
              onClick={handleClone}
              disabled={isLoading || isSwiping || !url.trim()}
              className="px-6 py-3 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Cloning...
                </>
              ) : (
                <>
                  <Copy className="w-5 h-5" />
                  Clone
                </>
              )}
            </button>
          </div>

          {/* Auditor selector — Claude server-side vs Neo/Morfeo via OpenClaw */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-gray-700">Esegui con:</span>
            {(['claude', 'neo', 'morfeo'] as const).map((opt) => {
              const active = auditor === opt;
              const baseClasses =
                'text-sm px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50';
              const colourClasses = active
                ? opt === 'claude'
                  ? 'bg-purple-600 text-white border-purple-600'
                  : opt === 'neo'
                    ? 'bg-emerald-600 text-white border-emerald-600'
                    : 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400';
              return (
                <button
                  key={opt}
                  type="button"
                  disabled={isLoading || isSwiping}
                  onClick={() => setAuditor(opt)}
                  className={`${baseClasses} ${colourClasses}`}
                  title={
                    opt === 'claude'
                      ? 'Clone + swipe server-side via Anthropic + Playwright Netlify (può fallire su SPA grossi o swipe lunghi)'
                      : `Clone + swipe in coda OpenClaw → worker ${opt} fa fetch + rewrite LLM in locale (no 504)`
                  }
                >
                  {AUDITOR_LABEL[opt]}
                </button>
              );
            })}
            {auditor !== 'claude' && (
              <span className="text-xs text-gray-500 ml-1">
                clone + swipe sul PC del worker (no Netlify timeout, LLM locale)
              </span>
            )}
          </div>

          {/* Quick Examples */}
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="text-sm text-gray-500">Examples:</span>
            {['https://stripe.com', 'https://linear.app', 'https://vercel.com'].map((example) => (
              <button
                key={example}
                onClick={() => setUrl(example)}
                className="text-sm text-purple-600 hover:text-purple-800 hover:underline"
              >
                {example.replace('https://', '')}
              </button>
            ))}
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className={`bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 ${isFullscreen ? 'mx-4' : 'mb-6'}`}>
            <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="font-medium text-red-800">Error</h3>
              <p className="text-red-700 text-sm mt-1">{error}</p>
            </div>
          </div>
        )}

        {/* Loading State */}
        {(isLoading || isSwiping) && (
          <div className={`bg-white rounded-xl shadow-sm border border-gray-200 p-8 mb-6 ${isFullscreen ? 'mx-4' : ''}`}>
            <div className="text-center">
              <Loader2 className={`w-10 h-10 animate-spin mx-auto mb-3 ${
                auditor === 'claude'
                  ? 'text-purple-600'
                  : auditor === 'neo'
                    ? 'text-emerald-600'
                    : 'text-blue-600'
              }`} />
              <h3 className="text-lg font-semibold text-gray-900">
                {isSwiping
                  ? auditor === 'claude'
                    ? 'Swipe in corso…'
                    : `Swipe via ${AUDITOR_LABEL[auditor]}…`
                  : auditor === 'claude'
                    ? 'Cloning in corso…'
                    : `Cloning via ${AUDITOR_LABEL[auditor]}…`}
              </h3>
              <p className="text-gray-500 mt-1 text-sm">
                {isSwiping
                  ? auditor === 'claude'
                    ? 'Adatto la landing al tuo prodotto (server-side)'
                    : 'Il worker rewrite ogni testo con il modello locale (no 504, no quota Anthropic)'
                  : auditor === 'claude'
                    ? 'Scarico e processo la pagina sul server Netlify'
                    : 'Il worker scarica la pagina con Playwright in locale (no 504)'}
              </p>
            </div>

            {/* Live activity log — only meaningful when going via OpenClaw.
                Same panel for clone AND swipe, since both share the same
                progress[] state and only one of the two runs at a time. */}
            {auditor !== 'claude' && progress.length > 0 && (
              <div className="mt-4 bg-gray-50 border border-gray-200 rounded-lg p-3 max-h-56 overflow-y-auto">
                {progress.map((line, i) => (
                  <div
                    key={i}
                    className="text-xs font-mono text-gray-700 whitespace-pre-wrap"
                  >
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Swipe Form Panel */}
        {result && !isLoading && !isSwiping && (
          <div className={`bg-gradient-to-r from-orange-50 to-yellow-50 border border-orange-200 rounded-xl mb-6 overflow-hidden ${isFullscreen ? 'mx-4' : ''}`}>
            <button
              onClick={() => setShowSwipeForm(!showSwipeForm)}
              className="w-full px-6 py-4 flex items-center justify-between hover:bg-orange-100/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="bg-orange-100 p-2 rounded-lg">
                  <Wand2 className="w-5 h-5 text-orange-600" />
                </div>
                <div className="text-left">
                  <h3 className="font-semibold text-orange-900">
                    {result.isSwipedVersion ? 'Landing Swiped!' : 'Swipe for your Product'}
                  </h3>
                  <p className="text-sm text-orange-700">
                    {result.isSwipedVersion 
                      ? 'Click to edit data and re-swipe'
                      : 'Enter your product data to adapt the landing'}
                  </p>
                </div>
              </div>
              {showSwipeForm ? (
                <ChevronUp className="w-5 h-5 text-orange-600" />
              ) : (
                <ChevronDown className="w-5 h-5 text-orange-600" />
              )}
            </button>

            {showSwipeForm && (
              <div className="px-6 pb-6 border-t border-orange-200">
                {/* Brief + Market Research — OBBLIGATORI per Neo/Morfeo.
                    Possono venire o dal progetto (selettore) o dalle
                    textarea direttamente. Quello che parte al worker
                    e' SEMPRE il valore delle textarea. */}
                {(() => {
                  const briefOk = briefText.trim().length >= 30;
                  const mrOk = marketResearchText.trim().length >= 30;
                  const blocked = auditor !== 'claude' && (!briefOk || !mrOk);
                  return (
                    <div className={`mt-4 border-2 rounded-lg p-4 ${
                      blocked ? 'bg-red-50 border-red-300' : 'bg-white border-orange-200'
                    }`}>
                      <div className="flex items-start gap-3">
                        <div className={`p-2 rounded-md mt-0.5 ${
                          blocked ? 'bg-red-100' : 'bg-orange-100'
                        }`}>
                          <Sparkles className={`w-4 h-4 ${
                            blocked ? 'text-red-600' : 'text-orange-600'
                          }`} />
                        </div>
                        <div className="flex-1">
                          <label className="block text-sm font-semibold text-gray-800 mb-1">
                            Brief & Market Research
                            {auditor !== 'claude' && (
                              <span className="ml-1 text-red-600 font-bold">* OBBLIGATORI per Neo/Morfeo</span>
                            )}
                          </label>
                          <p className="text-xs text-gray-600 mb-3">
                            Neo e Morfeo usano questi due testi per scegliere big idea + leve, e applicano le tecniche di <b>Stefan Georgi, Sultanic, Eugene Schwartz, Gary Halbert, John Caples, Gary Bencivenga, David Ogilvy, John Carlton, Dan Kennedy, Sugarman, Hopkins, Collier</b> dai loro archivi interni.
                          </p>

                          {availableProjects.length > 0 && (
                            <div className="mb-3">
                              <label className="block text-xs font-medium text-gray-600 mb-1">
                                Pre-popola da un progetto esistente (opzionale)
                              </label>
                              <select
                                value={selectedProjectId}
                                onChange={(e) => handleSelectProject(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 text-sm"
                              >
                                <option value="">— Nessuno (compila a mano sotto) —</option>
                                {availableProjects.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs font-medium text-gray-700 mb-1">
                                Brief del progetto {auditor !== 'claude' && <span className="text-red-600">*</span>}
                                <span className={`ml-2 ${briefOk ? 'text-emerald-600' : 'text-red-600'}`}>
                                  {briefText.trim().length} char {briefOk ? '✓' : '(min 30)'}
                                </span>
                              </label>
                              <textarea
                                value={briefText}
                                onChange={(e) => setBriefText(e.target.value)}
                                placeholder="Cosa stiamo vendendo, a chi, con che positioning, USP, claim approvati, voice/tone, vincoli legali. Anche poche righe ma concrete (es: target avatar, 3 obiezioni principali, 2 USP unici, prezzo, social proof disponibili)."
                                rows={6}
                                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 text-sm font-mono ${
                                  auditor !== 'claude' && !briefOk
                                    ? 'border-red-400 focus:ring-red-500 focus:border-red-500'
                                    : 'border-gray-300 focus:ring-orange-500 focus:border-orange-500'
                                }`}
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-700 mb-1">
                                Market research {auditor !== 'claude' && <span className="text-red-600">*</span>}
                                <span className={`ml-2 ${mrOk ? 'text-emerald-600' : 'text-red-600'}`}>
                                  {marketResearchText.trim().length} char {mrOk ? '✓' : '(min 30)'}
                                </span>
                              </label>
                              <textarea
                                value={marketResearchText}
                                onChange={(e) => setMarketResearchText(e.target.value)}
                                placeholder="Awareness level (Schwartz), market sophistication, big competitor, angle che funzionano nel settore, language pattern del target, pain points, desideri primari/secondari, formati creativi vincenti, recensioni dei concorrenti."
                                rows={6}
                                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 text-sm font-mono ${
                                  auditor !== 'claude' && !mrOk
                                    ? 'border-red-400 focus:ring-red-500 focus:border-red-500'
                                    : 'border-gray-300 focus:ring-orange-500 focus:border-orange-500'
                                }`}
                              />
                            </div>
                          </div>

                          {knowledgeBadge && (
                            <div className="mt-3 flex flex-wrap gap-2 text-xs">
                              <span className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full">
                                ✓ {knowledgeBadge.techniques} tecniche libreria
                              </span>
                              {knowledgeBadge.projectName && (
                                <span className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-full">
                                  Progetto "{knowledgeBadge.projectName}"
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                  {/* Left Column */}
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Product Name *
                      </label>
                      <input
                        type="text"
                        value={product.name}
                        onChange={(e) => setProduct({ ...product, name: e.target.value })}
                        placeholder="E.g. PayFlow"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Brand Name
                      </label>
                      <input
                        type="text"
                        value={product.brand_name}
                        onChange={(e) => setProduct({ ...product, brand_name: e.target.value })}
                        placeholder="E.g. PayFlow"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Description
                      </label>
                      <textarea
                        value={product.description}
                        onChange={(e) => setProduct({ ...product, description: e.target.value })}
                        placeholder="Describe your product..."
                        rows={3}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Target Audience
                      </label>
                      <input
                        type="text"
                        value={product.target_audience}
                        onChange={(e) => setProduct({ ...product, target_audience: e.target.value })}
                        placeholder="E.g. Small e-commerce businesses"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      />
                    </div>
                  </div>

                  {/* Right Column */}
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Benefits (one per line)
                      </label>
                      {product.benefits.map((benefit, index) => (
                        <input
                          key={index}
                          type="text"
                          value={benefit}
                          onChange={(e) => updateBenefit(index, e.target.value)}
                          placeholder={`Benefit ${index + 1}`}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 mb-2"
                        />
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Price
                        </label>
                        <input
                          type="text"
                          value={product.price}
                          onChange={(e) => setProduct({ ...product, price: e.target.value })}
                          placeholder="E.g. $29/month"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          CTA Text
                        </label>
                        <input
                          type="text"
                          value={product.cta_text}
                          onChange={(e) => setProduct({ ...product, cta_text: e.target.value })}
                          placeholder="Start Free"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        CTA URL
                      </label>
                      <input
                        type="url"
                        value={product.cta_url}
                        onChange={(e) => setProduct({ ...product, cta_url: e.target.value })}
                        placeholder="https://yoursite.com/signup"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Social Proof
                      </label>
                      <input
                        type="text"
                        value={product.social_proof}
                        onChange={(e) => setProduct({ ...product, social_proof: e.target.value })}
                        placeholder="E.g. Used by 5,000+ businesses"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Tone
                        </label>
                        <select
                          value={tone}
                          onChange={(e) => setTone(e.target.value as typeof tone)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                        >
                          <option value="professional">Professional</option>
                          <option value="friendly">Friendly</option>
                          <option value="urgent">Urgent</option>
                          <option value="luxury">Luxury</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Language
                        </label>
                        <select
                          value={language}
                          onChange={(e) => setLanguage(e.target.value as typeof language)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                        >
                          <option value="it">Italian</option>
                          <option value="en">English</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                <button
                  onClick={handleSwipe}
                  disabled={isSwiping || !product.name.trim()}
                  className="mt-6 w-full px-6 py-3 bg-gradient-to-r from-orange-500 to-yellow-500 text-white rounded-lg font-medium hover:from-orange-600 hover:to-yellow-600 disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
                >
                  {isSwiping ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Swiping...
                    </>
                  ) : (
                    <>
                      <Wand2 className="w-5 h-5" />
                      Swipa Landing
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Swipe Info Banner */}
        {result?.isSwipedVersion && result.swipeInfo && (
          <div className={`bg-green-50 border border-green-200 rounded-xl p-4 mb-6 ${isFullscreen ? 'mx-4' : ''}`}>
            <div className="flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-green-600 mt-0.5" />
              <div className="flex-1">
                <h3 className="font-medium text-green-900">Landing Swiped Successfully!</h3>
                {result.swipeInfo.processingTime && (
                  <p className="text-sm text-green-700 mt-1">
                    Processing time: {result.swipeInfo.processingTime.toFixed(2)}s
                  </p>
                )}
                {result.swipeInfo.changesMade && result.swipeInfo.changesMade.length > 0 && (
                  <div className="mt-2">
                    <p className="text-sm font-medium text-green-800">Changes made:</p>
                    <ul className="text-sm text-green-700 mt-1 space-y-1">
                      {result.swipeInfo.changesMade.slice(0, 5).map((change, i) => (
                        <li key={i}>• {change}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Result Viewer */}
        {result && !isLoading && !isSwiping && (
          <div className={`bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden ${isFullscreen ? 'flex-1 mx-4 mb-4 flex flex-col' : ''}`}>
            {/* Toolbar */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
              <div className="flex items-center gap-3">
                <CheckCircle className={`w-5 h-5 ${result.isSwipedVersion ? 'text-orange-600' : 'text-green-600'}`} />
                <div>
                  <span className="font-medium text-gray-900">
                    {result.isSwipedVersion ? 'Swiped Landing' : 'Cloned Page'}
                  </span>
                  {result.isSwipedVersion && product.brand_name && (
                    <span className="ml-2 px-2 py-0.5 bg-orange-100 text-orange-800 text-xs rounded-full">
                      {product.brand_name}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* View Mode Toggle */}
                <div className="flex bg-gray-200 rounded-lg p-1">
                  <button
                    onClick={() => setViewMode('preview')}
                    className={`px-3 py-1 rounded text-sm font-medium transition-colors flex items-center gap-1 ${
                      viewMode === 'preview'
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    <Eye className="w-4 h-4" />
                    Preview
                  </button>
                  <button
                    onClick={() => setViewMode('code')}
                    className={`px-3 py-1 rounded text-sm font-medium transition-colors flex items-center gap-1 ${
                      viewMode === 'code'
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    <Code className="w-4 h-4" />
                    HTML
                  </button>
                </div>

                {/* Actions */}
                <button
                  onClick={() => setShowEditor(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600 transition-colors shadow-sm"
                  title="Edit Visually"
                >
                  <Paintbrush className="w-4 h-4" />
                  Edit
                </button>
                <button
                  onClick={handleCopyCode}
                  className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg transition-colors"
                  title="Copy HTML"
                >
                  <Copy className="w-4 h-4" />
                </button>
                <button
                  onClick={handleDownload}
                  className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg transition-colors"
                  title="Download HTML"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setIsFullscreen(!isFullscreen)}
                  className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg transition-colors"
                  title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                >
                  {isFullscreen ? (
                    <Minimize2 className="w-4 h-4" />
                  ) : (
                    <Maximize2 className="w-4 h-4" />
                  )}
                </button>
                <button
                  onClick={handleClone}
                  className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg transition-colors"
                  title="Reload original"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className={`${isFullscreen ? 'flex-1' : 'h-[600px]'}`}>
              {viewMode === 'preview' ? (
                <iframe
                  ref={iframeRef}
                  srcDoc={result.html}
                  className="w-full h-full border-0"
                  title="Landing Page Preview"
                  sandbox="allow-scripts allow-same-origin"
                />
              ) : (
                <div className="h-full overflow-auto bg-gray-900 p-4">
                  <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap">
                    {result.html}
                  </pre>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Instructions */}
        {!result && !isLoading && !error && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <div className="bg-purple-50 border border-purple-200 rounded-xl p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-purple-100 p-2 rounded-lg">
                  <Copy className="w-5 h-5 text-purple-600" />
                </div>
                <h3 className="font-semibold text-purple-900">1. Clone</h3>
              </div>
              <p className="text-purple-800 text-sm">
                Enter the URL of a successful landing page and click &quot;Clone&quot; to download it.
              </p>
            </div>

            <div className="bg-orange-50 border border-orange-200 rounded-xl p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-orange-100 p-2 rounded-lg">
                  <Wand2 className="w-5 h-5 text-orange-600" />
                </div>
                <h3 className="font-semibold text-orange-900">2. Swipe</h3>
              </div>
              <p className="text-orange-800 text-sm">
                Enter your product data and AI will adapt the landing for you automatically.
              </p>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-amber-100 p-2 rounded-lg">
                  <Paintbrush className="w-5 h-5 text-amber-600" />
                </div>
                <h3 className="font-semibold text-amber-900">3. Edit</h3>
              </div>
              <p className="text-amber-800 text-sm">
                Use the visual editor to customize text, images, colors and layout.
              </p>
            </div>

            <div className="bg-green-50 border border-green-200 rounded-xl p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-green-100 p-2 rounded-lg">
                  <Download className="w-5 h-5 text-green-600" />
                </div>
                <h3 className="font-semibold text-green-900">4. Use</h3>
              </div>
              <p className="text-green-800 text-sm">
                Download the final HTML and use it for your business.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Visual HTML Editor */}
      {showEditor && result?.html && (
        <VisualHtmlEditor
          initialHtml={result.html}
          pageTitle={result.isSwipedVersion ? `Swiped Landing - ${product.brand_name || 'Custom'}` : 'Cloned Landing'}
          onSave={(html) => {
            setResult({ ...result, html });
          }}
          onClose={() => setShowEditor(false)}
        />
      )}
    </div>
  );
}
