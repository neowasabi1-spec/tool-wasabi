'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { runJevAndWait } from '@/lib/ads-intel/jev-client';
import {
  Loader2, Link2, RefreshCw, Sparkles, CheckCircle2, Image as ImageIcon,
  Library, Wand2, Eye, LayoutTemplate, Flame, Layers, Film, Download, Maximize2, X,
} from 'lucide-react';
import { getUploadUrl } from '@/lib/projecthub-storage';
import { daysRunning, sortByWinnerTier, winnerTier, type WinnerTier } from '@/lib/competitor-winner';
import { CreativesTab } from '@/components/projecthub/creative/CreativesTab';
import { TemplatesStylesSection } from './TemplatesStylesSection';
import { AutoImagesCard } from './AutoImagesCard';
import { StylesFamiliesSection } from './StylesFamiliesSection';

type Step = 'connect' | 'library' | 'analyze' | 'generate' | 'styles' | 'review';

const STEPS: { id: Step; label: string; icon: typeof Link2 }[] = [
  { id: 'connect', label: 'Connect', icon: Link2 },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'analyze', label: 'Analyze', icon: Wand2 },
  { id: 'generate', label: 'Generate', icon: Sparkles },
  { id: 'styles', label: 'Templates & styles', icon: LayoutTemplate },
  { id: 'review', label: 'Review', icon: Eye },
];

type AdRow = {
  id: number;
  duplicateCount?: number;
  brand_id?: number;
  brand_name?: string;
  headline?: string;
  hook?: string;
  body_text?: string;
  ad_name?: string;
  name?: string;
  media_type?: string;
  file_path?: string;
  media_url?: string;
  is_winner?: string | boolean;
  ad_active?: string;
  ad_started_at?: string | null;
  analysis?: { id: number; status: string } | null;
  spend?: string | number;
  impressions?: string | number;
};

