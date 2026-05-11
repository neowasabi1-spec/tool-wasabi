'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import Header from '@/components/Header';
import {
  ShieldCheck,
  ExternalLink,
  Loader2,
  Search,
  Filter,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Clock,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { CheckpointFunnel } from '@/types/checkpoint';

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
  const [funnels, setFunnels] = useState<CheckpointFunnel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [formUrl, setFormUrl] = useState('');
  const [formName, setFormName] = useState('');

  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch('/api/checkpoint/funnels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: formUrl.trim(),
          name: formName.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setFormUrl('');
      setFormName('');
      setShowAdd(false);
      reload();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
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
        subtitle="Audit qualitativo dei funnel: CRO, coerenza, tone of voice, compliance, copy"
      />

      <div className="px-6 py-6 space-y-6">
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
              onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Aggiungi funnel
            </button>
          </div>
        </div>

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
                {filtered.map((f) => (
                  <tr
                    key={f.id}
                    className="hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 truncate max-w-[420px]">
                        {f.name}
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add modal */}
      {showAdd && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => !adding && setShowAdd(false)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  Aggiungi funnel
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Incolla l&apos;URL della pagina da auditare.
                </p>
              </div>
              <button
                onClick={() => !adding && setShowAdd(false)}
                className="p-1 text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAdd} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  URL <span className="text-red-500">*</span>
                </label>
                <input
                  type="url"
                  required
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  placeholder="https://esempio.com/landing"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Nome (opzionale)
                </label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Es: Nooro – Sales Page v3"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-400 mt-1">
                  Se vuoto, useremo il dominio.
                </p>
              </div>

              {addError && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                  {addError}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  disabled={adding}
                  className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  disabled={adding || !formUrl.trim()}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
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
            </form>
          </div>
        </div>
      )}
    </div>
  );
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
