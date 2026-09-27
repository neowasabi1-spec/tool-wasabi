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
};

/** Creatività immagine automatiche: template migliori × testi con angoli diversi, immagini generate e votate. */
export function AutoImagesCard({
  projectId,
  productId,
  groupKey,
  compact,
  language = 'it',
  onQueued,
}: Props) {
  const [templates, setTemplates] = useState(4);
  const [perTemplate, setPerTemplate] = useState(3);
  const [lang, setLang] = useState(language);
  const [images, setImages] = useState(true);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
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
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Queue failed');
      toast.success(data.status === 'queued' ? 'Creatività in coda' : 'Job avviato');
      onQueued?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Queue failed');
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <div className={`grid gap-3 ${groupKey ? 'sm:grid-cols-[auto_auto_1fr_auto]' : 'sm:grid-cols-[repeat(3,minmax(0,1fr))_auto]'} sm:items-end`}>
      {!groupKey && (
        <label className="space-y-1 text-xs">
          <span className="font-medium text-foreground">Template (i migliori)</span>
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
        <span className="font-medium text-foreground">Creatività per template</span>
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
        <span className="font-medium text-foreground">Lingua</span>
        <input
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          className={`w-full rounded-md border border-border bg-background px-3 py-2 text-sm ${groupKey ? 'max-w-[5rem]' : ''}`}
        />
      </label>
      <Button onClick={() => void run()} disabled={busy} className="gap-1.5">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        {groupKey ? 'Crea da questo template' : 'Crea creatività'}
      </Button>
      <label className={`mb-0 flex items-center gap-2 text-sm text-muted-foreground ${groupKey ? 'sm:col-span-4' : 'sm:col-span-4'}`}>
        <input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} />
        Genera anche le immagini (circa 0,25 $ l&apos;una; senza, restano i prompt)
      </label>
    </div>
  );

  if (compact) return form;

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Creatività immagine automatiche</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Prende i template grafici delle ads con più impression (uno per gruppo) e per ognuno scrive testi con angoli
          diversi (Opus e Sonnet). Jev sceglie i testi migliori, le immagini vengono generate, Gemini controlla che
          rispettino il template e i testi, Jev vota l&apos;efficacia. Sotto soglia si prepara da solo una versione migliorata.
        </p>
      </div>
      {form}
    </div>
  );
}
