'use client';

import { useState, useEffect, useCallback } from 'react';
import Header from '@/components/Header';
import { DollarSign, RefreshCw, AlertTriangle, Loader2 } from 'lucide-react';

interface SummaryRow {
  id: string;
  created_at: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  source: string | null;
  agent: string | null;
  duration_ms: number | null;
}

interface SummaryResponse {
  totalCostUsd: number;
  todayCostUsd: number;
  last7dCostUsd: number;
  last30dCostUsd: number;
  byProvider: { provider: string; cost_usd: number; calls: number }[];
  bySource: { source: string; cost_usd: number; calls: number }[];
  recent: SummaryRow[];
  warning: string | null;
}

const fmtUsd = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: n < 1 ? 4 : 2,
    maximumFractionDigits: n < 1 ? 4 : 2,
  }).format(n || 0);

const fmtInt = (n: number) =>
  new Intl.NumberFormat('en-US').format(Math.round(n || 0));

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

export default function ApiUsagePage() {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/api-usage/summary', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as SummaryResponse;
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary();
    const t = setInterval(() => fetchSummary(true), 30_000);
    return () => clearInterval(t);
  }, [fetchSummary]);

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
              <DollarSign className="w-6 h-6 text-emerald-600" />
              Spesa API
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Costo cumulato delle chiamate LLM a pagamento (Anthropic / OpenAI / Gemini).
              Trinity locale (Neo) non è incluso perché gratuito.
            </p>
          </div>
          <button
            type="button"
            onClick={() => fetchSummary(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Aggiorna
          </button>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-gray-500 py-12 justify-center">
            <Loader2 className="w-5 h-5 animate-spin" />
            Caricamento…
          </div>
        )}

        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md text-sm text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            <div>
              <div className="font-medium">Errore caricamento dati</div>
              <div>{error}</div>
            </div>
          </div>
        )}

        {data?.warning && (
          <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-900 flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            <div>
              <div className="font-medium">Setup non completo</div>
              <div>{data.warning}</div>
            </div>
          </div>
        )}

        {data && (
          <>
            {/* Headline cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
              <Card label="Oggi" value={fmtUsd(data.todayCostUsd)} accent="emerald" />
              <Card label="Ultimi 7 giorni" value={fmtUsd(data.last7dCostUsd)} accent="blue" />
              <Card label="Ultimi 30 giorni" value={fmtUsd(data.last30dCostUsd)} accent="indigo" />
              <Card label="Totale (all-time)" value={fmtUsd(data.totalCostUsd)} accent="gray" />
            </div>

            {/* Breakdowns */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
              <Section title="Spesa per provider (ultimi 30 giorni)">
                {data.byProvider.length === 0 ? (
                  <EmptyState text="Nessuna chiamata loggata negli ultimi 30 giorni." />
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs font-medium text-gray-500 uppercase border-b border-gray-200">
                        <th className="py-2">Provider</th>
                        <th className="py-2 text-right">Chiamate</th>
                        <th className="py-2 text-right">Costo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byProvider.map((p) => (
                        <tr key={p.provider} className="border-b border-gray-100 last:border-0">
                          <td className="py-2 font-medium text-gray-900">{p.provider}</td>
                          <td className="py-2 text-right text-gray-700">{fmtInt(p.calls)}</td>
                          <td className="py-2 text-right font-mono text-gray-900">{fmtUsd(p.cost_usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>

              <Section title="Spesa per feature (ultimi 30 giorni)">
                {data.bySource.length === 0 ? (
                  <EmptyState text="Nessuna feature ha chiamate loggate." />
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs font-medium text-gray-500 uppercase border-b border-gray-200">
                        <th className="py-2">Source</th>
                        <th className="py-2 text-right">Chiamate</th>
                        <th className="py-2 text-right">Costo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.bySource.map((s) => (
                        <tr key={s.source} className="border-b border-gray-100 last:border-0">
                          <td className="py-2 font-medium text-gray-900">{s.source}</td>
                          <td className="py-2 text-right text-gray-700">{fmtInt(s.calls)}</td>
                          <td className="py-2 text-right font-mono text-gray-900">{fmtUsd(s.cost_usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>
            </div>

            {/* Recent calls */}
            <Section title="Ultime 50 chiamate">
              {data.recent.length === 0 ? (
                <EmptyState text="Nessuna chiamata negli ultimi 30 giorni." />
              ) : (
                <div className="overflow-x-auto -mx-4 sm:mx-0">
                  <table className="w-full text-xs sm:text-sm">
                    <thead>
                      <tr className="text-left text-xs font-medium text-gray-500 uppercase border-b border-gray-200">
                        <th className="py-2 px-2">Data</th>
                        <th className="py-2 px-2">Provider</th>
                        <th className="py-2 px-2">Model</th>
                        <th className="py-2 px-2">Source</th>
                        <th className="py-2 px-2">Agent</th>
                        <th className="py-2 px-2 text-right">In</th>
                        <th className="py-2 px-2 text-right">Out</th>
                        <th className="py-2 px-2 text-right">Latenza</th>
                        <th className="py-2 px-2 text-right">Costo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent.map((r) => (
                        <tr key={r.id} className="border-b border-gray-100 last:border-0">
                          <td className="py-2 px-2 text-gray-600 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                          <td className="py-2 px-2 text-gray-900">{r.provider}</td>
                          <td className="py-2 px-2 text-gray-600 font-mono truncate max-w-[180px]">{r.model}</td>
                          <td className="py-2 px-2 text-gray-700">{r.source ?? '—'}</td>
                          <td className="py-2 px-2 text-gray-700">{r.agent ?? '—'}</td>
                          <td className="py-2 px-2 text-right text-gray-700 font-mono">{fmtInt(r.input_tokens)}</td>
                          <td className="py-2 px-2 text-right text-gray-700 font-mono">{fmtInt(r.output_tokens)}</td>
                          <td className="py-2 px-2 text-right text-gray-500 font-mono">{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                          <td className="py-2 px-2 text-right text-gray-900 font-mono font-medium">{fmtUsd(r.cost_usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            <p className="mt-6 text-xs text-gray-500">
              Refresh automatico ogni 30 secondi. I costi sono calcolati al momento della chiamata
              dai prezzi pubblici di listino (Sonnet 4: $3 input / $15 output per 1M token, ecc.).
              Eventuali credit / sconti / batch discount Anthropic NON sono riflessi.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function Card({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: 'emerald' | 'blue' | 'indigo' | 'gray';
}) {
  const accents = {
    emerald: 'border-emerald-200 bg-emerald-50',
    blue: 'border-blue-200 bg-blue-50',
    indigo: 'border-indigo-200 bg-indigo-50',
    gray: 'border-gray-200 bg-white',
  } as const;
  return (
    <div className={`p-5 rounded-lg border ${accents[accent]}`}>
      <div className="text-xs font-medium text-gray-600 uppercase tracking-wide">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-gray-900 font-mono">{value}</div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5">
      <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-4">{title}</h2>
      {children}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="py-6 text-center text-sm text-gray-500">{text}</div>;
}
