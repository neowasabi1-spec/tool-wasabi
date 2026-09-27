'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, RefreshCw, Layers } from 'lucide-react';
import { toast } from 'sonner';
import { getUploadUrl } from '@/lib/projecthub-storage';

type Member = {
  id: string;
  impression_rank: number | null;
  score: number | null;
  media_type: string;
  thumb: string | null;
};

type Family = {
  key: string;
  label: string;
  kind: string;
  members: Member[];
  impressionShare: number;
  bestRank: number | null;
};

export function StylesFamiliesSection({ projectId }: { projectId: string }) {
  const [productId, setProductId] = useState<string | undefined>();
  const [families, setFamilies] = useState<Family[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Load failed');
      setProductId(data.products?.[0]?.id);
      setFamilies(Array.isArray(data.styleFamilies) ? data.styleFamilies : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  async function buildFamilies() {
    setBusy(true);
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'build_families', payload: { productId } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Build failed');
      toast.success(data.status === 'queued' ? 'Calcolo stili in coda' : 'Stili aggiornati');
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const j = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`).then((r) => r.json());
        const job = (j.jobs || []).find((x: { id: string }) => x.id === data.jobId);
        if (job && ['done', 'error', 'cancelled'].includes(job.status)) {
          if (job.status === 'error') throw new Error(job.error || 'Build error');
          break;
        }
        if (data.status === 'done' || data.result) break;
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Build failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="py-10 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Caricamento stili…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-start gap-2">
          <Layers className="w-4 h-4 mt-0.5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">Stili visivi (come in Jev)</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Ads con lo stesso linguaggio grafico nello stesso gruppo. Prima analizza/ricrea le ads (ingest),
              poi calcola gli stili. Genera dentro un gruppo alla volta così non si mischiano i template.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {families.length
              ? `${families.length} gruppi · ${families.reduce((n, f) => n + f.members.length, 0)} ads`
              : 'Nessun gruppo ancora'}
          </span>
          <Button size="sm" variant="outline" disabled={busy || !productId} onClick={() => void buildFamilies()} className="gap-1.5 ml-auto">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {families.length ? 'Ricalcola stili' : 'Calcola stili'}
          </Button>
        </div>
      </div>

      {!families.length && (
        <p className="text-sm text-muted-foreground py-2">
          Seleziona ads in Lista → Analizza / Prepara gruppi Jev, poi torna qui e calcola gli stili.
        </p>
      )}

      {families.map((f) => (
        <div key={f.key} className="rounded-xl border border-border bg-card p-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold">{f.label}</h4>
            <Badge variant="secondary">{f.members.length} ads</Badge>
            {f.bestRank != null && <Badge variant="outline">migliore #{f.bestRank}</Badge>}
            {f.impressionShare > 0 && (
              <span className="text-[10px] text-muted-foreground">
                ~{Math.round(f.impressionShare * 100)}% share
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {[...f.members]
              .sort((a, b) => (a.impression_rank ?? 999) - (b.impression_rank ?? 999))
              .slice(0, 10)
              .map((m) => (
                <div key={m.id} className="grid gap-0.5 text-center text-[10px] text-muted-foreground">
                  <div className="h-16 w-16 rounded-lg bg-muted overflow-hidden border border-border">
                    {m.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={getUploadUrl(m.thumb)} alt="" className="w-full h-full object-cover" />
                    ) : null}
                  </div>
                  #{m.impression_rank ?? '?'}
                  {m.score != null ? ` · ${m.score.toFixed?.(1) ?? m.score}` : ''}
                </div>
              ))}
            {f.members.length > 10 && (
              <span className="self-center text-xs text-muted-foreground">+{f.members.length - 10}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
