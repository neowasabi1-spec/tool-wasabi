import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Trash2, RefreshCw, ExternalLink, Globe, TrendingUp,
  Zap, Eye, Play, Pause, Clock, Calendar, BarChart2,
  Monitor, Smartphone, ChevronDown, ChevronUp, CheckCircle,
  AlertTriangle, ArrowRight, Lightbulb, Target, Star, Shield,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const BASE_URL = "";

type Monitor = {
  id: number;
  project_id: string;
  brand_name: string;
  url: string;
  frequency: string;
  status: string;
  last_checked: string | null;
  next_check: string | null;
  notes: string;
  created_at: string;
};

type Highlight = { x: number; y: number; w: number; h: number; color: string; label?: string };

type Change = {
  element: string;
  categoria?: string;
  prima: string;
  dopo: string;
  ipotesi: string;
  impact?: "positive" | "neutral" | "negative";
  highlights_before?: Highlight[];
  highlights_after?: Highlight[];
};

type CroElements = {
  cro_score?: number;
  platform?: string;
  headline?: string;
  cta?: string;
  value_proposition?: string;
  social_proof?: string;
  urgency?: string;
  pricing?: string;
  trust_signals?: string;
  funnel_type?: string;
  recommendations?: string[];
  key_observations?: string[];
};

type Snapshot = {
  id: number;
  monitor_id: number;
  checked_at: string;
  page_description: string;
  cro_elements_json: string;
  changes_json: string;
  ai_analysis: string;
  screenshot_url: string;
};

// ── Utilities ──────────────────────────────────────────────────────────────

const FREQ_LABELS: Record<string, string> = {
  daily: "Daily", every_7_days: "Every 7 days",
  every_15_days: "Every 15 days", every_30_days: "Every 30 days",
};

