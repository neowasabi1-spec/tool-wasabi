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
  Sparkles,
} from 'lucide-react';
import type {
  UnifiedFunnel,
  CheckpointSourceTable,
} from '@/types/checkpoint';

const SOURCE_LABEL: Record<CheckpointSourceTable, string> = {
  funnel_pages: 'Front-end',
  post_purchase_pages: 'Post-purchase',
  archived_funnels: 'Archived',
};

const SOURCE_BADGE_CLASS: Record<CheckpointSourceTable, string> = {
  funnel_pages: 'bg-blue-100 text-blue-700 border-blue-200',
  post_purchase_pages: 'bg-purple-100 text-purple-700 border-purple-200',
  archived_funnels: 'bg-amber-100 text-amber-700 border-amber-200',
};

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

function SwipeBadge({ funnel }: { funnel: UnifiedFunnel }) {
  if (funnel.was_swiped) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-violet-100 text-violet-700 border border-violet-200 font-medium">
        <Sparkles className="w-3 h-3" />
        Swipato
      </span>
    );
  }
  if (funnel.swipe_status === 'in_progress') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-700 border border-blue-200">
        <Loader2 className="w-3 h-3 animate-spin" />
        In corso
      </span>
    );
  }
  if (funnel.swipe_status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700 border border-red-200">
        <XCircle className="w-3 h-3" />
        Swipe fallito
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500 border border-gray-200">
      Originale
    </span>
  );
}

function formatDate(iso: string): string {
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
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 50);
  }
}

type SwipeFilter = 'all' | 'swiped' | 'not_swiped';
type StatusFilter = 'all' | 'never' | 'pass' | 'warn' | 'fail';
type SourceFilter = 'all' | CheckpointSourceTable;

export default function CheckpointPage() {
  const [funnels, setFunnels] = useState<UnifiedFunnel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [swipeFilter, setSwipeFilter] = useState<SwipeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/checkpoint/funnels')
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<{ funnels: UnifiedFunnel[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        setFunnels(data.funnels);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return funnels.filter((f) => {
      if (sourceFilter !== 'all' && f.source_table !== sourceFilter)
        return false;
      if (swipeFilter === 'swiped' && !f.was_swiped) return false;
      if (swipeFilter === 'not_swiped' && f.was_swiped) return false;
      if (statusFilter !== 'all') {
        const score = f.last_checkpoint?.score_overall ?? null;
        if (statusFilter === 'never' && f.last_checkpoint) return false;
        if (statusFilter === 'pass' && (score === null || score < 80))
          return false;
        if (
          statusFilter === 'warn' &&
          (score === null || score < 50 || score >= 80)
        )
          return false;
        if (statusFilter === 'fail' && (score === null || score >= 50))
          return false;
      }
      if (q) {
        const hay = `${f.name} ${f.url}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [funnels, search, swipeFilter, statusFilter, sourceFilter]);

  const stats = useMemo(() => {
    const total = funnels.length;
    const swiped = funnels.filter((f) => f.was_swiped).length;
    const checked = funnels.filter((f) => f.last_checkpoint).length;
    const passing = funnels.filter(
      (f) => (f.last_checkpoint?.score_overall ?? -1) >= 80,
    ).length;
    const failing = funnels.filter(
      (f) =>
        f.last_checkpoint?.score_overall !== null &&
        f.last_checkpoint?.score_overall !== undefined &&
        f.last_checkpoint.score_overall < 50,
    ).length;
    return { total, swiped, checked, passing, failing };
  }, [funnels]);

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="Checkpoint"
        subtitle="Audit qualitativo dei funnel: CRO, coerenza, tone of voice, compliance, copy"
      />

      <div className="px-6 py-6 space-y-6">
        {/* Stats strip */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="Totale" value={stats.total} />
          <StatCard label="Swipati" value={stats.swiped} accent="violet" />
          <StatCard
            label="Controllati"
            value={stats.checked}
            accent="blue"
          />
          <StatCard
            label="Pass (≥80)"
            value={stats.passing}
            accent="emerald"
          />
          <StatCard label="Fail (<50)" value={stats.failing} accent="red" />
        </div>

        {/* Filters */}
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
              value={sourceFilter}
              onChange={(v) => setSourceFilter(v as SourceFilter)}
              options={[
                { value: 'all', label: 'Tutte le fonti' },
                { value: 'funnel_pages', label: 'Front-end' },
                { value: 'post_purchase_pages', label: 'Post-purchase' },
                { value: 'archived_funnels', label: 'Archived' },
              ]}
            />

            <FilterSelect
              icon={<Sparkles className="w-4 h-4" />}
              value={swipeFilter}
              onChange={(v) => setSwipeFilter(v as SwipeFilter)}
              options={[
                { value: 'all', label: 'Swipati e non' },
                { value: 'swiped', label: 'Solo swipati' },
                { value: 'not_swiped', label: 'Solo originali' },
              ]}
            />

            <FilterSelect
              icon={<ShieldCheck className="w-4 h-4" />}
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
          </div>
        </div>

        {/* List */}
        {loading ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-500" />
            <p className="text-sm text-gray-500 mt-3">
              Carico funnel da Supabase...
            </p>
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
                ? 'Nessun funnel trovato in funnel_pages, post_purchase_pages, o archived_funnels.'
                : 'Nessun funnel corrisponde ai filtri.'}
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3 font-medium">Funnel</th>
                  <th className="px-4 py-3 font-medium">Fonte</th>
                  <th className="px-4 py-3 font-medium">Stato swipe</th>
                  <th className="px-4 py-3 font-medium">Ultimo checkpoint</th>
                  <th className="px-4 py-3 font-medium">Aggiornato</th>
                  <th className="px-4 py-3 font-medium w-16"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((f) => (
                  <tr
                    key={f.id}
                    className="hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 truncate max-w-[280px]">
                        {f.name}
                      </div>
                      {f.url && (
                        <a
                          href={f.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-gray-500 hover:text-blue-600 flex items-center gap-1 mt-0.5 truncate max-w-[280px]"
                        >
                          <ExternalLink className="w-3 h-3 shrink-0" />
                          {shortDomain(f.url)}
                        </a>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs border ${SOURCE_BADGE_CLASS[f.source_table]}`}
                      >
                        {SOURCE_LABEL[f.source_table]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <SwipeBadge funnel={f} />
                    </td>
                    <td className="px-4 py-3">
                      <ScorePill
                        score={f.last_checkpoint?.score_overall ?? null}
                      />
                      {f.last_checkpoint?.completed_at && (
                        <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatDate(f.last_checkpoint.completed_at)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {formatDate(f.updated_at)}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/checkpoint/${encodeURIComponent(f.id)}`}
                        className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 transition-colors"
                      >
                        Apri
                        <ArrowRight className="w-3 h-3" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
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
