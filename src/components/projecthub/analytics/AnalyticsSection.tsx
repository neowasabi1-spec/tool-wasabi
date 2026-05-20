import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { BarChart2, Plus, Trash2, ArrowRight, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";

const BASE_URL = "";

type AnalyticsStep = {
  id: number;
  project_id: string;
  step_name: string;
  step_type: string;
  section: string;
  impressions: string;
  clicks: string;
  ctr: string;
  cr: string;
  cpa: string;
  aov: string;
  upsell_rate: string;
  refund_rate: string;
  created_at: string;
};

const STEP_TYPES = ["Landing Page", "Advertorial", "Checkout", "Upsell", "Downsell", "Thank You", "Quiz", "VSL"];

function fmt(v: string, suffix = "") {
  const n = parseFloat(v);
  if (isNaN(n)) return "—";
  return `${n.toLocaleString("it-IT", { maximumFractionDigits: 2 })}${suffix}`;
}

function crColor(cr: string, type: string) {
  const n = parseFloat(cr);
  if (isNaN(n)) return "text-muted-foreground";
  const thresholds: Record<string, [number, number]> = {
    "Landing Page": [3, 5], "Checkout": [5, 10], "Upsell": [20, 35], "Thank You": [100, 100],
  };
  const [low, high] = thresholds[type] || [3, 7];
  if (n >= high) return "text-green-600 font-semibold";
  if (n >= low) return "text-amber-600 font-semibold";
  return "text-red-600 font-semibold";
}

function EditableCell({ value, onChange, placeholder = "0", suffix = "", className = "" }: {
  value: string; onChange: (v: string) => void; placeholder?: string; suffix?: string; className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => { setEditing(false); if (draft !== value) onChange(draft); };
  if (!editing) {
    return (
      <div onClick={() => { setDraft(value); setEditing(true); }}
        className={`cursor-text text-xs hover:bg-muted/40 rounded px-1 py-0.5 transition-colors min-h-[20px] ${className}`}>
        {value ? `${value}${suffix}` : <span className="text-muted-foreground">—</span>}
      </div>
    );
  }
  return (
    <input value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
      className="text-xs w-full border border-primary/50 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary bg-background"
      autoFocus placeholder={placeholder} />
  );
}

export function AnalyticsSection({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [activeSection, setActiveSection] = useState<"frontend" | "backend">("frontend");
  const [steps, setSteps] = useState<AnalyticsStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Set<number>>(new Set());

  const loadSteps = async () => {
    setLoading(true);
    try {
      const resp = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/analytics`);
      if (resp.ok) setSteps(await resp.json());
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => { loadSteps(); }, [projectId]);

  const visibleSteps = steps.filter(s => s.section === activeSection);

  const addStep = async () => {
    try {
      const resp = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/analytics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step_name: "Nuovo Step", step_type: "Landing Page", section: activeSection }),
      });
      if (resp.ok) { const s = await resp.json(); setSteps(prev => [...prev, s]); }
    } catch { toast({ title: "Errore", variant: "destructive" }); }
  };

  const updateStep = async (stepId: number, patch: Partial<AnalyticsStep>) => {
    setSteps(prev => prev.map(s => s.id === stepId ? { ...s, ...patch } : s));
    setSaving(prev => new Set(prev).add(stepId));
    try {
      await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/analytics/${stepId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch { /* ignore */ } finally {
      setSaving(prev => { const n = new Set(prev); n.delete(stepId); return n; });
    }
  };

  const deleteStep = async (stepId: number) => {
    setSteps(prev => prev.filter(s => s.id !== stepId));
    try {
      await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/analytics/${stepId}`, { method: "DELETE" });
    } catch { /* ignore */ }
  };

  // Computed stats
  const totalImpressions = visibleSteps.reduce((s, x) => s + (parseFloat(x.impressions) || 0), 0);
  const totalClicks = visibleSteps.reduce((s, x) => s + (parseFloat(x.clicks) || 0), 0);
  const avgCR = visibleSteps.length > 0
    ? (visibleSteps.reduce((s, x) => s + (parseFloat(x.cr) || 0), 0) / visibleSteps.length)
    : 0;
  const avgAOV = visibleSteps.length > 0
    ? (visibleSteps.reduce((s, x) => s + (parseFloat(x.aov) || 0), 0) / visibleSteps.length)
    : 0;

  const feColumns = ["# ", "Step", "Tipo", "Impression", "Click", "CTR %", "CR %", "CPA €", "Azioni"];
  const beColumns = ["# ", "Step", "Tipo", "AOV €", "Upsell %", "Refund %", "Azioni"];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1 flex items-center gap-2">
          <BarChart2 className="w-5 h-5 text-primary" /> Analytics
        </h2>
        <p className="text-sm text-muted-foreground">Performance metriche del funnel. Inserimento dati manuale.</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-card border border-border rounded-xl px-4 py-3 text-center">
          <p className="text-xl font-bold text-foreground">{totalImpressions.toLocaleString("it-IT")}</p>
          <p className="text-xs text-muted-foreground">Impressioni</p>
        </div>
        <div className="bg-card border border-border rounded-xl px-4 py-3 text-center">
          <p className="text-xl font-bold text-foreground">{totalClicks.toLocaleString("it-IT")}</p>
          <p className="text-xs text-muted-foreground">Click Totali</p>
        </div>
        <div className="bg-card border border-border rounded-xl px-4 py-3 text-center">
          <p className={`text-xl font-bold ${avgCR >= 3 ? "text-green-600" : "text-amber-600"}`}>{avgCR.toFixed(2)}%</p>
          <p className="text-xs text-muted-foreground">CVR Medio</p>
        </div>
        <div className="bg-card border border-border rounded-xl px-4 py-3 text-center">
          <p className="text-xl font-bold text-foreground">€{avgAOV.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground">AOV Medio</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1 border-b border-border">
          {(["frontend", "backend"] as const).map(tab => (
            <button key={tab} onClick={() => setActiveSection(tab)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${tab === activeSection ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              {tab === "frontend" ? "Front End" : "Back End"}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={addStep} className="bg-primary text-primary-foreground gap-1.5">
          <Plus className="w-3.5 h-3.5" /> Aggiungi Step
        </Button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Caricamento...</div>
      ) : visibleSteps.length === 0 ? (
        <div className="py-16 text-center border-2 border-dashed border-border rounded-xl">
          <BarChart2 className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-medium text-foreground mb-1">Nessun dato ancora</p>
          <p className="text-xs text-muted-foreground mb-4">Aggiungi gli step del funnel e inserisci le metriche di performance.</p>
          <Button size="sm" onClick={addStep} className="bg-primary text-primary-foreground gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Aggiungi Step
          </Button>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-muted/60 border-b border-border">
                  {(activeSection === "frontend" ? feColumns : beColumns).map(h => (
                    <th key={h} className="text-left px-3 py-2 font-semibold text-muted-foreground text-[10px] uppercase tracking-wider whitespace-nowrap border-r border-border/50 last:border-r-0">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleSteps.map((step, idx) => (
                  <tr key={step.id} className={`border-b border-border/50 last:border-b-0 hover:bg-primary/5 transition-colors ${idx % 2 === 0 ? "bg-card" : "bg-muted/20"}`}>
                    <td className="px-3 py-2 border-r border-border/50 text-center">
                      <span className="w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-bold mx-auto">{idx + 1}</span>
                    </td>
                    <td className="px-2 py-1 border-r border-border/50 min-w-[130px]">
                      <EditableCell value={step.step_name} onChange={v => updateStep(step.id, { step_name: v })} placeholder="Nome step" />
                    </td>
                    <td className="px-2 py-1 border-r border-border/50 min-w-[120px]">
                      <select value={step.step_type} onChange={e => updateStep(step.id, { step_type: e.target.value })}
                        className="text-[11px] w-full bg-transparent focus:outline-none cursor-pointer">
                        {STEP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </td>
                    {activeSection === "frontend" ? (
                      <>
                        <td className="px-2 py-1 border-r border-border/50 min-w-[90px]">
                          <EditableCell value={step.impressions} onChange={v => updateStep(step.id, { impressions: v })} />
                        </td>
                        <td className="px-2 py-1 border-r border-border/50 min-w-[80px]">
                          <EditableCell value={step.clicks} onChange={v => updateStep(step.id, { clicks: v })} />
                        </td>
                        <td className="px-2 py-1 border-r border-border/50 min-w-[70px]">
                          <EditableCell value={step.ctr} onChange={v => updateStep(step.id, { ctr: v })} suffix="%" />
                        </td>
                        <td className="px-2 py-1 border-r border-border/50 min-w-[70px]">
                          <EditableCell value={step.cr} onChange={v => updateStep(step.id, { cr: v })} suffix="%" className={crColor(step.cr, step.step_type)} />
                        </td>
                        <td className="px-2 py-1 border-r border-border/50 min-w-[70px]">
                          <EditableCell value={step.cpa} onChange={v => updateStep(step.id, { cpa: v })} suffix="€" />
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-2 py-1 border-r border-border/50 min-w-[80px]">
                          <EditableCell value={step.aov} onChange={v => updateStep(step.id, { aov: v })} suffix="€" />
                        </td>
                        <td className="px-2 py-1 border-r border-border/50 min-w-[80px]">
                          <EditableCell value={step.upsell_rate} onChange={v => updateStep(step.id, { upsell_rate: v })} suffix="%" />
                        </td>
                        <td className="px-2 py-1 border-r border-border/50 min-w-[80px]">
                          <EditableCell value={step.refund_rate} onChange={v => updateStep(step.id, { refund_rate: v })} suffix="%" />
                        </td>
                      </>
                    )}
                    <td className="px-2 py-1 min-w-[60px] text-center">
                      <div className="flex items-center gap-1 justify-center">
                        {saving.has(step.id) && <RefreshCw className="w-3 h-3 text-muted-foreground animate-spin" />}
                        <button onClick={() => deleteStep(step.id)}
                          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Visual Funnel Flow */}
          {visibleSteps.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-6">
              <h3 className="font-semibold text-foreground text-sm mb-4 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-primary" /> Mappa Funnel Visuale
              </h3>
              <div className="flex items-center gap-0 overflow-x-auto pb-2">
                {visibleSteps.map((step, i) => {
                  const cr = parseFloat(step.cr) || 0;
                  const isGood = cr >= 3;
                  const isMid = cr >= 1 && cr < 3;
                  return (
                    <div key={step.id} className="flex items-center flex-shrink-0">
                      <div className={`rounded-xl border-2 p-3 text-center min-w-[110px] ${isGood ? "border-green-400 bg-green-50" : isMid ? "border-amber-400 bg-amber-50" : cr > 0 ? "border-red-400 bg-red-50" : "border-border bg-muted/30"}`}>
                        <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">{step.step_type}</p>
                        <p className="text-xs font-semibold text-foreground mt-0.5 truncate max-w-[100px]">{step.step_name}</p>
                        {activeSection === "frontend" ? (
                          <p className={`text-lg font-bold mt-1 ${isGood ? "text-green-600" : isMid ? "text-amber-600" : cr > 0 ? "text-red-600" : "text-muted-foreground"}`}>
                            {cr > 0 ? `${cr.toFixed(1)}%` : "—"}
                          </p>
                        ) : (
                          <p className="text-lg font-bold text-foreground mt-1">
                            {parseFloat(step.aov) > 0 ? `€${parseFloat(step.aov).toFixed(0)}` : "—"}
                          </p>
                        )}
                        <p className="text-[9px] text-muted-foreground">{activeSection === "frontend" ? "CVR" : "AOV"}</p>
                      </div>
                      {i < visibleSteps.length - 1 && (
                        <div className="flex items-center px-1">
                          <div className="h-px w-6 bg-border" />
                          <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          <div className="h-px w-1 bg-border" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center gap-4 mt-3">
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-green-400" /><span className="text-xs text-muted-foreground">Alta performance</span></div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-amber-400" /><span className="text-xs text-muted-foreground">Media performance</span></div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-red-400" /><span className="text-xs text-muted-foreground">Bassa performance</span></div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Data Connections */}
      <div className="bg-muted/30 border border-dashed border-border rounded-xl p-5">
        <h3 className="font-semibold text-foreground text-sm mb-3">Connessioni Dati</h3>
        <div className="flex flex-wrap gap-2">
          {["Facebook Ads", "TikTok Ads", "CheckoutChamp", "Hyros"].map(name => (
            <Button key={name} size="sm" variant="outline" className="text-xs gap-1.5 opacity-60 cursor-not-allowed">
              <Plus className="w-3 h-3" /> {name}
              <Badge variant="secondary" className="text-[9px] ml-1">Prossimamente</Badge>
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