function parseSafe<T>(json: string, fallback: T): T {
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

function formatDateTime(d: string) {
  const dt = new Date(d);
  return {
    date: dt.toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" }),
    time: dt.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
  };
}

function getSeverity(changes: Change[]) {
  const n = changes.length;
  if (n === 0) return { label: "No Changes", color: "text-muted-foreground", bg: "bg-muted/50 text-muted-foreground", dot: "bg-muted-foreground/30 border-2 border-muted-foreground/20" };
  if (n === 1) return { label: "Minor", color: "text-blue-600", bg: "bg-blue-50 text-blue-700 border border-blue-200", dot: "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.4)]" };
  if (n <= 3) return { label: "Moderate", color: "text-amber-600", bg: "bg-amber-50 text-amber-700 border border-amber-200", dot: "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.4)]" };
  return { label: "Significant", color: "text-red-600", bg: "bg-red-50 text-red-700 border border-red-200", dot: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]" };
}

function getImpact(changes: Change[], aiAnalysis: string) {
  const positiveCount = changes.filter(c => c.impact === "positive").length;
  const negativeCount = changes.filter(c => c.impact === "negative").length;
  if (changes.length === 0) return { label: "Neutral", icon: "→", color: "text-muted-foreground", bg: "bg-muted/50 text-muted-foreground" };
  if (positiveCount > negativeCount) return { label: "Positive", icon: "↑", color: "text-green-600", bg: "bg-green-50 text-green-700 border border-green-200" };
  if (negativeCount > positiveCount) return { label: "Negative", icon: "↓", color: "text-red-600", bg: "bg-red-50 text-red-700 border border-red-200" };
  return { label: "Neutral", icon: "→", color: "text-muted-foreground", bg: "bg-muted/50 text-muted-foreground" };
}

// ── Screenshot with overlay highlights ─────────────────────────────────────

function ScreenshotWithHighlights({ url, highlights = [], label }: { url: string; highlights?: Highlight[]; label: string }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className="flex-1 min-w-0">
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">{label}</p>
      <div className="relative rounded-xl overflow-hidden border border-border bg-muted/30 aspect-[9/16] sm:aspect-[3/4]">
        {!error ? (
          <>
            <img
              src={url}
              alt={label}
              onLoad={() => setLoaded(true)}
              onError={() => setError(true)}
              className={`w-full h-full object-cover object-top transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
            />
            {!loaded && (
              <div className="absolute inset-0 flex items-center justify-center bg-muted/50">
                <RefreshCw className="w-5 h-5 text-muted-foreground animate-spin" />
              </div>
            )}
            {/* Highlight overlays */}
            {loaded && highlights.map((h, i) => (
              <div
                key={i}
                className="absolute rounded-sm pointer-events-none"
                style={{
                  left: `${h.x}%`, top: `${h.y}%`,
                  width: `${h.w}%`, height: `${h.h}%`,
                  border: `2.5px solid ${h.color}`,
                  backgroundColor: `${h.color}22`,
                  boxShadow: `0 0 0 1px ${h.color}44`,
                }}
              >
                {h.label && (
                  <span className="absolute -top-5 left-0 text-[9px] font-bold px-1.5 py-0.5 rounded text-white whitespace-nowrap"
                    style={{ backgroundColor: h.color }}>{h.label}</span>
                )}
              </div>
            ))}
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-muted/30 text-muted-foreground">
            <Globe className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-xs">Screenshot unavailable</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Change Card ─────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  "Layout & UX": "#8b5cf6",
  "CTA": "#22c55e",
  "Headline": "#3b82f6",
  "Pricing": "#f59e0b",
  "Social Proof": "#06b6d4",
  "Urgenza": "#ef4444",
  "Trust Signal": "#10b981",
  "default": "#6b7280",
};

function ChangeCard({ change }: { change: Change }) {
  const catColor = CATEGORY_COLORS[change.categoria ?? "default"] ?? CATEGORY_COLORS["default"];
  const impactColors = {
    positive: "bg-green-50 border-green-200 text-green-700",
    negative: "bg-red-50 border-red-200 text-red-700",
    neutral: "bg-muted/40 border-border text-muted-foreground",
  };
  const impactClass = impactColors[change.impact ?? "neutral"];

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* Category header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border"
        style={{ backgroundColor: `${catColor}12` }}>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: catColor }} />
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: catColor }}>
            {change.categoria ?? "Change"}
          </span>
        </div>
        {change.element && <span className="text-[10px] text-muted-foreground truncate ml-2">{change.element}</span>}
      </div>

      <div className="p-4 space-y-3">
        {/* Before → After */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-[9px] font-bold text-red-500 uppercase tracking-wider mb-1.5">BEFORE</p>
            <p className="text-xs text-red-800 leading-relaxed line-through opacity-70">{change.prima}</p>
          </div>
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <p className="text-[9px] font-bold text-green-600 uppercase tracking-wider mb-1.5">AFTER</p>
            <p className="text-xs text-green-800 leading-relaxed font-medium">{change.dopo}</p>
          </div>
        </div>

        {/* Hypothesis */}
        <div className="flex gap-2 bg-sky-50 border border-sky-200 rounded-lg p-3">
          <Lightbulb className="w-3.5 h-3.5 text-sky-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-[9px] font-bold text-sky-600 uppercase tracking-wider mb-1">CRO HYPOTHESIS</p>
            <p className="text-xs text-sky-800 leading-relaxed">{change.ipotesi}</p>
          </div>
        </div>

        {/* Impact */}
        {change.impact && (
          <div className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 rounded-full border ${impactClass}`}>
            {change.impact === "positive" ? "↑" : change.impact === "negative" ? "↓" : "→"} {change.impact === "positive" ? "Positive" : change.impact === "negative" ? "Negative" : "Neutral"} Impact
          </div>
        )}
      </div>
    </div>
  );
}

// ── Snapshot Timeline Row ───────────────────────────────────────────────────