export function AdsCreativeShell({ projectId }: { projectId: string }) {
  const [step, setStep] = useState<Step>('library');
  const [source, setSource] = useState<'competitor' | 'own'>('competitor');
  const [ads, setAds] = useState<AdRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [meta, setMeta] = useState<any>(null);
  const [productSheet, setProductSheet] = useState<{ id?: string; name: string; description: string; benefit: string }>({
    name: '',
    description: '',
    benefit: '',
  });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [winnersOnly, setWinnersOnly] = useState(false);
  const [libView, setLibView] = useState<'list' | 'templates' | 'styles'>('list');
  const [includePeers, setIncludePeers] = useState(false);
  const [concepts, setConcepts] = useState<any[]>([]);
  const [outputs, setOutputs] = useState<any[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);


  const loadProduct = useCallback(async () => {
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`);
      const data = await res.json();
      const prod = (data.products || [])[0];
      if (prod) {
        setProductSheet({
          id: prod.id,
          name: prod.name || '',
          description: prod.description || '',
          benefit: prod.benefit || '',
        });
      }
    } catch { /* ignore */ }
  }, [projectId]);

  const loadMeta = useCallback(async () => {
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/meta`);
      const data = await res.json();
      if (res.ok) setMeta(data);
    } catch {
      /* ignore */
    }
  }, [projectId]);

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    try {
      // Always prune off-product competitor pages. Vertical peers stay out
      // unless the user opts in (they are for spy, not same-offer creatives).
      const peers = source === 'competitor' && includePeers ? '&peers=1' : '&peers=0';
      const cleanup = source === 'competitor' ? '&cleanup=1' : '&cleanup=0';
      const res = await fetch(
        `/api/projecthub/projects/${projectId}/ads-creative/library?source=${source}${cleanup}${peers}`,
      );
      const data = await res.json();
      if (!res.ok && data.error && !(data.ads || []).length) {
        toast.error(data.error);
      }
      setAds(data.ads || []);
      setSelected(new Set());
      if (source === 'competitor' && Number(data.pruned) > 0) {
        toast.message(`Removed ${data.pruned} off-product page${data.pruned === 1 ? '' : 's'} from library`);
      }
      if (source === 'competitor' && Number(data.collapsed) > 0) {
        toast.message(`Hid ${data.collapsed} duplicate creative${data.collapsed === 1 ? '' : 's'}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load library');
    } finally {
      setLoading(false);
    }
  }, [projectId, source, includePeers]);

  const loadGenerateState = useCallback(async () => {
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`);
      const data = await res.json();
      if (res.ok) {
        setConcepts(data.concepts || []);
        setOutputs(data.outputs || []);
      }
    } catch {
      /* ignore */
    }
  }, [projectId]);

  function openReviewOutputs() {
    void loadGenerateState();
    setStep('review');
  }

  useEffect(() => {
    void loadMeta();
    void loadGenerateState();
    void loadProduct();
  }, [loadMeta, loadGenerateState, loadProduct]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get('meta');
    if (m === 'connected') toast.success('Facebook Ads connected');
    if (m === 'error' || m === 'token_fail') toast.error('Meta OAuth failed');
    if (m === 'need_login') toast.error('Log in before connecting Meta');
  }, []);

  const selectedList = useMemo(() => ads.filter((a) => selected.has(a.id)), [ads, selected]);

  const rankedAds = useMemo(() => {
    const sorted = sortByWinnerTier(ads);
    return winnersOnly ? sorted.filter((a) => winnerTier(a) !== null) : sorted;
  }, [ads, winnersOnly]);

  const winnerCount = useMemo(() => ads.filter((a) => winnerTier(a) !== null).length, [ads]);

  const allVisibleSelected =
    rankedAds.length > 0 && rankedAds.every((a) => selected.has(a.id));

  function toggleAllVisible() {
    if (allVisibleSelected) setSelected(new Set());
    else setSelected(new Set(rankedAds.map((a) => a.id)));
  }

  function tierBadge(tier: WinnerTier, days: number | null) {
    if (!tier) return <span className="text-muted-foreground text-xs">—</span>;
    const label = tier === 'winner' ? 'WINNER' : 'PROMISING';
    const cls =
      tier === 'winner'
        ? 'bg-amber-400 text-amber-950'
        : 'bg-sky-400 text-sky-950';
    return (
      <span
        title={days != null ? `Running ${days} day${days === 1 ? '' : 's'}` : undefined}
        className={`inline-flex items-center gap-0.5 text-[10px] font-black px-1.5 py-0.5 rounded-full ${cls}`}
      >
        {tier === 'winner' ? '🔥' : '⭐'} {label}
        {days != null ? ` · ${days}d` : ''}
      </span>
    );
  }

  function toggle(id: number) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function saveProduct() {
    setBusy(true);
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'upsert_product',
          payload: {
            productId: productSheet.id,
            name: productSheet.name,
            description: productSheet.description,
            benefit: productSheet.benefit,
          },
          wait: true,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.status === 'error') throw new Error(data.error || 'Save product failed');
      toast.success('Product sheet saved');
      await loadProduct();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save product failed');
    } finally {
      setBusy(false);
    }
  }

  async function syncMeta() {
    setBusy(true);
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      toast.success(`Synced ${data.synced} ads (${data.insights} insight rows) via ${data.source}`);
      setSource('own');
      await loadMeta();
      await loadLibrary();
      setStep('library');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  }

  async function analyzeSelected() {
    if (!selectedList.length) {
      toast.error('Select at least one ad');
      return;
    }
    const todo = selectedList.filter((a) => a.analysis?.status !== 'ready');
    const already = selectedList.length - todo.length;
    if (!todo.length) {
      toast.message(`Already analyzed (${already}) — nothing to run`);
      return;
    }
    setBusy(true);
    setStep('analyze');
    let ok = 0;
    let skipped = already;
    try {
      for (const ad of todo) {
        const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ adSource: source, adRefId: String(ad.id) }),
        });
        const data = await res.json();
        if (res.ok && data.skipped) skipped += 1;
        else if (res.ok && (data.status === 'completed' || data.analysis)) ok += 1;
        else if (!res.ok) toast.error(data.error || `Analyze failed for #${ad.id}`);
      }
      toast.success(`Analyzed ${ok} · skipped ${skipped} duplicate/already done`);
      await loadLibrary();
    } finally {
      setBusy(false);
    }
  }

  /** Ingest selected (or top) competitor ads into Jev, then build template groups. */
  async function prepareJevGroups() {
    const ids = (selectedList.length ? selectedList : rankedAds)
      .filter((a) => !String(a.media_type || '').includes('video'))
      .map((a) => a.id)
      .slice(0, 12);
    if (!ids.length) {
      toast.error('Select image ads (or open the list) — videos are skipped here');
      return;
    }
    setBusy(true);
    const toastId = toast.loading(`Preparing ${ids.length} ads for Jev…`);
    try {
      let ok = 0;
      const errors: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        toast.loading(`Ingesting ${i + 1}/${ids.length}…`, { id: toastId });
        try {
          await runJevAndWait(
            projectId,
            { type: 'ingest_from_competitor_ad', payload: { competitorAdId: ids[i] } },
            { onProgress: (p) => toast.loading(`Ingesting ${i + 1}/${ids.length}: ${p}`, { id: toastId }) },
          );
          ok += 1;
        } catch (e) {
          errors.push(e instanceof Error ? e.message : `ad ${ids[i]} failed`);
        }
      }
      if (!ok) {
        throw new Error(errors[0] || 'No ads ingested — check jev_creatives / migrations');
      }

      toast.loading(`Building templates from ${ok} ads…`, { id: toastId });
      const td = await runJevAndWait(
        projectId,
        { type: 'build_templates', payload: {} },
        { onProgress: (p) => toast.loading(p, { id: toastId }) },
      );
      const result = (td.result || {}) as { groups?: number; templates?: number };
      const groups = Number(result.groups ?? result.templates ?? 0);
      toast.success(
        groups
          ? `Done: ${ok} ads → ${groups} template groups`
          : `Ingested ${ok} ads — open Templates to see groups`,
        { id: toastId },
      );
      setLibView('templates');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Prepare failed', { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  async function recreateSelected() {
    if (!selectedList.length) {
      toast.error('Select at least one ad to recreate');
      return;
    }
    // Analyze anything not ready, then generate concepts from the selection.
    const todo = selectedList.filter((a) => a.analysis?.status !== 'ready');
    if (todo.length) await analyzeSelected();
    await generateConcepts();
  }

  async function generateConcepts() {
    setBusy(true);
    setStep('generate');
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'concepts', count: 3 }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || 'Generate failed');
      toast.success('Concepts generated (Jev pipeline)');
      await loadGenerateState();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Generate failed');
    } finally {
      setBusy(false);
    }
  }

  async function createAsset(conceptId: string | number) {
    setBusy(true);
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'output', conceptId: String(conceptId), language: 'en' }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || 'Asset failed');
      toast.success(data.output?.output?.code || data.output?.code || 'Output ready');
      await loadGenerateState();
      setStep('review');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Asset failed');
    } finally {
      setBusy(false);
    }
  }

  async function recordOutcome(outputId: string, label: 'win' | 'lose' | 'neutral') {
    setBusy(true);
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'record_outcome',
          payload: { outputId, label: label === 'lose' ? 'loss' : label === 'neutral' ? 'unknown' : 'win' },
          wait: true,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.status === 'error') throw new Error(data.error || 'Outcome failed');
      toast.success(`Recorded ${label}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Outcome failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">Ads Creative</h2>
        <p className="text-sm text-muted-foreground">
          Connect Ads Manager, analyze competitors or your ads, generate concepts and assets.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {STEPS.map((s) => {
          const Icon = s.icon;
          const active = step === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setStep(s.id)}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${
                active
                  ? 'bg-primary text-white border-primary'
                  : 'bg-card text-muted-foreground border-border hover:text-foreground'
              }`}
            >
              <Icon className="w-4 h-4" />
              {s.label}
            </button>
          );
        })}
      </div>

      {step === 'connect' && (
        <div className="space-y-4 max-w-xl rounded-xl border border-border p-5 bg-card">
          <p className="text-sm text-muted-foreground">
            Connect your Facebook Ads account to iterate on creatives with full insights.
            For local testing you can set <code className="text-xs">META_ACCESS_TOKEN</code> and sync without OAuth.
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <Badge variant={meta?.connected ? 'default' : 'secondary'}>
              {meta?.connected ? `Connected (${meta.source})` : 'Not connected'}
            </Badge>
            <span className="text-xs text-muted-foreground">{meta?.ownAdsCount || 0} own ads in project</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {meta?.appConfigured && (
              <a
                href={meta.oauthStartPath}
                className="inline-flex items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                Connect Facebook Ads
              </a>
            )}
            <Button onClick={() => void syncMeta()} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              Sync My ads
            </Button>
          </div>
          {!!meta?.accounts?.length && (
            <ul className="text-sm text-muted-foreground space-y-1">
              {meta.accounts.map((a: any) => (
                <li key={a.id}>{a.name} <span className="opacity-60">({a.id})</span></li>
              ))}
            </ul>
          )}
        </div>
      )}

      {step === 'library' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 items-center">
            <Button size="sm" variant={libView === 'list' ? 'default' : 'outline'} onClick={() => setLibView('list')}>
              List
            </Button>
            <Button size="sm" variant={libView === 'templates' ? 'default' : 'outline'} onClick={() => setLibView('templates')}>
              <LayoutTemplate className="w-3.5 h-3.5 mr-1" /> Template
            </Button>
            <Button size="sm" variant={libView === 'styles' ? 'default' : 'outline'} onClick={() => setLibView('styles')}>
              <Layers className="w-3.5 h-3.5 mr-1" /> Styles
            </Button>
            <span className="text-border px-1">|</span>
            {libView === 'list' && (
              <>
                <Button
                  size="sm"
                  variant={source === 'competitor' ? 'default' : 'outline'}
                  onClick={() => setSource('competitor')}
                >
                  Competitors
                </Button>
                <Button
                  size="sm"
                  variant={source === 'own' ? 'default' : 'outline'}
                  onClick={() => setSource('own')}
                >
                  My ads
                </Button>
                <Button
                  size="sm"
                  variant={winnersOnly ? 'default' : 'outline'}
                  onClick={() => setWinnersOnly((v) => !v)}
                  className={winnersOnly ? 'bg-amber-400 text-amber-950 hover:bg-amber-400/90 border-amber-400' : ''}
                >
                  <Flame className="w-3.5 h-3.5 mr-1" />
                  Winners{winnerCount ? ` (${winnerCount})` : ''}
                </Button>
                <Button
                  size="sm"
                  variant={includePeers ? 'default' : 'outline'}
                  onClick={() => setIncludePeers((v) => !v)}
                  title="Include vertical peers (other products you added on purpose)"
                >
                  + Peers
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void loadLibrary()} disabled={loading}>
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </Button>
              </>
            )}
            <div className="flex-1" />
            {libView === 'list' && (
              <>
                <Button size="sm" variant="outline" onClick={() => void prepareJevGroups()} disabled={busy || loading}>
                  {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Layers className="w-4 h-4 mr-2" />}
                  Prepare Jev groups
                </Button>
                <Button size="sm" variant="outline" onClick={() => void analyzeSelected()} disabled={busy || !selected.size}>
                  Analyze ({selected.size})
                </Button>
                <Button size="sm" onClick={() => void recreateSelected()} disabled={busy || !selected.size}>
                  {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Sparkles className="w-4 h-4 mr-2" />}
                  Recreate selected ({selected.size})
                </Button>
              </>
            )}
          </div>
          {libView === 'list' && (
            <p className="text-xs text-muted-foreground">
              Same creative = grouped copies (×N). Sorted WINNER → PROMISING.
              Same-product only (auto-prune). Enable <b>+ Peers</b> for vertical peers. Videos use a native preview.
            </p>
          )}

          {libView === 'templates' && (
            <TemplatesStylesSection projectId={projectId} onOutputsReady={openReviewOutputs} />
          )}
          {libView === 'styles' && <StylesFamiliesSection projectId={projectId} />}

          {libView === 'list' && (loading ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2 py-8">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : !rankedAds.length ? (
            <p className="text-sm text-muted-foreground py-8">
              {winnersOnly
                ? 'No winners/promising ads in this set — turn off the Winners filter.'
                : source === 'own'
                  ? 'No own ads yet — use Connect → Sync My ads (or META_ACCESS_TOKEN locally).'
                  : 'No competitor ads — scrape via Competitor Library first.'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-2 w-10">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleAllVisible}
                        aria-label="Select all"
                      />
                    </th>
                    <th className="p-2 w-14">Preview</th>
                    <th className="p-2">Tier</th>
                    <th className="p-2">Page</th>
                    <th className="p-2">Hook / headline</th>
                    <th className="p-2">Type</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rankedAds.map((ad) => {
                    const title = ad.headline || ad.ad_name || ad.name || ad.hook || `Ad #${ad.id}`;
                    const img = ad.file_path ? getUploadUrl(ad.file_path) : ad.media_url || '';
                    const on = selected.has(ad.id);
                    const tier = winnerTier(ad);
                    const days = daysRunning(ad);
                    return (
                      <tr
                        key={ad.id}
                        onClick={() => toggle(ad.id)}
                        className={`border-t border-border cursor-pointer ${
                          on ? 'bg-primary/5' : 'hover:bg-muted/40'
                        }`}
                      >
                        <td className="p-2 align-middle" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggle(ad.id)}
                            aria-label={`Select ${title}`}
                          />
                        </td>
                        <td className="p-2 align-middle">
                          <div className="w-12 h-12 rounded-md bg-muted overflow-hidden flex items-center justify-center">
                            {img && String(ad.media_type || '').includes('video') ? (
                              <video
                                src={img}
                                muted
                                playsInline
                                preload="metadata"
                                className="w-full h-full object-cover"
                              />
                            ) : img ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={img} alt="" className="w-full h-full object-cover" />
                            ) : (
                              String(ad.media_type || '').includes('video')
                                ? <Film className="w-4 h-4 text-muted-foreground" />
                                : <ImageIcon className="w-4 h-4 text-muted-foreground" />
                            )}
                          </div>
                        </td>
                        <td className="p-2 align-middle whitespace-nowrap">{tierBadge(tier, days)}</td>
                        <td className="p-2 align-middle max-w-[140px]">
                          <span className="line-clamp-2 text-xs">{ad.brand_name || '—'}</span>
                        </td>
                        <td className="p-2 align-middle max-w-[280px]">
                          <p className="font-medium line-clamp-2">{title}</p>
                          {ad.hook && ad.hook !== title && (
                            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{ad.hook}</p>
                          )}
                        </td>
                        <td className="p-2 align-middle text-xs text-muted-foreground">
                          {ad.media_type || '—'}
                        </td>
                        <td className="p-2 align-middle">
                          <div className="flex flex-wrap gap-1">
                            {ad.analysis?.status === 'ready' && (
                              <Badge variant="secondary" className="text-[10px]">Analyzed</Badge>
                            )}
                            {(ad.duplicateCount || 0) > 1 && (
                              <Badge variant="outline" className="text-[10px]">×{ad.duplicateCount}</Badge>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {step === 'analyze' && (
        <div className="space-y-4 max-w-xl">
          <p className="text-sm text-muted-foreground">
            Run analysis on selected library ads. Results feed concept generation (mechanism DNA only — generator never sees the original ad).
          </p>
          <Button onClick={() => void analyzeSelected()} disabled={busy || !selected.size}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Wand2 className="w-4 h-4 mr-2" />}
            Analyze {selected.size || 'selected'}
          </Button>
          <Button variant="outline" onClick={() => setStep('generate')}>
            Continue to Generate
          </Button>
        </div>
      )}

      {step === 'generate' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border p-4 bg-card space-y-3">
            <h3 className="text-sm font-semibold">Product sheet</h3>
            <p className="text-xs text-muted-foreground">
              Concepts never see original ads — only this sheet + DNA mechanisms.
            </p>
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Product name"
              value={productSheet.name}
              onChange={(e) => setProductSheet((s) => ({ ...s, name: e.target.value }))}
            />
            <textarea
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm min-h-[80px]"
              placeholder="Description / facts (ingredients, proof, offer)"
              value={productSheet.description}
              onChange={(e) => setProductSheet((s) => ({ ...s, description: e.target.value }))}
            />
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Benefit"
              value={productSheet.benefit}
              onChange={(e) => setProductSheet((s) => ({ ...s, benefit: e.target.value }))}
            />
            <Button size="sm" onClick={() => void saveProduct()} disabled={busy}>
              Save product
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void (async () => {
                setBusy(true);
                try {
                  const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'build_corpus', wait: true }),
                  });
                  const data = await res.json();
                  if (!res.ok || data.status === 'error') throw new Error(data.error || 'Corpus failed');
                  toast.success('Corpus built');
                  const res2 = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'build_playbook', wait: true }),
                  });
                  const data2 = await res2.json();
                  if (!res2.ok || data2.status === 'error') throw new Error(data2.error || 'Playbook failed');
                  toast.success('Playbook ready');
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : 'Failed');
                } finally { setBusy(false); }
              })()}
            >
              Build corpus + playbook
            </Button>
            <Button onClick={() => void generateConcepts()} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Sparkles className="w-4 h-4 mr-2" />}
              Generate concepts
            </Button>
          </div>
          {!concepts.length ? (
            <p className="text-sm text-muted-foreground">No concepts yet — analyze ads first, then generate.</p>
          ) : (
            <div className="space-y-3">
              {concepts.map((c) => (
                <div key={c.id} className="rounded-xl border border-border p-4 bg-card space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-sm">{c.title}</p>
                      <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap line-clamp-4">{c.brief || c.dna?.benefit_promise || ''}</p>
                    </div>
                    <Button size="sm" onClick={() => void createAsset(c.id)} disabled={busy}>
                      Generate asset
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {step === 'styles' && (
        <TemplatesStylesSection projectId={projectId} onOutputsReady={openReviewOutputs} />
      )}

      {step === 'review' && (
        <div className="space-y-6">
          <AutoImagesCard projectId={projectId} productId={productSheet.id} />
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Outputs</h3>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ type: 'recalibrate_weights', wait: true }),
                    });
                    const data = await res.json();
                    if (!res.ok || data.status === 'error') throw new Error(data.error || 'Recalibrate failed');
                    toast.success('Weights recalibrated');
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : 'Recalibrate failed');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Recalibrate weights
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Jev already wrote copy, generated the image, checked layout/text fidelity, and scored effectiveness
              (it may have re-rendered weak attempts). Win / Neutral / Lose is <b>your</b> label for learning — not the auto-judge.
            </p>
            {!outputs.length ? (
              <p className="text-sm text-muted-foreground">No outputs yet.</p>
            ) : (
              outputs.map((o) => {
                const imgUrl = o.result_path ? getUploadUrl(o.result_path) : '';
                const q = o.quality || {};
                const imgQ = q.image || {};
                const score = imgQ.score ?? q.score;
                const fidelity = imgQ.fidelity?.score;
                const fidelityOk = imgQ.fidelity?.ok;
                const slots = o.spec?.slots && typeof o.spec.slots === 'object'
                  ? Object.entries(o.spec.slots as Record<string, string>).slice(0, 4)
                  : [];
                return (
                  <div key={o.id} className="rounded-xl border border-border p-4 bg-card flex gap-4">
                    <div className="shrink-0 space-y-2">
                      {imgUrl ? (
                        <button
                          type="button"
                          className="relative group block"
                          onClick={() => setPreviewUrl(imgUrl)}
                          title="View larger"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={imgUrl}
                            alt=""
                            className="w-28 h-28 rounded-lg object-cover border border-border"
                          />
                          <span className="absolute inset-0 rounded-lg bg-black/0 group-hover:bg-black/35 transition flex items-center justify-center">
                            <Maximize2 className="w-5 h-5 text-white opacity-0 group-hover:opacity-100" />
                          </span>
                        </button>
                      ) : (
                        <div className="w-28 h-28 rounded-lg bg-muted flex items-center justify-center">
                          <ImageIcon className="w-6 h-6 text-muted-foreground" />
                        </div>
                      )}
                      {imgUrl && (
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-[11px] gap-1"
                            onClick={() => setPreviewUrl(imgUrl)}
                          >
                            <Maximize2 className="w-3 h-3" /> Enlarge
                          </Button>
                          <a
                            href={imgUrl}
                            download={`${o.code || o.id}.png`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex h-7 items-center gap-1 rounded-md border border-input bg-background px-2 text-[11px] font-medium hover:bg-accent"
                          >
                            <Download className="w-3 h-3" /> Download
                          </a>
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {o.code && <Badge variant="outline">{o.code}</Badge>}
                        {o.status && <Badge variant="secondary">{o.status}</Badge>}
                        {o.gate_decision && (
                          <Badge variant="secondary" className="gap-1">
                            <CheckCircle2 className="w-3 h-3" /> {o.gate_decision}
                          </Badge>
                        )}
                        {typeof score === 'number' && (
                          <Badge variant="outline">Jev {Math.round(score * 100)}/100</Badge>
                        )}
                        {typeof fidelity === 'number' && (
                          <Badge variant="outline" className={fidelityOk ? '' : 'border-amber-500 text-amber-700 dark:text-amber-300'}>
                            Fidelity {Math.round(fidelity * 100)}%{fidelityOk ? '' : ' · needs review'}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm font-medium mt-1">{o.angle || o.kind || o.spec?.angle || 'Template creative'}</p>
                      {slots.length > 0 ? (
                        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                          {slots.map(([k, v]) => (
                            <li key={k}><span className="font-medium text-foreground/80">{k}:</span> {String(v)}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted-foreground line-clamp-3 mt-1">
                          {o.concept_notes || (o.spec ? JSON.stringify(o.spec).slice(0, 200) : '')}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2 mt-3">
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void recordOutcome(String(o.id), 'win')}>Win</Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void recordOutcome(String(o.id), 'neutral')}>Neutral</Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void recordOutcome(String(o.id), 'lose')}>Lose</Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div>
            <h3 className="text-sm font-semibold mb-2">Templates library</h3>
            <CreativesTab projectId={projectId} />
          </div>

          {previewUrl && (
            <div
              className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
              onClick={() => setPreviewUrl(null)}
              role="dialog"
              aria-modal="true"
            >
              <button
                type="button"
                className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
                onClick={() => setPreviewUrl(null)}
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
              <a
                href={previewUrl}
                download
                target="_blank"
                rel="noreferrer"
                className="absolute top-4 right-16 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
                onClick={(e) => e.stopPropagation()}
                aria-label="Download"
              >
                <Download className="w-5 h-5" />
              </a>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewUrl}
                alt="Creative preview"
                className="max-h-[90vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
