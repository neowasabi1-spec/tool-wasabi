'use client';

import { useState, useEffect, useMemo, use } from 'react';
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
  ChevronDown,
  ChevronUp,
  Clock,
  AlertCircle,
} from 'lucide-react';
import {
  CHECKPOINT_CATEGORY_LABELS,
  CHECKPOINT_CATEGORY_DESCRIPTIONS,
  type CheckpointCategory,
  type CheckpointCategoryResult,
  type CheckpointRun,
  type CheckpointFunnel,
} from '@/types/checkpoint';

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
  params: Promise<{ id: string }>;
}) {
  const { id: funnelId } = use(params);

  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState<Record<string, boolean>>({});

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

  const handleRun = async () => {
    setRunning(true);
    setRunError(null);
    try {
      const res = await fetch(`/api/checkpoint/${funnelId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as { id: string };
      // Reload the full detail so the new run appears at top.
      await refetch();
      if (payload.id) setActiveRunId(payload.id);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const activeRun = useMemo(() => {
    if (!data) return null;
    return (
      data.runs.find((r) => r.id === activeRunId) ?? data.runs[0] ?? null
    );
  }, [data, activeRunId]);

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

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title={funnel.name}
        subtitle={funnel.url || 'Senza URL'}
      />

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
            <button
              onClick={handleRun}
              disabled={running}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {running ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Sto eseguendo le 5 categorie...
                </>
              ) : data.runs.length > 0 ? (
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

        {/* History selector */}
        {data.runs.length > 1 && (
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
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {!activeRun ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <HelpCircle className="w-10 h-10 mx-auto text-gray-300" />
            <h3 className="mt-3 font-medium text-gray-700">
              Nessun checkpoint ancora
            </h3>
            <p className="text-sm text-gray-500 mt-1 max-w-md mx-auto">
              Premi <strong>Esegui Checkpoint</strong> per lanciare l'audit
              su CRO, Coerenza, Tone of Voice, Compliance e Copy Quality.
              Tipicamente impiega 30-90 secondi.
            </p>
          </div>
        ) : (
          <CheckpointResultsView run={activeRun} showRaw={showRaw} setShowRaw={setShowRaw} />
        )}
      </div>
    </div>
  );
}

function CheckpointResultsView({
  run,
  showRaw,
  setShowRaw,
}: {
  run: CheckpointRun;
  showRaw: Record<string, boolean>;
  setShowRaw: (v: Record<string, boolean>) => void;
}) {
  const overall = run.score_overall;

  return (
    <div className="space-y-4">
      {/* Aggregate banner */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">
              Score complessivo
            </div>
            <div className="text-4xl font-bold mt-1">
              {overall !== null ? `${overall}` : '–'}
              <span className="text-lg text-gray-400 font-normal">/100</span>
            </div>
            <div className="mt-2">
              <StatusBadge status={statusFromScore(overall)} />
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 flex-1 min-w-[300px]">
            {CATEGORIES.map((cat) => {
              const result = run.results?.[cat];
              return (
                <div
                  key={cat}
                  className="border border-gray-200 rounded-lg p-3"
                >
                  <div className="text-xs text-gray-500 uppercase tracking-wide truncate">
                    {CHECKPOINT_CATEGORY_LABELS[cat]}
                  </div>
                  <div className="text-xl font-semibold mt-1">
                    {result?.score ?? '–'}
                    <span className="text-xs text-gray-400 font-normal">
                      /100
                    </span>
                  </div>
                  <StatusBadge
                    status={result?.status ?? 'skipped'}
                    compact
                  />
                </div>
              );
            })}
          </div>
        </div>
        <div className="mt-4 text-xs text-gray-500 flex items-center gap-1">
          <Clock className="w-3 h-3" /> Eseguito {formatDateTime(run.created_at)}
          {run.completed_at && (
            <>
              {' '}
              · completato {formatDateTime(run.completed_at)} (
              {durationSec(run.created_at, run.completed_at)}s)
            </>
          )}
        </div>
      </div>

      {/* Per-category cards */}
      {CATEGORIES.map((cat) => {
        const result = run.results?.[cat];
        if (!result) {
          return (
            <CategoryCard key={cat} category={cat}>
              <div className="text-sm text-gray-500 italic">
                Categoria non eseguita.
              </div>
            </CategoryCard>
          );
        }
        const isRawOpen = !!showRaw[cat];
        return (
          <CategoryCard key={cat} category={cat} result={result}>
            <p className="text-sm text-gray-700">{result.summary}</p>

            {result.issues.length > 0 && (
              <div className="mt-4">
                <div className="text-xs uppercase text-gray-500 tracking-wide mb-2">
                  Issues ({result.issues.length})
                </div>
                <ul className="space-y-2">
                  {result.issues.map((iss, i) => (
                    <li
                      key={i}
                      className={`border rounded-md p-3 text-sm ${severityClass(iss.severity)}`}
                    >
                      <div className="flex items-start gap-2">
                        {severityIcon(iss.severity)}
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold">{iss.title}</div>
                          {iss.detail && (
                            <p className="text-xs mt-1 opacity-90">
                              {iss.detail}
                            </p>
                          )}
                          {iss.evidence && (
                            <blockquote className="mt-2 text-xs italic bg-white/60 border-l-2 border-current pl-2 py-1">
                              {iss.evidence}
                            </blockquote>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.suggestions.length > 0 && (
              <div className="mt-4">
                <div className="text-xs uppercase text-gray-500 tracking-wide mb-2">
                  Suggerimenti ({result.suggestions.length})
                </div>
                <ul className="space-y-2">
                  {result.suggestions.map((sug, i) => (
                    <li
                      key={i}
                      className="border border-blue-200 bg-blue-50 rounded-md p-3 text-sm text-blue-900"
                    >
                      <div className="font-semibold">→ {sug.title}</div>
                      {sug.detail && (
                        <p className="text-xs mt-1 opacity-90">{sug.detail}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(result.rawReply || result.error) && (
              <div className="mt-4">
                <button
                  onClick={() =>
                    setShowRaw({ ...showRaw, [cat]: !isRawOpen })
                  }
                  className="text-xs text-gray-500 hover:text-gray-700 inline-flex items-center gap-1"
                >
                  {isRawOpen ? (
                    <ChevronUp className="w-3 h-3" />
                  ) : (
                    <ChevronDown className="w-3 h-3" />
                  )}
                  {isRawOpen ? 'Nascondi' : 'Mostra'} raw AI reply
                </button>
                {isRawOpen && (
                  <pre className="mt-2 text-xs bg-gray-50 border border-gray-200 rounded p-3 overflow-x-auto whitespace-pre-wrap max-h-60">
                    {result.error ?? result.rawReply}
                  </pre>
                )}
              </div>
            )}
          </CategoryCard>
        );
      })}
    </div>
  );
}

function CategoryCard({
  category,
  result,
  children,
}: {
  category: CheckpointCategory;
  result?: CheckpointCategoryResult;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
        <div>
          <div className="font-semibold text-gray-900 flex items-center gap-2">
            {CHECKPOINT_CATEGORY_LABELS[category]}
            {result && <StatusBadge status={result.status} compact />}
            {result?.score !== null && result?.score !== undefined && (
              <span className="text-sm text-gray-400">
                {result.score}/100
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {CHECKPOINT_CATEGORY_DESCRIPTIONS[category]}
          </div>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function StatusBadge({
  status,
  compact,
}: {
  status: 'pass' | 'warn' | 'fail' | 'error' | 'skipped';
  compact?: boolean;
}) {
  const map: Record<typeof status, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
    pass: { label: 'PASS', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200', Icon: CheckCircle2 },
    warn: { label: 'WARN', cls: 'bg-amber-100 text-amber-700 border-amber-200', Icon: AlertTriangle },
    fail: { label: 'FAIL', cls: 'bg-red-100 text-red-700 border-red-200', Icon: XCircle },
    error: { label: 'ERROR', cls: 'bg-gray-100 text-gray-600 border-gray-200', Icon: AlertCircle },
    skipped: { label: 'SKIP', cls: 'bg-gray-50 text-gray-400 border-gray-200', Icon: HelpCircle },
  };
  const { label, cls, Icon } = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border font-medium ${cls} ${compact ? 'text-[10px]' : 'text-xs'}`}
    >
      <Icon className={compact ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      {label}
    </span>
  );
}

function severityClass(s: 'critical' | 'warning' | 'info'): string {
  if (s === 'critical')
    return 'border-red-300 bg-red-50 text-red-900';
  if (s === 'warning')
    return 'border-amber-300 bg-amber-50 text-amber-900';
  return 'border-blue-200 bg-blue-50 text-blue-900';
}

function severityIcon(s: 'critical' | 'warning' | 'info') {
  if (s === 'critical')
    return <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-600" />;
  if (s === 'warning')
    return <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />;
  return <HelpCircle className="w-4 h-4 mt-0.5 shrink-0 text-blue-600" />;
}

function statusFromScore(
  score: number | null,
): 'pass' | 'warn' | 'fail' | 'error' | 'skipped' {
  if (score === null) return 'skipped';
  if (score >= 80) return 'pass';
  if (score >= 50) return 'warn';
  return 'fail';
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