function SnapshotTimelineRow({
  snapshot, prevSnapshot, isFirst, isLast, isExpanded, onToggle,
}: {
  snapshot: Snapshot;
  prevSnapshot: Snapshot | null;
  isFirst: boolean;
  isLast: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const changes = parseSafe<Change[]>(snapshot.changes_json, []);
  const cro = parseSafe<CroElements>(snapshot.cro_elements_json, {});
  const severity = getSeverity(changes);
  const impact = getImpact(changes, snapshot.ai_analysis);
  const { date, time } = formatDateTime(snapshot.checked_at);
  const croScore = cro.cro_score;
  const platform = cro.platform ?? "Desktop";
  const recommendations = cro.recommendations ?? [];
  const keyObservations = cro.key_observations ?? [];

  // All highlights for after screenshot
  const allHighlightsAfter = changes.flatMap(c => c.highlights_after ?? []);
  const allHighlightsBefore = changes.flatMap(c => c.highlights_before ?? []);

  return (
    <div className="flex gap-0">
      {/* Timeline connector */}
      <div className="flex flex-col items-center flex-shrink-0 w-8 mr-4">
        <div className={`w-3.5 h-3.5 rounded-full flex-shrink-0 z-10 mt-5 ${severity.dot}`} />
        {!isLast && <div className="w-px flex-1 bg-border mt-1" />}
      </div>

      {/* Content */}
      <div className={`flex-1 min-w-0 mb-4 rounded-2xl border transition-all overflow-hidden ${isExpanded ? "border-primary/30 shadow-sm" : "border-border hover:border-border/80"}`}>
        {/* Collapsed header row */}
        <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-3 bg-card hover:bg-muted/20 transition-colors text-left">
          {/* Thumbnail */}
          <div className="w-16 h-12 rounded-lg overflow-hidden border border-border bg-muted/30 flex-shrink-0">
            <img src={snapshot.screenshot_url} alt="" className="w-full h-full object-cover object-top" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
          </div>

          {/* Date + badges */}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
              <span className="text-sm font-semibold text-foreground">{date}</span>
              <span className="text-xs text-muted-foreground">{time}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Severity */}
              <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${severity.bg}`}>
                {changes.length > 0 && <AlertTriangle className="w-2.5 h-2.5" />}
                {severity.label}
              </span>
              {/* CRO Score */}
              {croScore !== undefined && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-muted/50 text-muted-foreground border border-border">
                  <BarChart2 className="w-2.5 h-2.5" /> {croScore}/100
                </span>
              )}
              {/* Platform */}
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-muted/50 text-muted-foreground border border-border">
                {platform === "Mobile" ? <Smartphone className="w-2.5 h-2.5" /> : <Monitor className="w-2.5 h-2.5" />} {platform}
              </span>
              {/* Changes count */}
              {changes.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-muted/50 text-muted-foreground border border-border">
                  ↑ {changes.length}
                </span>
              )}
              {/* Impact */}
              <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${impact.bg}`}>
                {impact.icon} {impact.label}
              </span>
            </div>
          </div>

          <ChevronDown className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
        </button>

        {/* Summary text (always visible when collapsed) */}
        {!isExpanded && snapshot.page_description && (
          <div className="px-4 pb-3 bg-card">
            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{snapshot.page_description}</p>
          </div>
        )}

        {/* Expanded content */}
        {isExpanded && (
          <div className="border-t border-border bg-muted/5 p-5 space-y-6">
            {/* Full description */}
            {snapshot.page_description && (
              <p className="text-sm text-foreground leading-relaxed">{snapshot.page_description}</p>
            )}

            {/* Before / After screenshots */}
            {(prevSnapshot || snapshot.screenshot_url) && (
              <div>
                <p className="text-xs font-bold text-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Eye className="w-4 h-4 text-primary" /> Visual Comparison
                </p>
                <div className="flex gap-4">
                  {prevSnapshot ? (
                    <ScreenshotWithHighlights
                      url={prevSnapshot.screenshot_url}
                      highlights={allHighlightsBefore}
                      label={`Before — ${formatDateTime(prevSnapshot.checked_at).date}`}
                    />
                  ) : (
                    <div className="flex-1 flex items-center justify-center border-2 border-dashed border-border rounded-xl py-8 text-muted-foreground text-xs text-center">
                      <div>
                        <Globe className="w-6 h-6 mx-auto mb-1 opacity-30" />
                        First baseline analysis
                      </div>
                    </div>
                  )}
                  <ScreenshotWithHighlights
                    url={snapshot.screenshot_url}
                    highlights={allHighlightsAfter}
                    label={`After — ${date}`}
                  />
                </div>
              </div>
            )}

            {/* Change cards */}
            {changes.length > 0 && (
              <div>
                <p className="text-xs font-bold text-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500" /> {changes.length} Change{changes.length === 1 ? "" : "s"} Detected
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {changes.map((c, i) => <ChangeCard key={i} change={c} />)}
                </div>
              </div>
            )}

            {changes.length === 0 && !isFirst && (
              <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-700">
                <CheckCircle className="w-5 h-5" /> No changes detected compared to the previous analysis.
              </div>
            )}

            {/* Recommendations + Key Observations */}
            {(recommendations.length > 0 || keyObservations.length > 0) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {recommendations.length > 0 && (
                  <div className="bg-card border border-border rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
                        <Target className="w-3.5 h-3.5 text-primary" /> Recommendations
                      </p>
                      <span className="text-[10px] font-bold px-2 py-0.5 bg-primary/10 text-primary rounded-full">{recommendations.length}</span>
                    </div>
                    <ul className="space-y-1.5">
                      {recommendations.slice(0, 4).map((r, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-foreground">
                          <ArrowRight className="w-3 h-3 text-primary flex-shrink-0 mt-0.5" /> {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {keyObservations.length > 0 && (
                  <div className="bg-card border border-border rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
                        <Star className="w-3.5 h-3.5 text-amber-500" /> Key Observations
                      </p>
                      <span className="text-[10px] font-bold px-2 py-0.5 bg-amber-50 text-amber-700 rounded-full border border-amber-200">{keyObservations.length}</span>
                    </div>
                    <ul className="space-y-1.5">
                      {keyObservations.slice(0, 4).map((o, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-foreground">
                          <Star className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" /> {o}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* AI Analysis */}
            {snapshot.ai_analysis && (
              <div className="bg-gradient-to-br from-violet-50 to-indigo-50 border border-violet-200 rounded-xl p-4">
                <p className="text-[10px] font-bold text-violet-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5" /> AI Strategic Analysis
                </p>
                <p className="text-sm text-violet-900 leading-relaxed">{snapshot.ai_analysis}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Monitor detail view ─────────────────────────────────────────────────────

function MonitorDetail({ monitor, projectId, onDelete }: { monitor: Monitor; projectId: string; onDelete: () => void }) {
  const { toast } = useToast();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/funnel-monitoring/${monitor.id}/snapshots`);
        if (r.ok) {
          const data = await r.json();
          setSnapshots(data);
          if (data.length > 0) setExpandedId(data[0].id);
        }
      } finally { setLoading(false); }
    })();
  }, [monitor.id, projectId]);

  const runCheck = async () => {
    setChecking(true);
    toast({ title: `Analyzing ${monitor.brand_name}…`, description: "Navigating the funnel. Please wait." });
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/funnel-monitoring/${monitor.id}/check`, { method: "POST" });
      if (r.ok) {
        const { snapshot, is_first_check } = await r.json();
        const changes = parseSafe<Change[]>(snapshot.changes_json, []);
        toast({
          title: is_first_check ? "First analysis complete!" : `${changes.length} change${changes.length === 1 ? "" : "s"} detected`,
          description: is_first_check ? "Baseline snapshot saved." : changes.length > 0 ? "Scroll the timeline for details." : "No significant changes.",
        });
        setSnapshots(p => [snapshot, ...p]);
        setExpandedId(snapshot.id);
      } else { toast({ title: "Error during analysis", variant: "destructive" }); }
    } catch { toast({ title: "Network error", variant: "destructive" }); } finally { setChecking(false); }
  };

  const toggleStatus = async () => {
    setToggling(true);
    const newStatus = monitor.status === "active" ? "paused" : "active";
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/funnel-monitoring/${monitor.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    monitor.status = newStatus;
    setToggling(false);
    toast({ title: newStatus === "active" ? "Monitor activated" : "Monitor paused" });
  };

  const deleteMonitor = async () => {
    if (!confirm(`Delete the monitor for ${monitor.brand_name}?`)) return;
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/funnel-monitoring/${monitor.id}`, { method: "DELETE" });
    onDelete();
    toast({ title: "Monitor deleted" });
  };

  return (
    <div className="space-y-4">
      {/* Monitor info bar */}
      <div className="flex items-center gap-3 px-4 py-3 bg-card border border-border rounded-xl">
        <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${monitor.status === "active" ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]" : "bg-muted-foreground/30"}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{monitor.brand_name}</p>
            <a href={monitor.url} target="_blank" rel="noopener noreferrer"
              className="text-[11px] text-muted-foreground hover:text-primary flex items-center gap-1">
              {monitor.url} <ExternalLink className="w-2.5 h-2.5" />
            </a>
          </div>
          {monitor.notes && <p className="text-[11px] text-muted-foreground italic mt-0.5">{monitor.notes}</p>}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="text-[10px] text-muted-foreground hidden sm:block">{FREQ_LABELS[monitor.frequency] ?? monitor.frequency}</span>
          <Button size="sm" onClick={runCheck} disabled={checking} className="h-7 px-3 text-xs bg-primary text-white gap-1.5">
            {checking ? <><RefreshCw className="w-3 h-3 animate-spin" /> Analyzing…</> : <><Eye className="w-3 h-3" /> Check now</>}
          </Button>
          <button onClick={toggleStatus} disabled={toggling} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors" title={monitor.status === "active" ? "Pause" : "Reactivate"}>
            {monitor.status === "active" ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>
          <button onClick={deleteMonitor} className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Timeline */}
      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading timeline…
        </div>
      ) : snapshots.length === 0 ? (
        <div className="py-20 text-center border-2 border-dashed border-border rounded-2xl">
          <Globe className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-base font-semibold text-foreground mb-1">No checks yet</p>
          <p className="text-sm text-muted-foreground mb-4">Click "Check now" to start the first funnel analysis.</p>
          <Button onClick={runCheck} disabled={checking} className="bg-primary text-white gap-1.5">
            {checking ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Analyzing…</> : <><Eye className="w-3.5 h-3.5" /> First analysis</>}
          </Button>
        </div>
      ) : (
        <div className="space-y-0 pt-2">
          {snapshots.map((snap, i) => (
            <SnapshotTimelineRow
              key={snap.id}
              snapshot={snap}
              prevSnapshot={snapshots[i + 1] ?? null}
              isFirst={i === 0}
              isLast={i === snapshots.length - 1}
              isExpanded={expandedId === snap.id}
              onToggle={() => setExpandedId(prev => prev === snap.id ? null : snap.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── MAIN COMPONENT ──────────────────────────────────────────────────────────

export function FunnelMonitoringSection({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMonitorId, setSelectedMonitorId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ brand_name: "", url: "", frequency: "every_15_days", notes: "" });
  const [adding, setAdding] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/funnel-monitoring`);
      if (r.ok) {
        const data = await r.json();
        setMonitors(data);
        if (data.length > 0 && !selectedMonitorId) setSelectedMonitorId(data[0].id);
      }
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [projectId]);

  const selectedMonitor = monitors.find(m => m.id === selectedMonitorId) ?? null;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.brand_name.trim() || !form.url.trim()) {
      toast({ title: "Brand name and URL are required", variant: "destructive" }); return;
    }
    let url = form.url.trim();
    if (!url.startsWith("http")) url = `https://${url}`;
    setAdding(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/funnel-monitoring`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, url }),
      });
      if (r.ok) {
        const mon = await r.json();
        setMonitors(p => [mon, ...p]);
        setSelectedMonitorId(mon.id);
        setAddOpen(false);
        setForm({ brand_name: "", url: "", frequency: "every_15_days", notes: "" });
        toast({ title: "Monitor added!", description: "Click 'Check now' to start the first analysis." });
      }
    } catch { toast({ title: "Error", variant: "destructive" }); } finally { setAdding(false); }
  };

  if (loading) {
    return (
      <div className="py-24 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
        <RefreshCw className="w-4 h-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-xl font-bold text-foreground flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-primary" /> Funnel Monitoring
          </h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Timeline of AI-detected changes with CRO analysis and before/after comparison.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)} className="bg-primary text-white gap-1.5 text-sm flex-shrink-0">
          <Plus className="w-4 h-4" /> Add Brand
        </Button>
      </div>

      {monitors.length === 0 ? (
        /* Empty state */
        <div className="space-y-5">
          <div className="bg-gradient-to-r from-violet-50 to-indigo-50 border border-violet-200 rounded-2xl px-5 py-4 flex items-start gap-3">
            <Zap className="w-5 h-5 text-violet-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-violet-800 mb-1">How it works</p>
              <p className="text-xs text-violet-700 leading-relaxed">
                Add a brand with the funnel link → Click <strong>"Check now"</strong> → The AI analyzes the page, identifies CRO elements and, on subsequent checks, shows you before/after with highlighted changes and hypothesizes why.
              </p>
            </div>
          </div>
          <div className="py-20 text-center border-2 border-dashed border-border rounded-2xl">
            <Globe className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-base font-semibold text-foreground mb-1">No funnels monitored</p>
            <p className="text-sm text-muted-foreground mb-4">Add a competitor with the link to their landing page.</p>
            <Button onClick={() => setAddOpen(true)} className="bg-primary text-white gap-1.5">
              <Plus className="w-4 h-4" /> Add your first brand
            </Button>
          </div>
        </div>
      ) : (
        /* Monitor tabs + detail */
        <div className="space-y-4">
          {/* Monitor selector pills */}
          <div className="flex flex-wrap gap-2">
            {monitors.map(m => (
              <button key={m.id} onClick={() => setSelectedMonitorId(m.id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-medium transition-all ${selectedMonitorId === m.id
                  ? "bg-primary text-white border-primary shadow-sm"
                  : "bg-card border-border text-foreground hover:border-primary/50"}`}>
                <div className={`w-2 h-2 rounded-full ${m.status === "active" ? "bg-green-400" : "bg-muted-foreground/30"} ${selectedMonitorId === m.id ? "bg-white/70" : ""}`} />
                {m.brand_name}
              </button>
            ))}
          </div>

          {/* Selected monitor detail */}
          {selectedMonitor && (
            <MonitorDetail
              key={selectedMonitor.id}
              monitor={selectedMonitor}
              projectId={projectId}
              onDelete={() => {
                setMonitors(p => p.filter(x => x.id !== selectedMonitor.id));
                const remaining = monitors.filter(x => x.id !== selectedMonitor.id);
                setSelectedMonitorId(remaining[0]?.id ?? null);
              }}
            />
          )}
        </div>
      )}

      {/* Add dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add Brand to Monitor</DialogTitle></DialogHeader>
          <form onSubmit={add} className="space-y-4 mt-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Brand Name *</label>
              <Input value={form.brand_name} onChange={e => setForm(p => ({ ...p, brand_name: e.target.value }))}
                placeholder="E.g. bioma.health, MyProtein…" className="text-sm" autoFocus />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Funnel / Landing Page URL *</label>
              <Input value={form.url} onChange={e => setForm(p => ({ ...p, url: e.target.value }))}
                placeholder="https://www.bioma.health/" className="text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Frequency</label>
              <select value={form.frequency} onChange={e => setForm(p => ({ ...p, frequency: e.target.value }))}
                className="w-full text-sm border border-border rounded-md px-3 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-primary">
                <option value="daily">Daily</option>
                <option value="every_7_days">Every 7 days</option>
                <option value="every_15_days">Every 15 days</option>
                <option value="every_30_days">Every 30 days</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Notes (optional)</label>
              <Input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                placeholder="E.g. Focus on checkout, monitor pricing…" className="text-sm" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={adding} className="bg-primary text-white gap-1.5">
                {adding ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Adding…</> : <><Plus className="w-3.5 h-3.5" /> Add</>}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
