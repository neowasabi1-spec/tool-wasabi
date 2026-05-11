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
} from 'lucide-react';
import type { CheckpointFunnel } from '@/types/checkpoint';

interface DetectedUrl {
  /** Display name (step label or fallback to hostname). */
  name: string;
  url: string;
  /** Where we found it — purely cosmetic, helps the user trust the list. */
  source: 'front_end' | 'back_end' | 'domain';
}

interface RowState extends DetectedUrl {
  selected: boolean;
}

type Mode = 'all' | 'single';

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
  detectedUrls: DetectedUrl[];
}

/**
 * Modal that imports a project's funnel pages into the Checkpoint
 * library. The user picks between "all pages" (audit the whole
 * funnel later by running each entry) or "single page" (only one
 * URL is imported), tweaks names/URLs inline, then confirms.
 *
 * On success we navigate to /checkpoint with a short banner.
 */
export default function ImportCheckpointModal({
  open,
  onClose,
  projectId,
  projectName,
  detectedUrls,
}: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('all');
  const [rows, setRows] = useState<RowState[]>([]);
  const [singleIdx, setSingleIdx] = useState<number>(0);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state every time the modal opens with a different project.
  useEffect(() => {
    if (!open) return;
    setRows(
      detectedUrls.map((d) => ({ ...d, selected: true })),
    );
    setMode('all');
    setSingleIdx(0);
    setError(null);
  }, [open, detectedUrls]);

  const selectedCount = useMemo(() => {
    if (mode === 'single') return rows[singleIdx] ? 1 : 0;
    return rows.filter((r) => r.selected && r.url.trim().length > 0).length;
  }, [mode, rows, singleIdx]);

  const handleImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const items =
        mode === 'single'
          ? rows[singleIdx]
            ? [
                {
                  name: rows[singleIdx].name,
                  url: rows[singleIdx].url,
                },
              ]
            : []
          : rows
              .filter((r) => r.selected && r.url.trim().length > 0)
              .map((r) => ({ name: r.name, url: r.url }));

      if (items.length === 0) {
        throw new Error('Nessun URL selezionato.');
      }

      const res = await fetch('/api/checkpoint/funnels/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, items }),
      });
      const body = (await res.json()) as {
        created?: CheckpointFunnel[];
        skipped?: { input: { url?: string; name?: string }; reason: string }[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }

      const created = body.created ?? [];
      const skipped = body.skipped ?? [];

      // Single-page mode → jump straight into the funnel detail.
      if (mode === 'single' && created.length === 1) {
        onClose();
        router.push(`/checkpoint/${created[0].id}`);
        return;
      }

      // Bulk mode → land on the list with a banner.
      const ids = created.map((c) => c.id).join(',');
      const params = new URLSearchParams();
      if (ids) params.set('imported', ids);
      if (skipped.length > 0) params.set('skipped', String(skipped.length));
      onClose();
      router.push(`/checkpoint?${params.toString()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const updateRow = (idx: number, patch: Partial<RowState>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const toggleAll = (next: boolean) => {
    setRows((prev) => prev.map((r) => ({ ...r, selected: next })));
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={() => !importing && onClose()}
    >
      <div
        className="bg-[#1A1D27] border border-[#2A2D3A] rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-3 border-b border-[#2A2D3A]">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-600/20 flex items-center justify-center flex-shrink-0">
              <ShieldCheck className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">
                Importa nel Checkpoint
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Aggiungi le pagine di{' '}
                <strong className="text-gray-200">{projectName}</strong> alla
                libreria di audit.
              </p>
            </div>
          </div>
          <button
            onClick={() => !importing && onClose()}
            className="p-1 text-gray-500 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode picker */}
        <div className="px-6 pt-4 pb-3 grid grid-cols-2 gap-3">
          <ModeCard
            active={mode === 'all'}
            onClick={() => setMode('all')}
            icon={<Layers className="w-4 h-4" />}
            title="Tutto il funnel"
            subtitle={`Audita ${rows.length || 'tutte le'} pagine separatamente.`}
          />
          <ModeCard
            active={mode === 'single'}
            onClick={() => setMode('single')}
            icon={<FileText className="w-4 h-4" />}
            title="Singola pagina"
            subtitle="Audit mirato su una sola pagina del funnel."
          />
        </div>

        {/* URL list */}
        <div className="px-6 pb-2 flex-1 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="py-12 text-center">
              <AlertCircle className="w-8 h-8 mx-auto text-gray-600" />
              <p className="text-sm text-gray-400 mt-2">
                Nessun URL trovato in questo progetto.
              </p>
              <p className="text-xs text-gray-500 mt-1 max-w-xs mx-auto">
                Aggiungi step nelle tab Front End / Back End del progetto, oppure
                imposta un Domain nell&apos;Overview.
              </p>
            </div>
          ) : (
            <>
              {mode === 'all' && (
                <div className="flex items-center justify-between text-xs text-gray-400 mb-2">
                  <span>
                    {rows.length} pagina{rows.length !== 1 ? 'e' : ''} rilevata
                    {rows.length !== 1 ? 'e' : ''}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleAll(true)}
                      className="text-blue-400 hover:underline"
                    >
                      Seleziona tutte
                    </button>
                    <span className="text-gray-700">·</span>
                    <button
                      onClick={() => toggleAll(false)}
                      className="text-gray-500 hover:text-gray-300 hover:underline"
                    >
                      Deseleziona
                    </button>
                  </div>
                </div>
              )}

              <ul className="space-y-1.5">
                {rows.map((row, i) => {
                  const isPicked =
                    mode === 'single' ? singleIdx === i : row.selected;
                  return (
                    <li
                      key={i}
                      className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                        isPicked
                          ? 'border-blue-500/60 bg-blue-500/10'
                          : 'border-[#2A2D3A] bg-[#0F1117]'
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
                          onChange={(e) =>
                            updateRow(i, { name: e.target.value })
                          }
                          placeholder="Nome pagina"
                          className="bg-[#0F1117] border border-[#2A2D3A] rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                        />
                        <input
                          type="url"
                          value={row.url}
                          onChange={(e) =>
                            updateRow(i, { url: e.target.value })
                          }
                          placeholder="https://..."
                          className="bg-[#0F1117] border border-[#2A2D3A] rounded px-2 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-blue-500"
                        />
                      </div>
                      <SourceBadge source={row.source} />
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {error && (
            <div className="mt-3 text-xs text-red-300 bg-red-900/30 border border-red-800/60 rounded px-3 py-2 flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#2A2D3A] flex items-center justify-between">
          <span className="text-xs text-gray-500">
            {selectedCount} pagina{selectedCount !== 1 ? 'e' : ''} pront
            {selectedCount !== 1 ? 'e' : 'a'} per il Checkpoint
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={importing}
              className="px-4 py-2 text-sm text-gray-300 hover:text-white rounded-lg disabled:opacity-50"
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
                    : `Importa ${selectedCount} pagine`}
                </>
              )}
            </button>
          </div>
        </div>
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
          ? 'border-blue-500 bg-blue-500/10 text-white'
          : 'border-[#2A2D3A] bg-[#0F1117] text-gray-300 hover:border-[#3A3D4A]'
      }`}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </div>
      <div className="text-xs text-gray-400 mt-1 leading-snug">{subtitle}</div>
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
    front_end: 'bg-blue-900/40 text-blue-300 border-blue-800/60',
    back_end: 'bg-purple-900/40 text-purple-300 border-purple-800/60',
    domain: 'bg-emerald-900/40 text-emerald-300 border-emerald-800/60',
  } as const;
  return (
    <span
      className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border ${colorMap[source]} flex-shrink-0 self-center`}
    >
      {labelMap[source]}
    </span>
  );
}
