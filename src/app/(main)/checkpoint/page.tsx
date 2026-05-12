'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import Header from '@/components/Header';
import {
  ShieldCheck,
  ExternalLink,
  Loader2,
  Search,
  Filter,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Clock,
  Plus,
  Trash2,
  X,
  History,
  User as UserIcon,
  Pencil,
  Check,
  Sparkles,
  Globe,
  Layers,
  Wand2,
  MousePointer2,
  RefreshCw,
  FolderOpen,
} from 'lucide-react';
import type {
  CheckpointFunnel,
  CheckpointLogEntry,
} from '@/types/checkpoint';
import {
  BUILT_IN_PAGE_TYPE_OPTIONS,
  PAGE_TYPE_CATEGORIES,
  type PageTypeOption,
} from '@/types';
import { getCurrentUserName, setCurrentUserName } from '@/lib/current-user';
import ImportFromProjectsModal, {
  type PickedProject,
} from '@/components/checkpoint/ImportFromProjectsModal';

// ─── Page-type heuristic (Landing single-page flow) ────────────────
// Best-effort guess of the page type from the URL path + step name.
// Used to pre-select the dropdown when the user picks a URL — they
// can still override before submitting.
function guessPageType(args: { url?: string; name?: string }): string {
  const hay = `${args.url ?? ''} ${args.name ?? ''}`.toLowerCase();
  if (/checkout|order|purchase/.test(hay)) return 'checkout';
  if (/upsell|oto|one[- ]?time/.test(hay)) return 'upsell';
  if (/downsell/.test(hay)) return 'downsell';
  if (/thank[- ]?you|grazie|confirmation/.test(hay)) return 'thank_you';
  if (/quiz|survey|assessment/.test(hay)) return 'quiz_funnel';
  if (/advertorial|listicle|article|presell/.test(hay)) return 'advertorial';
  if (/vsl|video[- ]?sales|webinar/.test(hay)) return 'vsl';
  if (/opt[- ]?in|squeeze|lead/.test(hay)) return 'opt_in';
  if (/sales|offer|product/.test(hay)) return 'sales_letter';
  return 'landing';
}

