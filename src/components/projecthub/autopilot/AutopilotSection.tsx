'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Rocket, Loader2, CheckCircle2, XCircle, Circle, MinusCircle,
  ChevronDown, ChevronRight, RefreshCw, Sparkles,
} from 'lucide-react';
import { ChimeraFunnelPicker, type ChimeraFunnelPick } from '@/components/projecthub/autopilot/ChimeraFunnelPicker';

const EMPTY_FUNNEL: ChimeraFunnelPick = { funnelId: '', steps: [] };

type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled';

interface StepState {
  key: string;
  label: string;
  status: StepStatus;
  summary?: string;
  output?: string;
  error?: string;
}

interface Job {
  id: string;
  status: JobStatus;
  input?: { product?: string; competitorLink?: string; description?: string };
  steps: StepState[];
  current_step?: string | null;
  error?: string | null;
  created_at?: string;
  updated_at?: string;
}

const ACTIVE = (s?: JobStatus) => s === 'pending' || s === 'running';

export function AutopilotSection({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [product, setProduct] = useState(projectName || '');
  const [competitorLink, setCompetitorLink] = useState('');
  const [market, setMarket] = useState('');
  const [description, setDescription] = useState('');
  const [funnelPick, setFunnelPick] = useState<ChimeraFunnelPick>(EMPTY_FUNNEL);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [job, setJob] = useState<Job | null>(null);
  const [history, setHistory] = useState<Job[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Polling of the active job ──
  const pollJob = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/pipeline/${jobId}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data: Job = await res.json();
      setJob(data);
      if (!ACTIVE(data.status)) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        loadHistory();
      }
    } catch { /* ignore transient */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startPolling = useCallback((jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollJob(jobId);
    pollRef.current = setInterval(() => pollJob(jobId), 3000);
  }, [pollJob]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/pipeline?projectId=${projectId}`, { cache: 'no-store' });
      if (!res.ok) return;
      const rows: Job[] = await res.json();
      setHistory(rows);
      // Resume polling if a run is still active and we're not already tracking it.
      const active = rows.find((r) => ACTIVE(r.status));
      if (active && !pollRef.current) {
        setJob(active);
        startPolling(active.id);
      }
    } catch { /* ignore */ }
  }, [projectId, startPolling]);

  useEffect(() => {
    loadHistory();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadHistory]);

  const launch = async () => {
    setError(null);
    if (!product.trim()) {
      setError('Enter at least the product name.');
      return;
    }
    setLaunching(true);
    try {
      const res = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          product: product.trim(),
          competitorLink: competitorLink.trim() || undefined,
          market: market.trim() || undefined,
          description: description.trim() || undefined,
          funnelId: funnelPick.steps.length ? funnelPick.funnelId || undefined : undefined,
          funnelSteps: funnelPick.steps.length ? funnelPick.steps : undefined,
          funnelStepIndexes: funnelPick.steps.length ? funnelPick.steps.map((s) => s.index) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Launch failed');
      startPolling(data.jobId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLaunching(false);
    }
  };

  const running = ACTIVE(job?.status);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1 flex items-center gap-2">
          <Rocket className="w-5 h-5 text-primary" /> Chimera Protocol
        </h2>
        <p className="text-sm text-muted-foreground">
          Give it the product, market, competitor and (optionally) a funnel. The tool automatically runs
          market research → brief → <strong>Facebook ad research</strong> → angles/ads → <strong>landing + HTML mockup</strong>,
          saving everything into this project (Competitor Library, Funnel, Brief).
        </p>
      </div>

      {/* ── Launch form ── */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ap-product">Product</Label>
            <Input
              id="ap-product"
              value={product}
              onChange={(e) => setProduct(e.target.value)}
              placeholder="e.g. Rivela anti-age cream"
              disabled={running || launching}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ap-competitor">Competitor link (optional)</Label>
            <Input
              id="ap-competitor"
              value={competitorLink}
              onChange={(e) => setCompetitorLink(e.target.value)}
              placeholder="https://competitor.com/landing"
              disabled={running || launching}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ap-market">Target market / language (optional)</Label>
          <Input
            id="ap-market"
            value={market}
            onChange={(e) => setMarket(e.target.value)}
            placeholder="e.g. Germany · German. If empty, it's inferred from the description"
            disabled={running || launching}
          />
        </div>
        <ChimeraFunnelPicker
          value={funnelPick}
          onChange={setFunnelPick}
          disabled={running || launching}
        />
        <div className="space-y-1.5">
          <Label htmlFor="ap-desc">Description / notes (optional)</Label>
          <Textarea
            id="ap-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Ingredients, benefits, price, target audience, tone of voice..."
            rows={3}
            disabled={running || launching}
          />
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex items-center gap-3">
          <Button onClick={launch} disabled={running || launching} className="gap-2">
            {launching || running ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> {running ? 'Running…' : 'Launching…'}</>
            ) : (
              <><Sparkles className="w-4 h-4" /> Start Chimera Protocol</>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={loadHistory} className="gap-2">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </Button>
        </div>
      </div>

      {/* ── Live checklist for the current/last job ── */}
      {job && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              Run <JobBadge status={job.status} />
            </h3>
            {job.updated_at && (
              <span className="text-xs text-muted-foreground">
                {new Date(job.updated_at).toLocaleString()}
              </span>
            )}
          </div>

          {job.error && <p className="text-sm text-red-500">Error: {job.error}</p>}

          <ol className="space-y-2">
            {job.steps.map((s) => {
              const isOpen = !!expanded[s.key];
              const hasDetail = !!(s.output || s.error);
              return (
                <li key={s.key} className="rounded-lg border border-border/70">
                  <button
                    type="button"
                    onClick={() => hasDetail && setExpanded((p) => ({ ...p, [s.key]: !p[s.key] }))}
                    className={`w-full flex items-start gap-3 px-3 py-2.5 text-left ${hasDetail ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default'}`}
                  >
                    <StepIcon status={s.status} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{s.label}</span>
                      </div>
                      {s.summary && (
                        <p className="text-xs text-muted-foreground mt-0.5">{s.summary}</p>
                      )}
                      {s.error && (
                        <p className="text-xs text-red-500 mt-0.5 line-clamp-2">{s.error}</p>
                      )}
                    </div>
                    {hasDetail && (
                      isOpen
                        ? <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                        : <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                    )}
                  </button>
                  {isOpen && s.output && (
                    <pre className="px-3 pb-3 text-xs text-muted-foreground whitespace-pre-wrap break-words max-h-80 overflow-y-auto border-t border-border/70 pt-2">
                      {s.output}
                    </pre>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {/* ── Past runs ── */}
      {history.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Past runs</h3>
          <div className="space-y-1.5">
            {history.map((r) => (
              <button
                key={r.id}
                onClick={() => { setJob(r); if (ACTIVE(r.status)) startPolling(r.id); }}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-border/70 hover:bg-muted/50 text-left"
              >
                <span className="text-sm text-foreground truncate">
                  {r.input?.product || 'Run'}
                </span>
                <span className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-xs text-muted-foreground">
                    {r.created_at ? new Date(r.created_at).toLocaleDateString() : ''}
                  </span>
                  <JobBadge status={r.status} />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  const cls = 'w-4 h-4 flex-shrink-0 mt-0.5';
  switch (status) {
    case 'running':
      return <Loader2 className={`${cls} text-primary animate-spin`} />;
    case 'completed':
      return <CheckCircle2 className={`${cls} text-emerald-500`} />;
    case 'failed':
      return <XCircle className={`${cls} text-red-500`} />;
    case 'skipped':
      return <MinusCircle className={`${cls} text-muted-foreground`} />;
    default:
      return <Circle className={`${cls} text-muted-foreground/50`} />;
  }
}

function JobBadge({ status }: { status: JobStatus }) {
  const map: Record<JobStatus, string> = {
    pending: 'bg-muted text-muted-foreground',
    running: 'bg-primary/10 text-primary',
    completed: 'bg-emerald-500/10 text-emerald-600',
    failed: 'bg-red-500/10 text-red-600',
    canceled: 'bg-muted text-muted-foreground',
  };
  const label: Record<JobStatus, string> = {
    pending: 'Queued',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    canceled: 'Canceled',
  };
  return (
    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${map[status]}`}>
      {label[status]}
    </span>
  );
}
