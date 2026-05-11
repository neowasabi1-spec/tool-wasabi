'use client';

import { useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Lightbulb,
  Search,
  Filter,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  CHECKPOINT_CATEGORY_LABELS,
  type CheckpointCategory,
  type CheckpointIssue,
  type CheckpointResults,
  type CheckpointSuggestion,
} from '@/types/checkpoint';

type Tab = 'fix' | 'improve' | 'good';

interface FindingRow {
  category: CheckpointCategory;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail?: string;
  evidence?: string;
}

interface SuggestionRow {
  category: CheckpointCategory;
  title: string;
  detail?: string;
}

interface PassRow {
  category: CheckpointCategory;
  score: number | null;
  summary: string;
}

interface Props {
  results: CheckpointResults;
  /** Categories that haven't been run in this run — listed but greyed out. */
  emptyCategories?: CheckpointCategory[];
}

/**
 * Aggregated findings across all audit categories.
 *
 * Three tabs:
 *   "Da correggere"  — issues with severity critical or warning
 *   "Da migliorare"  — info-severity issues + every suggestion
 *   "Va bene"        — categories that scored ≥80 (pass)
 */
export default function FindingsTable({ results }: Props) {
  const [tab, setTab] = useState<Tab>('fix');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<CheckpointCategory | 'all'>('all');
  const [openRow, setOpenRow] = useState<string | null>(null);

  const { fixRows, improveRows, suggestionRows, passRows } = useMemo(() => {
    const fix: FindingRow[] = [];
    const improve: FindingRow[] = [];
    const suggestionsList: SuggestionRow[] = [];
    const passes: PassRow[] = [];

    (Object.keys(results) as CheckpointCategory[]).forEach((cat) => {
      const r = results[cat];
      if (!r) return;
      r.issues.forEach((iss: CheckpointIssue) => {
        const row: FindingRow = {
          category: cat,
          severity: iss.severity,
          title: iss.title,
          detail: iss.detail,
          evidence: iss.evidence,
        };
        if (iss.severity === 'info') improve.push(row);
        else fix.push(row);
      });
      r.suggestions.forEach((sug: CheckpointSuggestion) => {
        suggestionsList.push({
          category: cat,
          title: sug.title,
          detail: sug.detail,
        });
      });
      // "Va bene": pass status, or score ≥80 with no critical issues.
      const hasCritical = r.issues.some((i) => i.severity === 'critical');
      if ((r.status === 'pass' || (r.score !== null && r.score >= 80)) && !hasCritical) {
        passes.push({ category: cat, score: r.score, summary: r.summary });
      }
    });

    // Order: critical first inside fix.
    fix.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    return {
      fixRows: fix,
      improveRows: improve,
      suggestionRows: suggestionsList,
      passRows: passes,
    };
  }, [results]);

  const counts = {
    fix: fixRows.length,
    improve: improveRows.length + suggestionRows.length,
    good: passRows.length,
  };

  // Dataset for the active tab.
  const matchSearch = (text: string): boolean => {
    if (!search) return true;
    return text.toLowerCase().includes(search.toLowerCase());
  };
  const matchCategory = (cat: CheckpointCategory): boolean => {
    return categoryFilter === 'all' || categoryFilter === cat;
  };

  const filteredFix = fixRows.filter(
    (r) => matchCategory(r.category) && matchSearch(`${r.title} ${r.detail ?? ''} ${r.evidence ?? ''}`),
  );
  const filteredImprove = [
    ...improveRows.map((r) => ({ kind: 'issue' as const, row: r })),
    ...suggestionRows.map((r) => ({ kind: 'suggestion' as const, row: r })),
  ].filter(
    (it) =>
      matchCategory(it.row.category) &&
      matchSearch(`${it.row.title} ${it.row.detail ?? ''}`),
  );
  const filteredPass = passRows.filter(
    (r) => matchCategory(r.category) && matchSearch(`${r.summary}`),
  );

  const usedCategories = Array.from(
    new Set(
      [...fixRows, ...improveRows, ...suggestionRows, ...passRows].map(
        (r) => r.category,
      ),
    ),
  );

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="border-b border-gray-100 px-5 pt-4">
        <h3 className="text-base font-semibold text-gray-900">
          Riepilogo findings
        </h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Tutto quello che il bot ha trovato, aggregato per priorità.
        </p>
        <div className="mt-3 flex items-center gap-1 -mb-px">
          <TabButton
            active={tab === 'fix'}
            onClick={() => setTab('fix')}
            label="Da correggere"
            count={counts.fix}
            color="red"
          />
          <TabButton
            active={tab === 'improve'}
            onClick={() => setTab('improve')}
            label="Da migliorare"
            count={counts.improve}
            color="amber"
          />
          <TabButton
            active={tab === 'good'}
            onClick={() => setTab('good')}
            label="Va bene"
            count={counts.good}
            color="emerald"
          />
        </div>
      </div>

      {/* Filter strip */}
      <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/50 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cerca nel testo..."
            className="w-full pl-9 pr-3 py-1.5 border border-gray-200 rounded-md text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="relative inline-flex items-center">
          <Filter className="w-3.5 h-3.5 absolute left-3 text-gray-400 pointer-events-none" />
          <select
            value={categoryFilter}
            onChange={(e) =>
              setCategoryFilter(e.target.value as CheckpointCategory | 'all')
            }
            className="appearance-none pl-9 pr-7 py-1.5 border border-gray-200 rounded-md text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">Tutte le categorie</option>
            {usedCategories.map((cat) => (
              <option key={cat} value={cat}>
                {CHECKPOINT_CATEGORY_LABELS[cat]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Body */}
      <div>
        {tab === 'fix' && (
          <FindingList
            rows={filteredFix}
            empty="Nessun problema critico o warning trovato."
            renderRow={(row, key) => (
              <FixRow
                key={key}
                row={row}
                expanded={openRow === key}
                onToggle={() =>
                  setOpenRow(openRow === key ? null : key)
                }
              />
            )}
          />
        )}
        {tab === 'improve' && (
          <FindingList
            rows={filteredImprove}
            empty="Nessun suggerimento o nota informativa."
            renderRow={(item, key) =>
              item.kind === 'issue' ? (
                <FixRow
                  key={key}
                  row={item.row}
                  expanded={openRow === key}
                  onToggle={() =>
                    setOpenRow(openRow === key ? null : key)
                  }
                />
              ) : (
                <SuggestionRowView
                  key={key}
                  row={item.row}
                  expanded={openRow === key}
                  onToggle={() =>
                    setOpenRow(openRow === key ? null : key)
                  }
                />
              )
            }
          />
        )}
        {tab === 'good' && (
          <FindingList
            rows={filteredPass}
            empty="Nessuna categoria ha ancora superato la soglia di pass."
            renderRow={(row, key) => <PassRowView key={key} row={row} />}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
  color,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  color: 'red' | 'amber' | 'emerald';
}) {
  const accentMap = {
    red: 'border-red-500 text-red-700',
    amber: 'border-amber-500 text-amber-700',
    emerald: 'border-emerald-500 text-emerald-700',
  } as const;
  const pillMap = {
    red: 'bg-red-100 text-red-700',
    amber: 'bg-amber-100 text-amber-700',
    emerald: 'bg-emerald-100 text-emerald-700',
  } as const;
  return (
    <button
      onClick={onClick}
      className={`relative px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
        active
          ? accentMap[color]
          : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}
    >
      {label}
      <span
        className={`text-xs font-semibold rounded-full px-1.5 py-0.5 min-w-[20px] text-center ${
          active ? pillMap[color] : 'bg-gray-100 text-gray-500'
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function FindingList<T>({
  rows,
  empty,
  renderRow,
}: {
  rows: T[];
  empty: string;
  renderRow: (row: T, key: string) => React.ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-5 py-12 text-center">
        <CheckCircle2 className="w-8 h-8 mx-auto text-gray-200" />
        <p className="text-sm text-gray-500 mt-2">{empty}</p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-gray-100">
      {rows.map((row, i) => (
        <li key={`row-${i}`}>{renderRow(row, `row-${i}`)}</li>
      ))}
    </ul>
  );
}

function FixRow({
  row,
  expanded,
  onToggle,
}: {
  row: FindingRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const sev = row.severity;
  const ChevIcon = expanded ? ChevronDown : ChevronRight;

  return (
    <button
      onClick={onToggle}
      className="w-full text-left px-5 py-3 hover:bg-gray-50 transition-colors block"
    >
      <div className="flex items-start gap-3">
        <SeverityIcon severity={sev} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-gray-900">
              {row.title}
            </span>
            <CategoryChip category={row.category} />
            <SeverityChip severity={sev} />
          </div>
          {!expanded && row.detail && (
            <p className="text-xs text-gray-500 mt-1 line-clamp-2">
              {row.detail}
            </p>
          )}
          {expanded && (
            <div className="mt-2 space-y-2">
              {row.detail && (
                <p className="text-sm text-gray-700 whitespace-pre-wrap">
                  {row.detail}
                </p>
              )}
              {row.evidence && (
                <blockquote className="text-xs italic bg-gray-50 border-l-2 border-gray-300 pl-3 py-2 text-gray-600">
                  &quot;{row.evidence}&quot;
                </blockquote>
              )}
            </div>
          )}
        </div>
        <ChevIcon className="w-4 h-4 text-gray-300 mt-1 shrink-0" />
      </div>
    </button>
  );
}

function SuggestionRowView({
  row,
  expanded,
  onToggle,
}: {
  row: SuggestionRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const ChevIcon = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      onClick={onToggle}
      className="w-full text-left px-5 py-3 hover:bg-gray-50 transition-colors block"
    >
      <div className="flex items-start gap-3">
        <Lightbulb className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-gray-900">
              → {row.title}
            </span>
            <CategoryChip category={row.category} />
            <span className="text-[10px] uppercase tracking-wide font-semibold text-blue-600">
              suggerimento
            </span>
          </div>
          {!expanded && row.detail && (
            <p className="text-xs text-gray-500 mt-1 line-clamp-2">
              {row.detail}
            </p>
          )}
          {expanded && row.detail && (
            <p className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">
              {row.detail}
            </p>
          )}
        </div>
        <ChevIcon className="w-4 h-4 text-gray-300 mt-1 shrink-0" />
      </div>
    </button>
  );
}

function PassRowView({ row }: { row: PassRow }) {
  return (
    <div className="px-5 py-3">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-500" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-gray-900">
              {CHECKPOINT_CATEGORY_LABELS[row.category]}
            </span>
            {row.score !== null && (
              <span className="text-xs font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                {row.score}/100
              </span>
            )}
          </div>
          <p className="text-xs text-gray-600 mt-1">{row.summary}</p>
        </div>
      </div>
    </div>
  );
}

function SeverityIcon({
  severity,
}: {
  severity: 'critical' | 'warning' | 'info';
}) {
  if (severity === 'critical')
    return <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-500" />;
  if (severity === 'warning')
    return <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />;
  return <Lightbulb className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" />;
}

function CategoryChip({ category }: { category: CheckpointCategory }) {
  return (
    <span className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
      {CHECKPOINT_CATEGORY_LABELS[category]}
    </span>
  );
}

function SeverityChip({
  severity,
}: {
  severity: 'critical' | 'warning' | 'info';
}) {
  if (severity === 'critical')
    return (
      <span className="text-[10px] uppercase tracking-wide font-semibold text-red-700 bg-red-100 px-1.5 py-0.5 rounded">
        critico
      </span>
    );
  if (severity === 'warning')
    return (
      <span className="text-[10px] uppercase tracking-wide font-semibold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
        warning
      </span>
    );
  return (
    <span className="text-[10px] uppercase tracking-wide font-semibold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded">
      info
    </span>
  );
}

function severityRank(s: 'critical' | 'warning' | 'info'): number {
  if (s === 'critical') return 0;
  if (s === 'warning') return 1;
  return 2;
}
