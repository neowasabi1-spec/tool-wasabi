'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  Loader2, Link2, RefreshCw, Sparkles, CheckCircle2, Image as ImageIcon,
  Library, Wand2, Eye, LayoutTemplate,
} from 'lucide-react';
import { getUploadUrl } from '@/lib/projecthub-storage';
import { CreativesTab } from '@/components/projecthub/creative/CreativesTab';
import { TemplatesStylesSection } from './TemplatesStylesSection';
import { AutoImagesCard } from './AutoImagesCard';

type Step = 'connect' | 'library' | 'analyze' | 'generate' | 'styles' | 'review';

const STEPS: { id: Step; label: string; icon: typeof Link2 }[] = [
  { id: 'connect', label: 'Connect', icon: Link2 },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'analyze', label: 'Analyze', icon: Wand2 },
  { id: 'generate', label: 'Generate', icon: Sparkles },
  { id: 'styles', label: 'Template e stili', icon: LayoutTemplate },
  { id: 'review', label: 'Review', icon: Eye },
];

type AdRow = {
  id: number;
  headline?: string;
  hook?: string;
  body_text?: string;
  ad_name?: string;
  name?: string;
  media_type?: string;
  file_path?: string;
  media_url?: string;
  is_winner?: string | boolean;
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
  const [concepts, setConcepts] = useState<any[]>([]);
  const [outputs, setOutputs] = useState<any[]>([]);


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
      const res = await fetch(
        `/api/projecthub/projects/${projectId}/ads-creative/library?source=${source}`,
      );
      const data = await res.json();
      if (!res.ok && data.error && !(data.ads || []).length) {
        toast.error(data.error);
      }
      setAds(data.ads || []);
      setSelected(new Set());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load library');
    } finally {
      setLoading(false);
    }
  }, [projectId, source]);

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
    setBusy(true);
    setStep('analyze');
    let ok = 0;
    try {
      for (const ad of selectedList) {
        const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ adSource: source, adRefId: String(ad.id) }),
        });
        const data = await res.json();
        if (res.ok && (data.status === 'completed' || data.analysis)) ok += 1;
        else if (!res.ok) toast.error(data.error || `Analyze failed for #${ad.id}`);
      }
      toast.success(`Analyzed ${ok}/${selectedList.length}`);
      await loadLibrary();
    } finally {
      setBusy(false);
    }
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
            <Button size="sm" variant="ghost" onClick={() => void loadLibrary()} disabled={loading}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <div className="flex-1" />
            <Button size="sm" onClick={() => void analyzeSelected()} disabled={busy || !selected.size}>
              Analyze selected ({selected.size})
            </Button>
          </div>

          {loading ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2 py-8">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : !ads.length ? (
            <p className="text-sm text-muted-foreground py-8">
              {source === 'own'
                ? 'No own ads yet — use Connect → Sync My ads (or META_ACCESS_TOKEN locally).'
                : 'No competitor ads — scrape via Competitor Library first.'}
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {ads.map((ad) => {
                const title = ad.headline || ad.ad_name || ad.name || ad.hook || `Ad #${ad.id}`;
                const img = ad.file_path ? getUploadUrl(ad.file_path) : ad.media_url || '';
                const on = selected.has(ad.id);
                return (
                  <button
                    key={ad.id}
                    type="button"
                    onClick={() => toggle(ad.id)}
                    className={`text-left rounded-xl border p-3 bg-card transition-colors ${
                      on ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-foreground/30'
                    }`}
                  >
                    <div className="aspect-square rounded-lg bg-muted mb-2 overflow-hidden flex items-center justify-center">
                      {img ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={img} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <ImageIcon className="w-8 h-8 text-muted-foreground" />
                      )}
                    </div>
                    <p className="text-sm font-medium line-clamp-2">{title}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {ad.analysis?.status === 'ready' && (
                        <Badge variant="secondary" className="text-[10px]">Analyzed</Badge>
                      )}
                      {(ad.is_winner === true || ad.is_winner === 'true') && (
                        <Badge className="text-[10px]">Winner</Badge>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
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
        <TemplatesStylesSection projectId={projectId} />
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
            {!outputs.length ? (
              <p className="text-sm text-muted-foreground">No outputs yet.</p>
            ) : (
              outputs.map((o) => (
                <div key={o.id} className="rounded-xl border border-border p-4 bg-card flex gap-4">
                  {o.result_path ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={getUploadUrl(o.result_path)}
                      alt=""
                      className="w-24 h-24 rounded-lg object-cover border border-border"
                    />
                  ) : (
                    <div className="w-24 h-24 rounded-lg bg-muted flex items-center justify-center">
                      <ImageIcon className="w-6 h-6 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {o.code && <Badge variant="outline">{o.code}</Badge>}
                      {o.gate_decision && (
                        <Badge variant="secondary" className="gap-1">
                          <CheckCircle2 className="w-3 h-3" /> {o.gate_decision}
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm font-medium mt-1">{o.angle || o.kind || o.status}</p>
                    <p className="text-xs text-muted-foreground line-clamp-3">{o.concept_notes || JSON.stringify(o.spec || {}).slice(0, 200)}</p>
                    <div className="flex gap-2 mt-2">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void recordOutcome(String(o.id), 'win')}>Win</Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void recordOutcome(String(o.id), 'neutral')}>Neutral</Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void recordOutcome(String(o.id), 'lose')}>Lose</Button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div>
            <h3 className="text-sm font-semibold mb-2">Templates library</h3>
            <CreativesTab projectId={projectId} />
          </div>
        </div>
      )}
    </div>
  );
}
