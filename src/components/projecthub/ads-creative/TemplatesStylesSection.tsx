'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, RefreshCw, LayoutTemplate } from 'lucide-react';
import { toast } from 'sonner';
import { getUploadUrl } from '@/lib/projecthub-storage';
import { AutoImagesCard } from './AutoImagesCard';

type TemplateMember = {
  templateId: string;
  creativeId: string;
  impression_rank: number | null;
  merit: number;
  thumb: string | null;
};

type TemplateGroup = {
  key: string;
  label: string;
  bestRank: number | null;
  merit: number;
  anchor: TemplateMember;
  members: TemplateMember[];
  spec?: {
    genre?: string;
    slots?: Array<{ slot: string; role: string; current_text: string; words: number; casing: string }>;
    must_keep?: string[];
  } | null;
};

export function TemplatesStylesSection({
  projectId,
  onOutputsReady,
}: {
  projectId: string;
  /** Jump to Review after "Create from this template". */
  onOutputsReady?: () => void;
}) {
  const [productId, setProductId] = useState<string | undefined>();
  const [groups, setGroups] = useState<TemplateGroup[]>([]);
  const [stats, setStats] = useState({ images: 0, withTemplate: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Load failed');
      setProductId(data.products?.[0]?.id);
      setGroups(Array.isArray(data.templateGroups) ? data.templateGroups : []);
      setStats(data.templateStats || { images: 0, withTemplate: 0 });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  async function buildTemplates() {
    setBusy(true);
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'build_templates', payload: { productId }, wait: true }),
      });
      const data = await res.json();
      if (!res.ok || data.status === 'error') throw new Error(data.error || 'Build failed');
      toast.success(
        data.result?.groups != null
          ? `Templates: ${data.result.groups} groups from ${data.result.templates ?? '?'} ads`
          : 'Templates updated',
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Build failed');
    } finally {
      setBusy(false);
    }
  }

  const missing = Math.max(0, stats.images - stats.withTemplate);

  if (loading) {
    return (
      <div className="py-10 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading templates…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-start gap-2">
          <LayoutTemplate className="w-4 h-4 mt-0.5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">Image graphic templates</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Each template is a reusable layout sheet from a winning ad (background, elements, type, text slots).
              Generation stays inside one template at a time and only changes the copy — styles are not mixed.
              New images show up under <b>Review</b>.
            </p>
          </div>
        </div>
        <div className={`flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-xs ${missing > 0 ? 'bg-amber-500/10 text-amber-800 dark:text-amber-200' : 'bg-muted text-muted-foreground'}`}>
          <span>
            {missing > 0
              ? `${missing} images still need a template sheet (auto-gen still uses the best 60).`
              : `${groups.length} template groups from ${stats.withTemplate} images.`}
          </span>
          <Button size="sm" variant="outline" disabled={busy || !productId} onClick={() => void buildTemplates()} className="gap-1.5 ml-auto">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {missing > 0 ? 'Compute all templates' : 'Recompute groups'}
          </Button>
        </div>
      </div>

      <AutoImagesCard projectId={projectId} productId={productId} onQueued={() => void load()} onDone={onOutputsReady} />

      {!groups.length && (
        <p className="text-sm text-muted-foreground py-4">
          No templates yet — compute them above, or run Prepare Jev groups from List first.
        </p>
      )}

      {groups.slice(0, 12).map((g) => (
        <div key={g.key} className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold">{g.label}</h4>
            <Badge variant="secondary">{g.members.length} {g.members.length === 1 ? 'ad' : 'ads'}</Badge>
            {g.bestRank != null && <Badge variant="outline">best #{g.bestRank}</Badge>}
            {g.spec?.genre && <span className="text-xs text-muted-foreground">{g.spec.genre}</span>}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {g.members.slice(0, 7).map((m, i) => (
              <div key={m.templateId} className="grid gap-0.5 text-center text-[10px] text-muted-foreground">
                <div className={`${i === 0 ? 'h-28 w-28' : 'h-16 w-16'} rounded-lg bg-muted overflow-hidden border border-border`}>
                  {m.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={getUploadUrl(m.thumb)} alt="" className="w-full h-full object-cover" />
                  ) : null}
                </div>
                #{m.impression_rank ?? '?'}{i === 0 ? ' · reference' : ''}
              </div>
            ))}
            {g.members.length > 7 && <span className="self-center text-xs text-muted-foreground">+{g.members.length - 7}</span>}
          </div>
          {g.spec?.slots && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Template sheet: {g.spec.slots.length} text slots</summary>
              <div className="mt-2 grid gap-1">
                {g.spec.slots.map((s) => (
                  <p key={s.slot}>
                    <b>{s.role}</b>{' '}
                    <span className="text-muted-foreground">({s.words} words, {s.casing})</span>: &ldquo;{s.current_text}&rdquo;
                  </p>
                ))}
                {!!g.spec.must_keep?.length && (
                  <p className="text-muted-foreground">Keep: {g.spec.must_keep.join(' · ')}</p>
                )}
              </div>
            </details>
          )}
          <div className="rounded-md bg-muted/50 p-2">
            <AutoImagesCard
              projectId={projectId}
              productId={productId}
              groupKey={g.key}
              compact
              onQueued={() => void load()}
              onDone={onOutputsReady}
            />
          </div>
        </div>
      ))}

      {groups.length > 12 && (
        <details className="rounded-xl border border-border bg-card p-4">
          <summary className="cursor-pointer text-sm font-medium">
            More templates · {groups.length - 12}
          </summary>
          <div className="mt-3 space-y-3">
            {groups.slice(12).map((g) => (
              <div key={g.key} className="rounded-lg border border-border p-3">
                <p className="text-sm font-medium mb-2">{g.label}</p>
                <AutoImagesCard
                  projectId={projectId}
                  productId={productId}
                  groupKey={g.key}
                  compact
                  onQueued={() => void load()}
                  onDone={onOutputsReady}
                />
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