function ScorePill({ score }: { score: number | null }) {
  if (score === null || score === undefined) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500 border border-gray-200">
        <HelpCircle className="w-3 h-3" />
        Mai controllato
      </span>
    );
  }
  let cls = 'bg-emerald-100 text-emerald-700 border-emerald-200';
  let Icon = CheckCircle2;
  if (score < 50) {
    cls = 'bg-red-100 text-red-700 border-red-200';
    Icon = XCircle;
  } else if (score < 80) {
    cls = 'bg-amber-100 text-amber-700 border-amber-200';
    Icon = AlertTriangle;
  }
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border font-medium ${cls}`}
    >
      <Icon className="w-3 h-3" />
      {score}/100
    </span>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('it-IT', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function shortDomain(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url.slice(0, 50);
  }
}

type StatusFilter = 'all' | 'never' | 'pass' | 'warn' | 'fail';

export default function CheckpointPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Track which IDs were just imported via the Projects page modal so
  // we can surface a banner + faint highlight in the table.
  const importedIds = useMemo(() => {
    const raw = searchParams?.get('imported') ?? '';
    return raw
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  }, [searchParams]);
  const skippedCount = useMemo(() => {
    const raw = searchParams?.get('skipped') ?? '';
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [searchParams]);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const dismissBanner = () => {
    setBannerDismissed(true);
    // Strip the query params so a refresh doesn't re-show the banner.
    router.replace('/checkpoint');
  };

  const [funnels, setFunnels] = useState<CheckpointFunnel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // Inline "add" panel under the toolbar. The two top-level buttons
  // (Landing / Funnel) toggle which sub-form is visible.
  //   - closed        → no panel visible
  //   - landing       → single URL form
  //   - funnel-pick   → 2 cards: manual vs auto-discover
  //   - funnel-manual → list of URL inputs the user fills in by hand
  //   - funnel-auto   → one entry URL → crawl → pick discovered steps
  type AddMode =
    | 'closed'
    | 'landing'
    | 'funnel-pick'
    | 'funnel-manual'
    | 'funnel-auto';
  const [addMode, setAddMode] = useState<AddMode>('closed');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [formName, setFormName] = useState('');

  // Landing mode: single URL + page type. The page type drives the
  // audit's KB injection (advertorial → advertorial bundle, vsl → VSL
  // bundle, etc.) so the analysis is tailored to the page's role.
  const [landingUrl, setLandingUrl] = useState('');
  const [landingPageType, setLandingPageType] = useState<string>('landing');

  // Funnel manual mode: one URL per row, +/- buttons to manage rows.
  const [manualPages, setManualPages] = useState<string[]>(['', '']);

  // Funnel auto mode: enter one URL → crawl → choose which steps to keep.
  const [autoEntryUrl, setAutoEntryUrl] = useState('');
  const [autoCrawling, setAutoCrawling] = useState(false);
  const [autoJobId, setAutoJobId] = useState<string | null>(null);
  const [autoProgress, setAutoProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [autoSteps, setAutoSteps] = useState<
    { url: string; title: string }[] | null
  >(null);
  const [autoSelected, setAutoSelected] = useState<Set<number>>(new Set());

  const resetAddState = () => {
    setAddError(null);
    setFormName('');
    setLandingUrl('');
    setLandingPageType('landing');
    setManualPages(['', '']);
    setAutoEntryUrl('');
    setAutoJobId(null);
    setAutoProgress(null);
    setAutoSteps(null);
    setAutoSelected(new Set());
  };

  const closeAddPanel = () => {
    if (adding || autoCrawling) return;
    setAddMode('closed');
    resetAddState();
  };

  /** Toggle helper used by the two top-level toolbar buttons. Clicking
   *  the same button twice closes the inline panel; clicking the other
   *  swaps to it (resetting per-mode form state in between).
   *
   *  When a project is currently selected (`selectedProject` !== null)
   *  we pre-fill the form: Landing seeds the URL with the project's
   *  first detected URL (the radio list lets the user switch); Funnel
   *  skips the manual/auto pick and jumps straight into the manual
   *  list pre-populated with all project URLs. */
  const toggleAddMode = (target: 'landing' | 'funnel-pick') => {
    if (adding || autoCrawling) return;
    setAddError(null);
    if (
      (target === 'landing' && addMode === 'landing') ||
      (target === 'funnel-pick' &&
        (addMode === 'funnel-pick' ||
          addMode === 'funnel-manual' ||
          addMode === 'funnel-auto'))
    ) {
      setAddMode('closed');
      resetAddState();
      return;
    }
    resetAddState();

    if (target === 'landing') {
      if (selectedProject && selectedProject.detectedUrls.length > 0) {
        const first = selectedProject.detectedUrls[0];
        setProjectLandingIdx(0);
        setLandingUrl(first?.url ?? '');
        setFormName(selectedProject.name);
        setLandingPageType(
          guessPageType({ url: first?.url, name: first?.name }),
        );
      }
      setAddMode('landing');
      return;
    }

    // target === 'funnel-pick'
    if (selectedProject && selectedProject.detectedUrls.length > 0) {
      setManualPages(
        selectedProject.detectedUrls.map((u) => u.url).filter(Boolean),
      );
      setFormName(selectedProject.name);
      setAddMode('funnel-manual');
      return;
    }
    setAddMode('funnel-pick');
  };

  /** Called by the "My Projects" modal when the user picks a project.
   *  Stores the project so the existing Landing / Funnel buttons
   *  inherit its URLs on next click. */
  const handlePickProject = (p: PickedProject) => {
    setSelectedProject(p);
    setProjectLandingIdx(0);
    // If the user already has a panel open, refresh its content so it
    // reflects the new project. Closing+reopening is the cheapest way
    // to re-run the pre-fill logic in toggleAddMode.
    if (addMode !== 'closed' && !adding && !autoCrawling) {
      const wasFunnel =
        addMode === 'funnel-pick' ||
        addMode === 'funnel-manual' ||
        addMode === 'funnel-auto';
      resetAddState();
      if (wasFunnel) {
        setManualPages(p.detectedUrls.map((u) => u.url).filter(Boolean));
        setFormName(p.name);
        setAddMode(p.detectedUrls.length > 0 ? 'funnel-manual' : 'funnel-pick');
      } else {
        const first = p.detectedUrls[0];
        setLandingUrl(first?.url ?? '');
        setFormName(p.name);
        setLandingPageType(
          first ? guessPageType({ url: first.url, name: first.name }) : 'landing',
        );
        setAddMode('landing');
      }
    }
  };

  const clearSelectedProject = () => {
    setSelectedProject(null);
    setProjectLandingIdx(0);
  };

  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Audit log modal.
  const [showLog, setShowLog] = useState(false);
  const [logEntries, setLogEntries] = useState<CheckpointLogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  // "My Projects" picker. Selecting a project here doesn't import
  // anything by itself — it just stores the project in
  // `selectedProject` so the existing Landing / Funnel buttons can
  // pre-fill their forms with that project's detected URLs.
  const [showProjectsImport, setShowProjectsImport] = useState(false);
  const [selectedProject, setSelectedProject] =
    useState<PickedProject | null>(null);
  /** Index of which project URL is the chosen one in the Landing form
   *  (only used when `selectedProject` is set; the radio list above
   *  the URL input drives this). */
  const [projectLandingIdx, setProjectLandingIdx] = useState<number>(0);

  // "Who am I" — placeholder until auth lands.
  const [userName, setUserName] = useState<string>('Owner');
  const [editingUser, setEditingUser] = useState(false);
  const [userDraft, setUserDraft] = useState('');
  useEffect(() => {
    setUserName(getCurrentUserName());
  }, []);
  const commitUserName = () => {
    const next = userDraft.trim() || 'Owner';
    setCurrentUserName(next);
    setUserName(next);
    setEditingUser(false);
  };

  const openLog = async () => {
    setShowLog(true);
    setLogLoading(true);
    setLogError(null);
    try {
      const res = await fetch('/api/checkpoint/logs');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { entries: CheckpointLogEntry[] };
      setLogEntries(data.entries);
    } catch (err) {
      setLogError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogLoading(false);
    }
  };

  const reload = () => {
    setLoading(true);
    setError(null);
    fetch('/api/checkpoint/funnels')
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<{ funnels: CheckpointFunnel[] }>;
      })
      .then((data) => setFunnels(data.funnels))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return funnels.filter((f) => {
      if (statusFilter !== 'all') {
        const score = f.last_score_overall;
        if (statusFilter === 'never' && f.last_run_id) return false;
        if (statusFilter === 'pass' && (score === null || score < 80)) return false;
        if (
          statusFilter === 'warn' &&
          (score === null || score < 50 || score >= 80)
        )
          return false;
        if (statusFilter === 'fail' && (score === null || score >= 50)) return false;
      }
      if (q) {
        const hay = `${f.name} ${f.url}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [funnels, search, statusFilter]);

  const stats = useMemo(() => {
    const total = funnels.length;
    const checked = funnels.filter((f) => f.last_run_id).length;
    const passing = funnels.filter(
      (f) => (f.last_score_overall ?? -1) >= 80,
    ).length;
    const failing = funnels.filter(
      (f) => f.last_score_overall !== null && f.last_score_overall < 50,
    ).length;
    return { total, checked, passing, failing };
  }, [funnels]);

  /** Shared submitter used by all three add modes. Each mode resolves
   *  its own `urls` list and delegates here so name handling, error
   *  handling and reload-on-success live in one place. When a project
   *  is selected, its id is forwarded so the new funnel is linked to
   *  the project for back-references. */
  const submitFunnel = async (
    urls: string[],
    opts: { pageType?: string } = {},
  ) => {
    const cleaned = urls.map((u) => u.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      throw new Error('Inserisci almeno una URL.');
    }
    const pages = cleaned.map((url) => ({ url }));
    const res = await fetch('/api/checkpoint/funnels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pages,
        name: formName.trim() || undefined,
        project_id: selectedProject?.id,
        page_type: opts.pageType,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  };

  const handleAddLanding = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    try {
      await submitFunnel([landingUrl], { pageType: landingPageType });
      closeAddPanel();
      reload();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  const handleAddManual = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    try {
      await submitFunnel(manualPages);
      closeAddPanel();
      reload();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  const handleAddAuto = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!autoSteps || autoSteps.length === 0) return;
    setAdding(true);
    setAddError(null);
    try {
      const urls = Array.from(autoSelected)
        .sort((a, b) => a - b)
        .map((i) => autoSteps[i]?.url)
        .filter((u): u is string => !!u);
      await submitFunnel(urls);
      closeAddPanel();
      reload();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  /** Kick off the funnel crawler and poll for completion. The crawl
   *  job lives in `/api/funnel-analyzer/crawl/*` and runs Playwright
   *  in the background, so the only thing we have to do here is poll
   *  every ~1.5s and surface progress in the modal. */
  const startAutoCrawl = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);
    setAutoSteps(null);
    setAutoSelected(new Set());
    setAutoProgress(null);
    setAutoCrawling(true);
    try {
      const startRes = await fetch('/api/funnel-analyzer/crawl/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryUrl: autoEntryUrl.trim(),
          // Agentic / quiz mode: instead of a dumb BFS over <a href>
          // links (which fails on SPAs, ad trackers, and any modern
          // funnel where "next" is a JS button), open the page like
          // a real user, fill any required form fields with sensible
          // defaults, click the most-likely-CTA button, repeat until
          // we hit a checkout-like URL or stop seeing new content.
          // Captures URL + title (no screenshots/network/cookies for
          // speed — we only need the URL list to seed the checkpoint
          // funnel pages).
          quizMode: true,
          quizMaxSteps: 25,
          maxSteps: 25,
          captureScreenshots: false,
          captureNetwork: false,
          captureCookies: false,
        }),
      });
      const startBody = await startRes.json();
      if (!startRes.ok || !startBody?.jobId) {
        throw new Error(startBody?.error ?? `HTTP ${startRes.status}`);
      }
      const jobId = startBody.jobId as string;
      setAutoJobId(jobId);

      // Poll until 'completed' or 'failed'. Cap the loop at the lambda's
      // 300s ceiling (see netlify.toml maxDuration on /crawl/start) plus
      // a 30s grace window for the final updateJob() to land in Supabase.
      // Keeping the client cap = lambda cap means we never give up before
      // the server itself does — the user gets the real failure reason
      // (most often "Crawl runner error: <something>") instead of a
      // generic client-side "timeout".
      const giveUpAt = Date.now() + 5.5 * 60 * 1000;
      while (Date.now() < giveUpAt) {
        await new Promise((r) => setTimeout(r, 1500));
        const statusRes = await fetch(
          `/api/funnel-analyzer/crawl/status/${jobId}`,
          { cache: 'no-store' },
        );
        const statusBody = await statusRes.json();
        if (!statusRes.ok) {
          throw new Error(statusBody?.error ?? `HTTP ${statusRes.status}`);
        }
        setAutoProgress({
          current: statusBody.currentStep ?? 0,
          total: statusBody.totalSteps ?? 0,
        });
        if (statusBody.status === 'completed') {
          const steps = (statusBody.result?.steps ?? []) as {
            url: string;
            title?: string;
          }[];
          if (steps.length === 0) {
            throw new Error(
              "Il crawler non ha trovato pagine. Prova in modalità manuale.",
            );
          }
          const cleaned = steps.map((s) => ({
            url: s.url,
            title: s.title || s.url,
          }));
          setAutoSteps(cleaned);
          setAutoSelected(new Set(cleaned.map((_, i) => i)));
          return;
        }
        if (statusBody.status === 'failed') {
          throw new Error(statusBody.error ?? 'Crawl fallito.');
        }
      }
      throw new Error('Timeout: il crawler ha impiegato troppo. Riprova.');
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutoCrawling(false);
    }
  };

  const toggleAutoStep = (i: number) => {
    setAutoSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Eliminare "${name}" e tutto lo storico dei suoi checkpoint?`)) {
      return;
    }
    setDeletingId(id);
    try {
      const res = await fetch(`/api/checkpoint/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setFunnels((prev) => prev.filter((f) => f.id !== id));
    } catch (err) {
      alert(`Errore eliminazione: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="Checkpoint"
        subtitle="Audit qualitativo dei funnel multi-step: navigazione, coerenza interna, copy quality"
      />

      <div className="px-6 py-6 space-y-6">
        {/* Import-success banner — shown after a "Checkpoint" import
            from the Projects page redirects here. */}
        {!bannerDismissed && (importedIds.length > 0 || skippedCount > 0) && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 flex items-start gap-3">
            <Sparkles className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-emerald-900">
                {importedIds.length > 0
                  ? `${importedIds.length} pagina${importedIds.length === 1 ? '' : 'e'} importata${importedIds.length === 1 ? '' : 'e'} dal progetto.`
                  : 'Import completato.'}
                {skippedCount > 0 && (
                  <span className="text-emerald-700 font-normal">
                    {' '}
                    {skippedCount} ignorat{skippedCount === 1 ? 'a' : 'e'} (URL
                    duplicat{skippedCount === 1 ? 'o' : 'i'} o non valid
                    {skippedCount === 1 ? 'o' : 'i'}).
                  </span>
                )}
              </p>
              <p className="text-xs text-emerald-700 mt-0.5">
                Ora puoi avviare il checkpoint su una singola pagina cliccandola
                qui sotto.
              </p>
            </div>
            <button
              onClick={dismissBanner}
              className="p-1 text-emerald-700 hover:bg-emerald-100 rounded"
              title="Chiudi"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Stats strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Totale" value={stats.total} />
          <StatCard label="Controllati" value={stats.checked} accent="blue" />
          <StatCard label="Pass (≥80)" value={stats.passing} accent="emerald" />
          <StatCard label="Fail (<50)" value={stats.failing} accent="red" />
        </div>

        {/* Toolbar */}
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cerca per nome o URL..."
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <FilterSelect
              icon={<Filter className="w-4 h-4" />}
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as StatusFilter)}
              options={[
                { value: 'all', label: 'Qualunque stato' },
                { value: 'never', label: 'Mai controllati' },
                { value: 'pass', label: 'Pass (≥80)' },
                { value: 'warn', label: 'Warning (50-79)' },
                { value: 'fail', label: 'Fail (<50)' },
              ]}
            />

            <button
              onClick={openLog}
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
              title="Mostra il log di tutti i checkpoint eseguiti"
            >
              <History className="w-4 h-4" />
              Log
            </button>

            <button
              onClick={() => setShowProjectsImport(true)}
              disabled={adding || autoCrawling}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 ${
                selectedProject
                  ? 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm'
                  : 'bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-50'
              }`}
              title={
                selectedProject
                  ? `Progetto attivo: ${selectedProject.name} — clicca per cambiarlo`
                  : 'Scegli un progetto, poi usa Landing o Funnel'
              }
            >
              <FolderOpen className="w-4 h-4" />
              {selectedProject ? selectedProject.name : 'My Projects'}
            </button>

            <button
              onClick={() => toggleAddMode('landing')}
              disabled={adding || autoCrawling}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg shadow-sm transition-colors disabled:opacity-50 ${
                addMode === 'landing'
                  ? 'bg-emerald-700 text-white ring-2 ring-emerald-300'
                  : 'bg-emerald-600 text-white hover:bg-emerald-700'
              }`}
              title="Audit di una singola pagina"
            >
              <Globe className="w-4 h-4" />
              Landing
            </button>
            <button
              onClick={() => toggleAddMode('funnel-pick')}
              disabled={adding || autoCrawling}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg shadow-sm transition-colors disabled:opacity-50 ${
                addMode === 'funnel-pick' ||
                addMode === 'funnel-manual' ||
                addMode === 'funnel-auto'
                  ? 'bg-blue-700 text-white ring-2 ring-blue-300'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
              title="Audit di un funnel multi-step"
            >
              <Layers className="w-4 h-4" />
              Funnel
            </button>
          </div>

          {/* Active project context strip. Visible only when the user
              has selected a project via the "My Projects" picker —
              tells them the next Landing/Funnel click will operate on
              that project's pages. */}
          {selectedProject && (
            <div className="mt-3 flex items-center gap-2 text-xs px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg">
              <FolderOpen className="w-3.5 h-3.5 text-indigo-600" />
              <span className="text-indigo-900">
                Operando su:{' '}
                <strong className="font-semibold">
                  {selectedProject.name}
                </strong>{' '}
                <span className="text-indigo-600 font-normal">
                  · {selectedProject.detectedUrls.length} URL rilevat
                  {selectedProject.detectedUrls.length === 1 ? 'o' : 'i'} ·
                  Landing = singola pagina · Funnel = tutto il flusso
                </span>
              </span>
              <button
                type="button"
                onClick={() => setShowProjectsImport(true)}
                className="ml-auto text-indigo-600 hover:text-indigo-800 hover:underline"
              >
                Cambia
              </button>
              <button
                type="button"
                onClick={clearSelectedProject}
                className="p-0.5 text-indigo-500 hover:bg-indigo-100 rounded"
                title="Rimuovi progetto attivo"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* "Who am I" strip. Will be replaced by auth session lookup
              once the users table lands. */}
          <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
            <UserIcon className="w-3.5 h-3.5" />
            <span>Stai operando come:</span>
            {editingUser ? (
              <>
                <input
                  type="text"
                  value={userDraft}
                  autoFocus
                  onChange={(e) => setUserDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitUserName();
                    if (e.key === 'Escape') setEditingUser(false);
                  }}
                  placeholder="Tuo nome"
                  className="px-2 py-0.5 border border-gray-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 w-40"
                />
                <button
                  onClick={commitUserName}
                  className="p-1 text-emerald-600 hover:bg-emerald-50 rounded"
                  title="Salva"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setEditingUser(false)}
                  className="p-1 text-gray-400 hover:bg-gray-100 rounded"
                  title="Annulla"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </>
            ) : (
              <>
                <strong className="text-gray-700">{userName}</strong>
                <button
                  onClick={() => {
                    setUserDraft(userName === 'Owner' ? '' : userName);
                    setEditingUser(true);
                  }}
                  className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                  title="Cambia nome"
                >
                  <Pencil className="w-3 h-3" />
                </button>
                <span className="text-gray-400">
                  · ogni run viene loggato con questo nome
                </span>
              </>
            )}
          </div>
        </div>

        {/* Inline add panel — shown right under the toolbar when the
            user clicks the Landing or Funnel button. */}
        {addMode !== 'closed' && (
          <div
            className={`bg-white rounded-lg border p-5 ${
              addMode === 'landing'
                ? 'border-emerald-200 shadow-emerald-100/40'
                : 'border-blue-200 shadow-blue-100/40'
            } shadow-sm`}
          >
            {/* Header strip with title + close (X) */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2">
                {addMode === 'landing' && (
                  <Globe className="w-4 h-4 text-emerald-600" />
                )}
                {(addMode === 'funnel-pick' ||
                  addMode === 'funnel-manual' ||
                  addMode === 'funnel-auto') && (
                  <Layers className="w-4 h-4 text-blue-600" />
                )}
                <h3 className="text-sm font-semibold text-gray-900">
                  {addMode === 'landing' && 'Aggiungi una landing'}
                  {addMode === 'funnel-pick' && 'Aggiungi un funnel'}
                  {addMode === 'funnel-manual' &&
                    'Funnel multi-step (manuale)'}
                  {addMode === 'funnel-auto' &&
                    'Funnel da URL iniziale (auto)'}
                </h3>
                {(addMode === 'funnel-manual' ||
                  addMode === 'funnel-auto') && (
                  <button
                    type="button"
                    onClick={() => {
                      if (adding || autoCrawling) return;
                      setAddError(null);
                      setAddMode('funnel-pick');
                    }}
                    className="ml-2 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-blue-600"
                  >
                    <ArrowLeft className="w-3 h-3" />
                    Cambia modalità
                  </button>
                )}
              </div>
              <button
                onClick={closeAddPanel}
                disabled={adding || autoCrawling}
                className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-50"
                title="Chiudi"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Screen: landing (single URL).
                When a project is selected and has detected URLs, we
                show a radio list of the project's pages above the URL
                input — clicking a row pre-fills the URL so the user
                can still tweak it before saving. */}
            {addMode === 'landing' && (
              <form
                onSubmit={handleAddLanding}
                className="space-y-3"
              >
                {selectedProject &&
                  selectedProject.detectedUrls.length > 0 && (
                    <div className="border border-indigo-200 bg-indigo-50/40 rounded-lg p-3">
                      <div className="text-xs font-medium text-indigo-700 mb-2">
                        Pagine di{' '}
                        <strong>{selectedProject.name}</strong>{' '}
                        <span className="text-indigo-500 font-normal">
                          — scegli quale audire
                        </span>
                      </div>
                      <ul className="space-y-1 max-h-48 overflow-y-auto">
                        {selectedProject.detectedUrls.map((u, i) => {
                          const checked = projectLandingIdx === i;
                          return (
                            <li key={i}>
                              <label
                                className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer ${
                                  checked
                                    ? 'bg-white border border-indigo-300'
                                    : 'hover:bg-white/60'
                                }`}
                              >
                                <input
                                  type="radio"
                                  name="project-landing-url"
                                  checked={checked}
                                  onChange={() => {
                                    setProjectLandingIdx(i);
                                    setLandingUrl(u.url);
                                    setLandingPageType(
                                      guessPageType({ url: u.url, name: u.name }),
                                    );
                                  }}
                                  className="mt-1 accent-indigo-600"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm text-gray-800 font-medium truncate">
                                    {u.name}
                                  </div>
                                  <div className="text-[11px] text-gray-500 font-mono truncate">
                                    {u.url}
                                  </div>
                                </div>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                <PageTypeSelect
                  value={landingPageType}
                  onChange={setLandingPageType}
                />

                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-[260px]">
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      URL della landing{' '}
                      <span className="text-red-500">*</span>
                    </label>
                    <input
                      required
                      type="url"
                      value={landingUrl}
                      onChange={(e) => setLandingUrl(e.target.value)}
                      placeholder="https://esempio.com/landing"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      autoFocus={!selectedProject}
                    />
                  </div>
                  <div className="w-56">
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Nome (opzionale)
                    </label>
                    <input
                      type="text"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="Es: Landing v3"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={adding || !landingUrl.trim()}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {adding ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Aggiungo...
                      </>
                    ) : (
                      <>
                        <Plus className="w-4 h-4" />
                        Aggiungi
                      </>
                    )}
                  </button>
                </div>
                {addError && <ErrorBanner message={addError} />}
              </form>
            )}

            {/* Screen: funnel pick (manual / auto) */}
            {addMode === 'funnel-pick' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <ModeCard
                  icon={<MousePointer2 className="w-5 h-5" />}
                  title="Multi-step manuale"
                  description="Incolla a mano tutti gli URL del funnel, in ordine."
                  onClick={() => setAddMode('funnel-manual')}
                />
                <ModeCard
                  icon={<Wand2 className="w-5 h-5" />}
                  title="Da URL iniziale"
                  description="Dai solo il primo URL: il bot naviga il funnel e ti mostra gli step trovati."
                  onClick={() => setAddMode('funnel-auto')}
                  accent="violet"
                />
              </div>
            )}

            {/* Screen: funnel manual (list of URL inputs).
                When toggled with a project selected, this list comes
                pre-populated with that project's detected URLs (the
                inline note below makes that explicit). */}
            {addMode === 'funnel-manual' && (
              <form onSubmit={handleAddManual} className="space-y-4">
                {selectedProject &&
                  selectedProject.detectedUrls.length > 0 && (
                    <div className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-md px-3 py-2">
                      Pre-compilato dalle pagine di{' '}
                      <strong>{selectedProject.name}</strong>. Puoi
                      rimuovere o riordinare gli step come preferisci.
                    </div>
                  )}
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    URL degli step <span className="text-red-500">*</span>{' '}
                    <span className="text-gray-400 font-normal">
                      — in ordine, dal primo all&apos;ultimo
                    </span>
                  </label>
                  <div className="space-y-2">
                    {manualPages.map((url, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 font-mono w-6 text-right">
                          {i + 1}.
                        </span>
                        <input
                          type="url"
                          value={url}
                          onChange={(e) => {
                            const next = [...manualPages];
                            next[i] = e.target.value;
                            setManualPages(next);
                          }}
                          placeholder={
                            i === 0
                              ? 'https://esempio.com/landing'
                              : i === 1
                                ? 'https://esempio.com/checkout'
                                : 'https://esempio.com/...'
                          }
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                          autoFocus={i === 0 && url === ''}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setManualPages((prev) =>
                              prev.length > 1
                                ? prev.filter((_, idx) => idx !== i)
                                : prev,
                            )
                          }
                          disabled={manualPages.length <= 1}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Rimuovi step"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setManualPages((prev) =>
                        prev.length < 100 ? [...prev, ''] : prev,
                      )
                    }
                    disabled={manualPages.length >= 100}
                    className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 disabled:opacity-50"
                  >
                    <Plus className="w-3 h-3" />
                    Aggiungi step
                  </button>
                  <p className="text-xs text-gray-400 mt-2">
                    Il check &quot;Navigazione&quot; richiede almeno 2 step.
                    Massimo 100.
                  </p>
                </div>
                <NameField value={formName} onChange={setFormName} />
                {addError && <ErrorBanner message={addError} />}
                <SubmitBar
                  onCancel={closeAddPanel}
                  disabled={
                    adding ||
                    manualPages.filter((u) => u.trim()).length === 0
                  }
                  loading={adding}
                />
              </form>
            )}

            {/* Screen: funnel auto (entry URL → crawl → pick steps) */}
            {addMode === 'funnel-auto' && (
              <div className="space-y-4">
                {!autoSteps && (
                  <form onSubmit={startAutoCrawl} className="space-y-4">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="flex-1 min-w-[280px]">
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          URL iniziale del funnel{' '}
                          <span className="text-red-500">*</span>
                        </label>
                        <input
                          required
                          type="url"
                          value={autoEntryUrl}
                          onChange={(e) => setAutoEntryUrl(e.target.value)}
                          placeholder="https://esempio.com/landing"
                          disabled={autoCrawling}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:bg-gray-50"
                          autoFocus
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={autoCrawling || !autoEntryUrl.trim()}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 disabled:opacity-50"
                      >
                        {autoCrawling ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Sto esplorando...
                          </>
                        ) : (
                          <>
                            <Wand2 className="w-4 h-4" />
                            Scopri pagine
                          </>
                        )}
                      </button>
                    </div>
                    <p className="text-xs text-gray-400 -mt-2">
                      Il bot apre la pagina con un browser reale, segue le
                      CTA e raccoglie fino a 100 step (si ferma da solo
                      quando il funnel finisce). Su funnel lunghi può
                      richiedere qualche minuto.
                    </p>

                    {autoCrawling && (
                      <div className="bg-violet-50 border border-violet-200 rounded-lg p-3">
                        <div className="flex items-center gap-2 text-sm text-violet-800">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span className="font-medium">
                            Esploro il funnel...
                          </span>
                        </div>
                        {autoProgress && autoProgress.current > 0 && (
                          <div className="mt-2 text-xs text-violet-700">
                            Step trovati finora:{' '}
                            <strong>{autoProgress.current}</strong>
                          </div>
                        )}
                        {autoJobId && (
                          <div className="mt-1 text-[10px] text-violet-500 font-mono truncate">
                            job: {autoJobId}
                          </div>
                        )}
                      </div>
                    )}

                    {addError && <ErrorBanner message={addError} />}
                  </form>
                )}

                {autoSteps && (
                  <form onSubmit={handleAddAuto} className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="text-sm">
                        <strong className="text-gray-900">
                          {autoSteps.length}
                        </strong>{' '}
                        <span className="text-gray-600">step trovati · </span>
                        <strong className="text-violet-700">
                          {autoSelected.size}
                        </strong>
                        <span className="text-gray-600"> selezionati</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setAutoSteps(null);
                          setAutoSelected(new Set());
                          setAutoProgress(null);
                          setAddError(null);
                        }}
                        className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Riprova
                      </button>
                    </div>

                    <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-72 overflow-y-auto">
                      {autoSteps.map((s, i) => {
                        const checked = autoSelected.has(i);
                        return (
                          <label
                            key={i}
                            className={`flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 ${
                              checked ? 'bg-violet-50/50' : ''
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleAutoStep(i)}
                              className="mt-1 accent-violet-600"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-mono text-gray-400">
                                  {i + 1}.
                                </span>
                                <span className="text-sm font-medium text-gray-800 truncate">
                                  {s.title}
                                </span>
                              </div>
                              <a
                                href={s.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-xs text-gray-500 hover:text-blue-600 flex items-center gap-1 mt-0.5 truncate"
                              >
                                <ExternalLink className="w-3 h-3 shrink-0" />
                                {s.url}
                              </a>
                            </div>
                          </label>
                        );
                      })}
                    </div>

                    <NameField value={formName} onChange={setFormName} />
                    {addError && <ErrorBanner message={addError} />}
                    <SubmitBar
                      onCancel={closeAddPanel}
                      disabled={adding || autoSelected.size === 0}
                      loading={adding}
                      label={`Aggiungi ${autoSelected.size} step`}
                    />
                  </form>
                )}
              </div>
            )}
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-500" />
            <p className="text-sm text-gray-500 mt-3">Carico funnel...</p>
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            <strong>Errore:</strong> {error}
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <ShieldCheck className="w-10 h-10 mx-auto text-gray-300" />
            <p className="text-sm text-gray-500 mt-3">
              {funnels.length === 0
                ? 'Nessun funnel ancora. Clicca "Aggiungi funnel" per iniziare.'
                : 'Nessun funnel corrisponde ai filtri.'}
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3 font-medium">Funnel</th>
                  <th className="px-4 py-3 font-medium">Ultimo checkpoint</th>
                  <th className="px-4 py-3 font-medium">Aggiunto</th>
                  <th className="px-4 py-3 font-medium w-32"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((f) => {
                  const justImported = importedIds.includes(f.id);
                  return (
                  <tr
                    key={f.id}
                    className={`transition-colors ${
                      justImported
                        ? 'bg-emerald-50/60 hover:bg-emerald-50'
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 max-w-[420px]">
                        <div className="font-medium text-gray-900 truncate">
                          {f.name}
                        </div>
                        {/* v2: badge with the number of pages in the
                            funnel sequence. >= 2 = "Navigation" check is
                            available; 1 = single-page audit only. */}
                        {f.pages && f.pages.length > 0 && (
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide shrink-0 ${
                              f.pages.length >= 2
                                ? 'bg-indigo-100 text-indigo-700'
                                : 'bg-gray-100 text-gray-600'
                            }`}
                            title={
                              f.pages.length >= 2
                                ? `Funnel multi-step (${f.pages.length} pagine in sequenza)`
                                : 'Singola pagina'
                            }
                          >
                            {f.pages.length} step
                          </span>
                        )}
                      </div>
                      {f.url && (
                        <a
                          href={f.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-gray-500 hover:text-blue-600 flex items-center gap-1 mt-0.5 truncate max-w-[420px]"
                        >
                          <ExternalLink className="w-3 h-3 shrink-0" />
                          {shortDomain(f.url)}
                        </a>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <ScorePill score={f.last_score_overall} />
                      {f.last_run_at && (
                        <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatDate(f.last_run_at)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {formatDate(f.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 justify-end">
                        <Link
                          href={`/checkpoint/${f.id}`}
                          className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 transition-colors"
                        >
                          Apri
                          <ArrowRight className="w-3 h-3" />
                        </Link>
                        <button
                          onClick={() => handleDelete(f.id, f.name)}
                          disabled={deletingId === f.id}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors disabled:opacity-50"
                          title="Elimina funnel"
                        >
                          {deletingId === f.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Log modal */}
      {showLog && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => setShowLog(false)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-6 pt-5 pb-3 border-b border-gray-100">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                  <History className="w-5 h-5 text-gray-500" />
                  Log Checkpoint
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Storico di tutti i checkpoint eseguiti — chi, cosa, quando.
                </p>
              </div>
              <button
                onClick={() => setShowLog(false)}
                className="p-1 text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1">
              {logLoading ? (
                <div className="p-12 text-center">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-500" />
                  <p className="text-sm text-gray-500 mt-3">Carico log...</p>
                </div>
              ) : logError ? (
                <div className="m-6 bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
                  <strong>Errore:</strong> {logError}
                </div>
              ) : logEntries.length === 0 ? (
                <div className="p-12 text-center">
                  <History className="w-10 h-10 mx-auto text-gray-300" />
                  <p className="text-sm text-gray-500 mt-3">
                    Nessun checkpoint ancora eseguito.
                  </p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                    <tr className="text-left text-xs text-gray-500 uppercase tracking-wide">
                      <th className="px-4 py-2 font-medium">Quando</th>
                      <th className="px-4 py-2 font-medium">Chi</th>
                      <th className="px-4 py-2 font-medium">Funnel</th>
                      <th className="px-4 py-2 font-medium">Esito</th>
                      <th className="px-4 py-2 font-medium">Durata</th>
                      <th className="px-4 py-2 font-medium w-16"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {logEntries.map((entry) => (
                      <tr key={entry.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 whitespace-nowrap text-gray-700 text-xs">
                          {formatDateTime(entry.created_at)}
                        </td>
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <UserIcon className="w-3 h-3 text-gray-400" />
                            <span className="font-medium text-gray-700">
                              {entry.triggered_by_name ?? (
                                <em className="text-gray-400">— sconosciuto —</em>
                              )}
                            </span>
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          <div className="font-medium text-gray-800 truncate max-w-[300px]">
                            {entry.funnel_name}
                          </div>
                          {entry.funnel_url && (
                            <div className="text-xs text-gray-400 truncate max-w-[300px]">
                              {entry.funnel_url}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <RunStatusBadge
                            status={entry.status}
                            score={entry.score_overall}
                          />
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                          {entry.duration_ms !== null
                            ? `${Math.round(entry.duration_ms / 1000)}s`
                            : '—'}
                        </td>
                        <td className="px-4 py-2">
                          <Link
                            href={`/checkpoint/${entry.checkpoint_funnel_id}`}
                            onClick={() => setShowLog(false)}
                            className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
                          >
                            Apri
                            <ArrowRight className="w-3 h-3" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="px-6 py-3 border-t border-gray-100 text-xs text-gray-400 flex items-center justify-between">
              <span>{logEntries.length} run mostrati (max 200)</span>
              <button
                onClick={openLog}
                disabled={logLoading}
                className="text-blue-600 hover:underline disabled:opacity-50"
              >
                Aggiorna
              </button>
            </div>
          </div>
        </div>
      )}

      {/* "My Projects" picker — selects a project and stores it in
          `selectedProject`. Doesn't import anything itself; the
          existing Landing / Funnel buttons read the selected project
          and pre-fill their forms with its detected URLs. */}
      <ImportFromProjectsModal
        open={showProjectsImport}
        onClose={() => setShowProjectsImport(false)}
        onPick={handlePickProject}
      />
    </div>
  );
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('it-IT', {
      day: '2-digit',
      month: 'short',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function RunStatusBadge({
  status,
  score,
}: {
  status: 'running' | 'completed' | 'partial' | 'failed';
  score: number | null;
}) {
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-700 border border-blue-200">
        <Loader2 className="w-3 h-3 animate-spin" />
        In corso
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700 border border-red-200">
        <XCircle className="w-3 h-3" />
        Fallito
      </span>
    );
  }
  if (status === 'partial') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700 border border-amber-200">
        <AlertTriangle className="w-3 h-3" />
        Parziale {score !== null ? `· ${score}/100` : ''}
      </span>
    );
  }
  return <ScorePill score={score} />;
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: 'violet' | 'blue' | 'emerald' | 'red';
}) {
  const accentClass =
    accent === 'violet'
      ? 'text-violet-600'
      : accent === 'blue'
        ? 'text-blue-600'
        : accent === 'emerald'
          ? 'text-emerald-600'
          : accent === 'red'
            ? 'text-red-600'
            : 'text-gray-900';
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wide">
        {label}
      </div>
      <div className={`text-2xl font-bold mt-1 ${accentClass}`}>{value}</div>
    </div>
  );
}

/** Tile-style picker used by both the top-level Landing/Funnel choice
 *  and the Manual/Auto sub-choice inside Funnel. Keeps the wizard feel
 *  consistent across screens. */
function ModeCard({
  icon,
  title,
  description,
  onClick,
  accent = 'gray',
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  accent?: 'gray' | 'blue' | 'violet';
}) {
  const accentRing =
    accent === 'blue'
      ? 'hover:border-blue-400 hover:ring-blue-100 hover:bg-blue-50/40'
      : accent === 'violet'
        ? 'hover:border-violet-400 hover:ring-violet-100 hover:bg-violet-50/40'
        : 'hover:border-gray-400 hover:ring-gray-100 hover:bg-gray-50';
  const iconBg =
    accent === 'blue'
      ? 'bg-blue-100 text-blue-600'
      : accent === 'violet'
        ? 'bg-violet-100 text-violet-600'
        : 'bg-gray-100 text-gray-600';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left p-4 border border-gray-200 rounded-xl transition-all hover:ring-4 ${accentRing}`}
    >
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-3 ${iconBg}`}>
        {icon}
      </div>
      <div className="font-semibold text-gray-900 text-sm">{title}</div>
      <div className="text-xs text-gray-500 mt-1 leading-snug">
        {description}
      </div>
    </button>
  );
}

/** Page-type dropdown grouped by category. The selected value drives
 *  the audit's KB injection on the server (advertorial → advertorial
 *  bundle, vsl → VSL bundle, etc.) so the analysis quotes the right
 *  frameworks for that page's role. */
function PageTypeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  // Group built-in options by their category so the dropdown is
  // navigable; categories without a current option (e.g. 'custom')
  // are filtered out.
  const groups = PAGE_TYPE_CATEGORIES.map((cat) => ({
    label: cat.label,
    options: BUILT_IN_PAGE_TYPE_OPTIONS.filter(
      (o: PageTypeOption) => o.category === cat.value,
    ),
  })).filter((g) => g.options.length > 0);

  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">
        Tipo di pagina <span className="text-red-500">*</span>{' '}
        <span className="text-gray-400 font-normal">
          — seleziona il ruolo della pagina nel funnel così l&apos;audit
          usa il knowledge bundle giusto
        </span>
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
      >
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((opt) => (
              <option key={opt.value as string} value={opt.value as string}>
                {opt.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

function NameField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">
        Nome del funnel (opzionale)
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Es: Nooro – Funnel completo v3"
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <p className="text-xs text-gray-400 mt-1">
        Se vuoto, useremo il dominio della prima pagina.
      </p>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
      {message}
    </div>
  );
}

function SubmitBar({
  onCancel,
  disabled,
  loading,
  label = 'Aggiungi',
}: {
  onCancel: () => void;
  disabled: boolean;
  loading: boolean;
  label?: string;
}) {
  return (
    <div className="flex items-center justify-end gap-2 pt-2">
      <button
        type="button"
        onClick={onCancel}
        disabled={loading}
        className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
      >
        Annulla
      </button>
      <button
        type="submit"
        disabled={disabled}
        className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Aggiungo...
          </>
        ) : (
          <>
            <Plus className="w-4 h-4" />
            {label}
          </>
        )}
      </button>
    </div>
  );
}

function FilterSelect<T extends string>({
  icon,
  value,
  onChange,
  options,
}: {
  icon: React.ReactNode;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="relative inline-flex items-center">
      <span className="absolute left-3 text-gray-400 pointer-events-none">
        {icon}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="appearance-none pl-9 pr-8 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
