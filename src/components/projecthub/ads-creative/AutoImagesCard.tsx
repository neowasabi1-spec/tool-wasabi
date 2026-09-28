'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

type Props = {
  projectId: string;
  productId?: string;
  groupKey?: string;
  compact?: boolean;
  language?: string;
  onQueued?: () => void;
  /** Called when generation finishes — parent should open Review and reload outputs. */
  onDone?: () => void;
};

/** Auto image creatives: best templates × varied copy angles, rendered and scored. */
export function AutoImagesCard({
  projectId,
  productId,
  groupKey,
  compact,
  language = 'en',
  onQueued,
  onDone,
}: Props) {
  const [templates, setTemplates] = useState(4);
  const [perTemplate, setPerTemplate] = useState(3);
  const [lang, setLang] = useState(language);
  const [images, setImages] = useState(true);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    const toastId = toast.loading(
      groupKey
        ? 'Generating creatives from this template…'
        : 'Generating creatives from top templates…',
    );
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'template_creatives',
          payload: {
            productId,
            opts: {
              templates: groupKey ? 1 : templates,
              perTemplate,
              language: lang,
              groupKey: groupKey || undefined,
              images,
            },
          },
          wait: true,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.status === 'error') {
        throw new Error(data.error || 'Generation failed');
      }

      const nOut = Number(data.result?.outputs ?? 0);
      const nImg = Number(data.result?.images ?? 0);
      onQueued?.();

      if (data.status === 'queued') {
        toast.message(
          'Job queued on the background worker. Open Review in a minute to see new outputs.',
          { id: toastId },
        );
      } else {
        toast.success(
          nOut
            ? `Done: ${nOut} creatives${nImg ? ` · ${nImg} images` : ''}. Open Review to see them.`
            : 'Job finished. Open Review to see outputs.',
          { id: toastId },
        );
      }
      onDone?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Generation failed', { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <div className={`grid gap-3 ${groupKey ? 'sm:grid-cols-[auto_auto_1fr_auto]' : 'sm:grid-cols-[repeat(3,minmax(0,1fr))_auto]'} sm:items-end`}>
      {!groupKey && (
        <label className="space-y-1 text-xs">
          <span className="font-medium text-foreground">Top templates</span>
          <input
            type="number"
            min={1}
            max={8}
            value={templates}
            onChange={(e) => setTemplates(Number(e.target.value) || 4)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
      )}
      <label className="space-y-1 text-xs">
        <span className="font-medium text-foreground">Creatives per template</span>
        <input
          type="number"
          min={1}
          max={6}
          value={perTemplate}
          onChange={(e) => setPerTemplate(Number(e.target.value) || 3)}
          className={`w-full rounded-md border border-border bg-background px-3 py-2 text-sm ${groupKey ? 'max-w-[5rem]' : ''}`}
        />
      </label>
      <label className="space-y-1 text-xs">
        <span className="font-medium text-foreground">Language</span>
        <input
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          className={`w-full rounded-md border border-border bg-background px-3 py-2 text-sm ${groupKey ? 'max-w-[5rem]' : ''}`}
        />
      </label>
      <Button onClick={() => void run()} disabled={busy} className="gap-1.5">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        {groupKey ? 'Create from this template' : 'Create creatives'}
      </Button>
      <label className={`mb-0 flex items-center gap-2 text-sm text-muted-foreground ${groupKey ? 'sm:col-span-4' : 'sm:col-span-4'}`}>
        <input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} />
        Also generate images (~$0.25 each; otherwise you only get prompts)
      </label>
      {groupKey && (
        <p className="text-[11px] text-muted-foreground sm:col-span-4">
          Results land in <b>Review</b> (Ads Creative → Review), not in this list.
        </p>
      )}
    </div>
  );

  if (compact) return form;

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Auto image creatives</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Uses the highest-impression graphic templates (one per group). For each template it writes
          copy at different angles, generates images, checks layout/text fidelity, and scores
          effectiveness. Finished assets appear under <b>Review</b>.
        </p>
      </div>
      {form}
    </div>
  );
}
