'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  X,
  Loader2,
  ShieldCheck,
  AlertCircle,
  FolderOpen,
  Search,
  ArrowRight,
  ExternalLink,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

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

export interface DetectedUrl {
  name: string;
  url: string;
  source: 'front_end' | 'back_end' | 'domain';
}

export interface PickedProject {
  id: string;
  name: string;
  detectedUrls: DetectedUrl[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called when the user clicks a project. Receives id + name + the
   *  detected funnel URLs. The modal closes itself before this fires. */
  onPick: (project: PickedProject) => void;
}

// ─── URL detection (mirrors the /projects page logic) ───────────────────────

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
 * Project-only picker. Opens a list of projects from "My Projects"
 * (Supabase) — clicking a project hands its id/name + detected URLs
 * back to the parent and closes. The parent then drives the actual
 * import via the existing Landing / Funnel buttons.
 */
export default function ImportFromProjectsModal({ open, onClose, onPick }: Props) {
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) {
      setSearch('');
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: dbErr } = await supabase
        .from('projects')
        .select('id, name, status, domain, description, front_end, back_end')
        .order('updated_at', { ascending: false });
      if (cancelled) return;
      if (dbErr) {
        setError(dbErr.message || 'Errore caricamento progetti');
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
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      `${p.name} ${p.domain} ${p.description}`.toLowerCase().includes(q),
    );
  }, [projects, search]);

  const choose = (p: ProjectLite) => {
    const detectedUrls = detectFunnelUrls(p);
    onClose();
    onPick({ id: p.id, name: p.name, detectedUrls });
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-3 border-b border-gray-100">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center flex-shrink-0">
              <ShieldCheck className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                Scegli un progetto
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Una volta selezionato, usa i bottoni{' '}
                <strong>Landing</strong> o <strong>Funnel</strong> qui sotto per
                scegliere cosa importare.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* Search */}
          <div className="relative mb-3">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cerca progetto..."
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              autoFocus
            />
          </div>

          {loading ? (
            <div className="py-12 text-center">
              <Loader2 className="w-6 h-6 animate-spin mx-auto text-indigo-500" />
              <p className="text-sm text-gray-500 mt-3">Carico progetti...</p>
            </div>
          ) : error ? (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : filtered.length === 0 ? (
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
              {filtered.map((p) => {
                const detected = detectFunnelUrls(p);
                const count = detected.length;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => choose(p)}
                      disabled={count === 0}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      title={
                        count === 0
                          ? 'Questo progetto non ha URL nel Front End / Back End / Domain'
                          : `${count} URL rilevat${count === 1 ? 'o' : 'i'}`
                      }
                    >
                      <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center flex-shrink-0">
                        <FolderOpen className="w-4 h-4 text-indigo-600" />
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
      </div>
    </div>
  );
}
