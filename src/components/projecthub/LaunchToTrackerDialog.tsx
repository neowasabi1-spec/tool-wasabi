'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { getUploadUrl } from '@/lib/projecthub-storage';
import { parseCreativeCopy } from '@/lib/creative-copy';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Rocket } from 'lucide-react';

const LAUNCH_TRACKER_ORIGIN = (
  process.env.NEXT_PUBLIC_LAUNCH_TRACKER_URL || 'https://launch-tracker-murex.vercel.app'
).replace(/\/+$/, '');

type FunnelStep = {
  id: string;
  step_number?: number;
  page_name?: string | null;
  url?: string | null;
  flow_name?: string | null;
};

type CreativeRow = {
  id: number;
  name: string;
  file_path: string;
  media_type: string;
  tags: string;
  category?: string;
};

/** Same encoding Launch Tracker uses to read `#lt_draft=`. */
function encodeLaunchDraft(draft: unknown): string {
  const json = JSON.stringify(draft);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return encodeURIComponent(b64);
}

function absoluteAssetUrl(filePath: string): string {
  if (/^https?:\/\//i.test(filePath)) return filePath;
  const path = getUploadUrl(filePath);
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return `${window.location.origin}${path.startsWith('/') ? path : `/${path}`}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function LaunchToTrackerDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [steps, setSteps] = useState<FunnelStep[]>([]);
  const [creatives, setCreatives] = useState<CreativeRow[]>([]);
  const [pageId, setPageId] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    Promise.all([
      fetch(`/api/projecthub/projects/${projectId}/funnel-steps?slim=1`).then((r) => r.json()),
      fetch(`/api/projecthub/projects/${projectId}/creative/templates`).then((r) => r.json()),
    ]).then(([stepRows, creativeRows]) => {
      if (cancelled) return;
      const pages = (Array.isArray(stepRows) ? stepRows : []).filter(
        (s) => typeof s?.url === 'string' && /^https?:\/\//i.test(s.url),
      );
      const media = (Array.isArray(creativeRows) ? creativeRows : []).filter(
        (c) => (c.media_type === 'image' || c.media_type === 'video') && c.file_path,
      );
      setSteps(pages);
      setCreatives(media);
      setPageId((cur) => cur || pages[0]?.id || '');
      setPicked(new Set());
    }).catch(() => {
      if (!cancelled) setLoadError('Could not load pages and creatives.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, projectId]);

  const selectedPage = useMemo(
    () => steps.find((s) => s.id === pageId) || null,
    [steps, pageId],
  );

  const toggle = (id: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const launch = () => {
    if (!selectedPage?.url) {
      toast({ title: 'Select a page', variant: 'destructive' });
      return;
    }
    const chosen = creatives.filter((c) => picked.has(c.id));
    if (!chosen.length) {
      toast({ title: 'Select at least one creative', variant: 'destructive' });
      return;
    }
    const website = selectedPage.url.trim();
    const display = hostOf(website);
    const ads = chosen.map((c) => {
      const copy = parseCreativeCopy(c.tags);
      const primary = [copy.hook, copy.bodyText].filter(Boolean).join('\n\n');
      const asset = absoluteAssetUrl(c.file_path);
      const video = c.media_type === 'video';
      return {
        name: (c.name || 'Creative').slice(0, 120),
        format: video ? 'SINGLE_VIDEO' : 'SINGLE_IMAGE',
        primary_text: primary,
        headline: copy.headline || '',
        description: '',
        image_url: video ? '' : asset,
        video_url: video ? asset : '',
        website_url: website,
        display_link: display,
        cta: 'LEARN_MORE',
      };
    });
    const draft = {
      ts: Date.now(),
      source: 'swipe',
      campaign: { name: projectName || 'Campaign', offer: '', flow: '' },
      website_url: website,
      ads,
    };
    const url = `${LAUNCH_TRACKER_ORIGIN}/campaigns#lt_draft=${encodeLaunchDraft(draft)}`;
    // Don't pass noopener in windowFeatures: Chrome then returns null even when
    // the tab opened, and we were showing "Popup blocked" for a successful open.
    const win = window.open(url, '_blank');
    if (win) {
      win.opener = null;
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.click();
    }
    toast({ title: 'Opened in Launch Tracker', description: 'Choose new or existing, then CBO or ABO.' });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="w-4 h-4" /> Launch
          </DialogTitle>
          <DialogDescription>
            Pick the page and the creatives. Launch Tracker will ask whether this is a new or existing campaign, and CBO or ABO.
          </DialogDescription>
        </DialogHeader>

        {loadError && (
          <p className="text-sm text-destructive">{loadError}</p>
        )}

        {loading ? (
          <div className="py-10 flex items-center justify-center text-sm text-muted-foreground gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="overflow-y-auto space-y-5 pr-1">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Page</p>
              {steps.length === 0 ? (
                <p className="text-sm text-muted-foreground">No funnel step with a link yet. Set the page URL in Funnel first.</p>
              ) : (
                <div className="space-y-1 max-h-40 overflow-y-auto rounded-lg border border-border">
                  {steps.map((s) => {
                    const label = s.page_name || `Step ${s.step_number ?? ''}`;
                    return (
                      <label key={s.id} className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-muted/60">
                        <input
                          type="radio"
                          name="launch-page"
                          className="mt-1"
                          checked={pageId === s.id}
                          onChange={() => setPageId(s.id)}
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-foreground truncate">
                            {s.flow_name ? `${s.flow_name} · ` : ''}{label}
                          </span>
                          <span className="block text-xs text-muted-foreground truncate">{s.url}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Creatives · {picked.size} selected
              </p>
              {creatives.length === 0 ? (
                <p className="text-sm text-muted-foreground">No image or video creatives in this project yet.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-64 overflow-y-auto">
                  {creatives.map((c) => {
                    const on = picked.has(c.id);
                    const src = getUploadUrl(c.file_path);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggle(c.id)}
                        className={`text-left rounded-lg border overflow-hidden ${on ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
                      >
                        <div className="aspect-video bg-muted relative">
                          {c.media_type === 'video' ? (
                            <video src={src} className="w-full h-full object-cover" muted />
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={src} alt="" className="w-full h-full object-cover" />
                          )}
                          {on && (
                            <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-primary text-white text-[11px] font-bold flex items-center justify-center">✓</span>
                          )}
                        </div>
                        <p className="px-2 py-1.5 text-xs truncate">{c.name || 'Creative'}</p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={launch} disabled={loading || !selectedPage || picked.size === 0} className="gap-2">
            <Rocket className="w-4 h-4" /> Open Launch Tracker
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
