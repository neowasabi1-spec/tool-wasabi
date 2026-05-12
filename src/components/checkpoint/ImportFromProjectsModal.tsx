'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  X,
  Loader2,
  ShieldCheck,
  AlertCircle,
  Layers,
  FileText,
  CheckCircle2,
  FolderOpen,
  Search,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { CheckpointFunnel } from '@/types/checkpoint';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FunnelRow {
  step?: string;
  url?: string;
  price?: string;
  offerType?: string;
}

interface ProjectLite {
  id: string;
  name: string;
  status: string;
  domain: string;
  description: string;
  front_end: { rows?: FunnelRow[] } | null;
  back_end: { rows?: FunnelRow[] } | null;
}

interface DetectedUrl {
  name: string;
  url: string;
  source: 'front_end' | 'back_end' | 'domain';
}

interface RowState extends DetectedUrl {
  selected: boolean;
}

type Mode = 'all' | 'single';

interface Props {
  open: boolean;
  onClose: () => void;
}

// ─── URL detection (same shape used by /projects page) ───────────────────────

function safeHostname(url: string): string {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function detectFunnelUrls(p: ProjectLite): DetectedUrl[] {
  const out: DetectedUrl[] = [];
  const seen = new Set<string>();

  const ingest = (rows: FunnelRow[] | undefined, source: 'front_end' | 'back_end') => {
    for (const r of rows ?? []) {
      const url = (r.url ?? '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({
        name:
          (r.step ?? '').trim() ||
          safeHostname(url) ||
          `Step ${out.length + 1}`,
        url,
        source,
      });
    }
  };

  ingest(p.front_end?.rows, 'front_end');
  ingest(p.back_end?.rows, 'back_end');

  const domain = (p.domain || '').trim();
  if (domain && !seen.has(domain)) {
    seen.add(domain);
    out.push({
      name: p.name || safeHostname(domain) || 'Homepage',
      url: domain,
      source: 'domain',
    });
  }
  return out;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Two-step modal opened from the Checkpoint page:
 *   Step 1 — pick a project from "My Projects" (Supabase).
 *   Step 2 — pick "Tutto il funnel" (multi-page) or "Singola pagina"
 *            and confirm which URLs to import.
 *
 * Delegates the actual creation to /api/checkpoint/funnels/import,
 * the same endpoint the projects page uses.
 */
export default function ImportFromProjectsModal({ open, onClose }: Props) {
  const router = useRouter();

  const [step, setStep] = useState<'pick-project' | 'pick-mode'>('pick-project');

  // Step 1 state.
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Step 2 state.
  const [picked, setPicked] = useState<ProjectLite | null>(null);
  const [mode, setMode] = useState<Mode>('all');
  const [rows, setRows] = useState<RowState[]>([]);
  const [singleIdx, setSingleIdx] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Load projects when the modal opens; reset when it closes.
  useEffect(() => {
    if (!open) {
      setStep('pick-project');
      setPicked(null);
      setRows([]);
      setSingleIdx(0);
      setMode('all');
      setSearch('');
      setImportError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingProjects(true);
      setProjectsError(null);
      const { data, error } = await supabase
        .from('projects')
        .select('id, name, status, domain, description, front_end, back_end')
        .order('updated_at', { ascending: false });
      if (cancelled) return;
      if (error) {
        setProjectsError(error.message || 'Errore caricamento progetti');
        setProjects([]);
      } else {
        setProjects(
          (data ?? []).map((p: Record<string, unknown>) => ({
            id: String(p.id ?? ''),
            name: typeof p.name === 'string' ? p.name : 'Untitled',
            status: typeof p.status === 'string' ? p.status : 'active',
            domain: typeof p.domain === 'string' ? p.domain : '',
            description: typeof p.description === 'string' ? p.description : '',
            front_end: (p.front_end as { rows?: FunnelRow[] }) ?? null,
            back_end: (p.back_end as { rows?: FunnelRow[] }) ?? null,
          })),
        );
      }
      setLoadingProjects(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      `${p.name} ${p.domain} ${p.description}`.toLowerCase().includes(q),
    );
  }, [projects, search]);

  const choose = (p: ProjectLite) => {
    const detected = detectFunnelUrls(p);
    setPicked(p);
    setRows(detected.map((d) => ({ ...d, selected: true })));
    setSingleIdx(0);
    setMode('all');
    setImportError(null);
    setStep('pick-mode');
  };

  const back = () => {
    if (importing) return;
    setStep('pick-project');
    setPicked(null);
    setRows([]);
    setImportError(null);
  };

  const updateRow = (idx: number, patch: Partial<RowState>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const toggleAll = (next: boolean) => {
    setRows((prev) => prev.map((r) => ({ ...r, selected: next })));
  };

  const selectedCount = useMemo(() => {
    if (mode === 'single') return rows[singleIdx] ? 1 : 0;
    return rows.filter((r) => r.selected && r.url.trim().length > 0).length;
  }, [mode, rows, singleIdx]);

  const handleImport = async () => {
    if (!picked) return;
    setImporting(true);
    setImportError(null);
    try {
      const items =
        mode === 'single'
          ? rows[singleIdx]
            ? [{ name: rows[singleIdx].name, url: rows[singleIdx].url }]
            : []
          : rows
              .filter((r) => r.selected && r.url.trim().length > 0)
              .map((r) => ({ name: r.name, url: r.url }));

      if (items.length === 0) throw new Error('Nessun URL selezionato.');

      const importMode: 'multi' | 'single' = mode === 'single' ? 'single' : 'multi';
      const res = await fetch('/api/checkpoint/funnels/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: picked.id,
          items,
          mode: importMode,
        }),
      });
      const body = (await res.json()) as {
        created?: CheckpointFunnel[];
        skipped?: { input: { url?: string; name?: string }; reason: string }[];
        error?: string;
      };
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);

      const created = body.created ?? [];
      const skipped = body.skipped ?? [];

      // 'multi' and 'single' both yield exactly one created row in the
      // happy path → jump straight into the funnel detail page so the
      // user can run the audit immediately.
      if (created.length === 1) {
        onClose();
        router.push(`/checkpoint/${created[0].id}`);
        return;
      }

      const ids = created.map((c) => c.id).join(',');
      const params = new URLSearchParams();
      if (ids) params.set('imported', ids);
      if (skipped.length > 0) params.set('skipped', String(skipped.length));
      onClose();
      router.push(`/checkpoint?${params.toString()}`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={() => !importing && onClose()}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-3 border-b border-gray-100">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
              <ShieldCheck className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                {step === 'pick-project'
                  ? 'Importa da My Projects'
                  : `Importa da: ${picked?.name ?? ''}`}
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {step === 'pick-project'
                  ? 'Scegli un progetto, poi decidi se importare tutto il funnel o una singola pagina.'
                  : 'Scegli la modalità e conferma le pagine da audire.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {step === 'pick-mode' && (
              <button
                onClick={back}
                disabled={importing}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded disabled:opacity-50"
                title="Torna alla scelta progetto"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Indietro
              </button>
            )}
            <button
              onClick={() => !importing && onClose()}
              className="p-1 text-gray-400 hover:text-gray-600"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {step === 'pick-project' ? (
            <div className="px-6 py-4">
              {/* Search */}
              <div className="relative mb-3">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Cerca progetto..."
                  className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
              </div>

              {loadingProjects ? (
                <div className="py-12 text-center">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-500" />
                  <p className="text-sm text-gray-500 mt-3">Carico progetti...</p>
                </div>
              ) : projectsError ? (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{projectsError}</span>
                </div>
              ) : filteredProjects.length === 0 ? (
                <div className="py-10 text-center">
                  <FolderOpen className="w-10 h-10 mx-auto text-gray-300" />
                  <p className="text-sm text-gray-500 mt-2">
                    {projects.length === 0
                      ? 'Nessun progetto ancora. Creane uno da "My Projects".'
                      : 'Nessun progetto corrisponde alla ricerca.'}
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
                  {filteredProjects.map((p) => {
                    const detected = detectFunnelUrls(p);
                    const count = detected.length;
                    return (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => choose(p)}
                          disabled={count === 0}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          title={
                            count === 0
                              ? 'Questo progetto non ha URL nel Front End / Back End / Domain'
                              : `${count} URL rilevat${count === 1 ? 'o' : 'i'}`
                          }
                        >
                          <div className="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                            <FolderOpen className="w-4 h-4 text-blue-600" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-gray-900 truncate">
                              {p.name}
                            </div>
                            <div className="text-xs text-gray-500 truncate flex items-center gap-2 mt-0.5">
                              <span
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${
                                  count >= 2
                                    ? 'bg-indigo-100 text-indigo-700'
                                    : count === 1
                                      ? 'bg-gray-100 text-gray-600'
                                      : 'bg-red-50 text-red-500'
                                }`}
                              >
                                {count} URL
                              </span>
                              {p.domain && (
                                <span className="truncate flex items-center gap-1">
                                  <ExternalLink className="w-3 h-3" />
                                  {safeHostname(p.domain) || p.domain}
                                </span>
                              )}
                            </div>
                          </div>
                          <ArrowRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : (
            <div className="px-6 py-4 space-y-4">
              {/* Mode picker */}
              <div className="grid grid-cols-2 gap-3">
                <ModeCard
                  active={mode === 'all'}
                  onClick={() => setMode('all')}
                  icon={<Layers className="w-4 h-4" />}
                  title="Tutto il funnel"
                  subtitle={`Crea UN funnel multi-step con ${rows.length || 0} pagin${rows.length === 1 ? 'a' : 'e'} in sequenza.`}
                />
                <ModeCard
                  active={mode === 'single'}
                  onClick={() => setMode('single')}
                  icon={<FileText className="w-4 h-4" />}
                  title="Singola pagina"
                  subtitle="Audit mirato su una sola pagina del progetto."
                />
              </div>

              {/* URL list */}
              {rows.length === 0 ? (
                <div className="py-10 text-center">
                  <AlertCircle className="w-8 h-8 mx-auto text-gray-300" />
                  <p className="text-sm text-gray-500 mt-2">
                    Nessun URL trovato in questo progetto.
                  </p>
                  <p className="text-xs text-gray-400 mt-1 max-w-xs mx-auto">
                    Aggiungi step nelle tab Front End / Back End del progetto, oppure
                    imposta un Domain nell&apos;Overview.
                  </p>
                </div>
              ) : (
                <>
                  {mode === 'all' && (
                    <div className="flex items-center justify-between text-xs text-gray-500">
                      <span>
                        {rows.length} pagin{rows.length === 1 ? 'a' : 'e'} rilevat
                        {rows.length === 1 ? 'a' : 'e'}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => toggleAll(true)}
                          className="text-blue-600 hover:underline"
                        >
                          Seleziona tutte
                        </button>
                        <span className="text-gray-300">·</span>
                        <button
                          onClick={() => toggleAll(false)}
                          className="text-gray-500 hover:text-gray-700 hover:underline"
                        >
                          Deseleziona
                        </button>
                      </div>
                    </div>
                  )}

                  <ul className="space-y-1.5 max-h-72 overflow-y-auto">
                    {rows.map((row, i) => {
                      const isPicked = mode === 'single' ? singleIdx === i : row.selected;
                      return (
                        <li
                          key={i}
                          className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                            isPicked
                              ? 'border-blue-400 bg-blue-50'
                              : 'border-gray-200 bg-white'
                          }`}
                        >
                          <div className="pt-1 flex-shrink-0">
                            {mode === 'single' ? (
                              <input
                                type="radio"
                                name="single-page"
                                checked={singleIdx === i}
                                onChange={() => setSingleIdx(i)}
                                className="w-4 h-4 accent-blue-600"
                              />
                            ) : (
                              <input
                                type="checkbox"
                                checked={row.selected}
                                onChange={(e) =>
                                  updateRow(i, { selected: e.target.checked })
                                }
                                className="w-4 h-4 accent-blue-600"
                              />
                            )}
                          </div>
                          <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-2 gap-2">
                            <input
                              type="text"
                              value={row.name}
                              onChange={(e) => updateRow(i, { name: e.target.value })}
                              placeholder="Nome pagina"
                              className="bg-white border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <input
                              type="url"
                              value={row.url}
                              onChange={(e) => updateRow(i, { url: e.target.value })}
                              placeholder="https://..."
                              className="bg-white border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                          <SourceBadge source={row.source} />
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}

              {importError && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{importError}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {step === 'pick-mode' && (
          <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
            <span className="text-xs text-gray-500">
              {selectedCount} pagin{selectedCount === 1 ? 'a' : 'e'} pront
              {selectedCount === 1 ? 'a' : 'e'} per il Checkpoint
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                disabled={importing}
                className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
              >
                Annulla
              </button>
              <button
                onClick={handleImport}
                disabled={importing || selectedCount === 0}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
              >
                {importing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Importo...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    {mode === 'single'
                      ? 'Importa e apri'
                      : `Importa ${selectedCount} pagin${selectedCount === 1 ? 'a' : 'e'}`}
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  icon,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left px-4 py-3 rounded-lg border transition-colors ${
        active
          ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-100'
          : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
      }`}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-gray-900">
        {icon}
        {title}
      </div>
      <div className="text-xs text-gray-500 mt-1 leading-snug">{subtitle}</div>
    </button>
  );
}

function SourceBadge({ source }: { source: DetectedUrl['source'] }) {
  const labelMap = {
    front_end: 'Front-end',
    back_end: 'Back-end',
    domain: 'Domain',
  } as const;
  const colorMap = {
    front_end: 'bg-blue-100 text-blue-700 border-blue-200',
    back_end: 'bg-purple-100 text-purple-700 border-purple-200',
    domain: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  } as const;
  return (
    <span
      className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border ${colorMap[source]} flex-shrink-0 self-center`}
    >
      {labelMap[source]}
    </span>
  );
}
