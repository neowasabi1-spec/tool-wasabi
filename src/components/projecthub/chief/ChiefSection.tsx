import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Brain, Globe, Clock, ChevronRight, AlertTriangle,
  CheckCircle, Lightbulb, FlaskConical, Zap, RefreshCw, X,
} from "lucide-react";

const BASE_URL = "";

type CroAnalysis = {
  id: number;
  url: string;
  context_notes: string;
  report_json: string | null;
  created_at: string;
};

type CroReport = {
  overview: string;
  strengths: string[];
  critical_issues: Array<{
    priority: number;
    title: string;
    element: string;
    problem: string;
    fix: string;
    impact: "High" | "Medium" | "Low";
  }>;
  assumptions: string[];
  ab_tests: string[];
  priority_actions: string[];
};

function parseReport(json: string | null): CroReport | null {
  if (!json) return null;
  try {
    const match = json.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return null;
  } catch { return null; }
}

function impactColor(impact: string) {
  if (impact === "High") return "bg-red-100 text-red-700 border-red-200";
  if (impact === "Medium") return "bg-amber-100 text-amber-700 border-amber-200";
  return "bg-blue-100 text-blue-700 border-blue-200";
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function ReportView({ report, url, onClose }: { report: CroReport; url: string; onClose: () => void }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-foreground">Analisi CRO</h3>
          <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1">
            <Globe className="w-3 h-3" /> {url}
          </a>
        </div>
        <Button size="sm" variant="outline" onClick={onClose} className="gap-1.5">
          <X className="w-3.5 h-3.5" /> Chiudi
        </Button>
      </div>

      {/* Overview */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-5">
        <h4 className="font-semibold text-blue-800 text-sm mb-2 flex items-center gap-2">
          <Brain className="w-4 h-4" /> Overview
        </h4>
        <p className="text-sm text-blue-700">{report.overview}</p>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Strengths */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <h4 className="font-semibold text-foreground text-sm flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-green-500" /> Punti di Forza
          </h4>
          <ul className="space-y-2">
            {(report.strengths || []).map((s, i) => (
              <li key={i} className="text-sm text-foreground flex items-start gap-2">
                <span className="text-green-500 mt-0.5">✓</span> {s}
              </li>
            ))}
          </ul>
        </div>

        {/* Assumptions */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <h4 className="font-semibold text-foreground text-sm flex items-center gap-2">
            <Lightbulb className="w-4 h-4 text-amber-500" /> Ipotesi
          </h4>
          <ul className="space-y-2">
            {(report.assumptions || []).map((a, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-amber-500 mt-0.5">→</span> {a}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Critical Issues */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <h4 className="font-semibold text-foreground text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-500" /> Problemi Critici ({(report.critical_issues || []).length})
        </h4>
        <div className="space-y-3">
          {(report.critical_issues || []).sort((a, b) => a.priority - b.priority).map((issue, i) => (
            <div key={i} className="border border-border rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-foreground text-background flex items-center justify-center text-xs font-bold">{issue.priority}</span>
                  <span className="font-semibold text-sm text-foreground">{issue.title}</span>
                </div>
                <Badge className={`text-[10px] border ${impactColor(issue.impact)}`}>{issue.impact}</Badge>
              </div>
              <p className="text-xs text-muted-foreground"><span className="font-medium">Elemento:</span> {issue.element}</p>
              <p className="text-xs text-foreground/80"><span className="font-medium text-red-600">Problema:</span> {issue.problem}</p>
              <p className="text-xs text-foreground/80"><span className="font-medium text-green-600">Fix:</span> {issue.fix}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* A/B Tests */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <h4 className="font-semibold text-foreground text-sm flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-purple-500" /> Idee A/B Test
          </h4>
          <ul className="space-y-2">
            {(report.ab_tests || []).map((t, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-purple-500 font-bold mt-0.5">·</span> {t}
              </li>
            ))}
          </ul>
        </div>

        {/* Priority Actions */}
        <div className="bg-primary/5 border border-primary/20 rounded-xl p-5 space-y-3">
          <h4 className="font-semibold text-foreground text-sm flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" /> Piano d'Azione Prioritario
          </h4>
          <ol className="space-y-2">
            {(report.priority_actions || []).map((a, i) => (
              <li key={i} className="text-sm text-foreground flex items-start gap-2">
                <span className="text-primary font-bold mt-0.5 flex-shrink-0">{i + 1}.</span> {a}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

export function ChiefSection({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<"analyze" | "history">("analyze");
  const [url, setUrl] = useState("");
  const [contextNotes, setContextNotes] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [statusMsg, setStatusMsg] = useState("");
  const [currentReport, setCurrentReport] = useState<{ report: CroReport; url: string } | null>(null);
  const [history, setHistory] = useState<CroAnalysis[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const streamRef = useRef<string>("");

  const loadHistory = async () => {
    setLoadingHistory(true);
    try {
      const resp = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/chief/history`);
      if (resp.ok) setHistory(await resp.json());
    } catch { /* ignore */ } finally { setLoadingHistory(false); }
  };

  useEffect(() => {
    if (activeTab === "history") loadHistory();
  }, [activeTab]);

  const analyze = async () => {
    if (!url.trim()) { toast({ title: "Inserisci un URL", variant: "destructive" }); return; }
    setAnalyzing(true);
    setStreamText("");
    setStatusMsg("Avvio analisi...");
    setCurrentReport(null);
    streamRef.current = "";

    try {
      const resp = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/chief/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), context_notes: contextNotes.trim() }),
      });
      if (!resp.body) throw new Error("No stream");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const d = JSON.parse(line.slice(5).trim());
            if (d.status) setStatusMsg(d.message || d.status);
            if (d.content) { streamRef.current += d.content; setStreamText(streamRef.current); }
            if (d.done) {
              const parsed = parseReport(streamRef.current);
              if (parsed) setCurrentReport({ report: parsed, url: url.trim() });
              else toast({ title: "Analisi completata", description: "Risultati salvati." });
              setStatusMsg("");
              loadHistory();
              toast({ title: "Analisi completata!", description: "Rapporto CRO generato con successo." });
            }
            if (d.error) { toast({ title: "Errore analisi", variant: "destructive" }); setStatusMsg(""); }
          } catch { /* ignore */ }
        }
      }
    } catch {
      toast({ title: "Errore", description: "Analisi fallita", variant: "destructive" });
    } finally {
      setAnalyzing(false);
    }
  };

  const viewHistoryItem = async (item: CroAnalysis) => {
    const parsed = parseReport(item.report_json);
    if (parsed) {
      setCurrentReport({ report: parsed, url: item.url });
      setActiveTab("analyze");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1 flex items-center gap-2">
          <Brain className="w-5 h-5 text-primary" /> Chief — CRO Analyzer
        </h2>
        <p className="text-sm text-muted-foreground">Analisi CRO AI-powered basata sulla metodologia Dan Sultanic e best practice direct-response.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {(["analyze", "history"] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${tab === activeTab ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {tab === "analyze" ? "Analizza" : "Storico"}
          </button>
        ))}
      </div>

      {/* Analyze Tab */}
      {activeTab === "analyze" && (
        <div className="space-y-6">
          {currentReport ? (
            <ReportView report={currentReport.report} url={currentReport.url} onClose={() => setCurrentReport(null)} />
          ) : (
            <div className="bg-card border border-border rounded-xl p-6 space-y-4">
              <h3 className="font-semibold text-foreground text-sm">Nuova Analisi</h3>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">URL da analizzare *</label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input value={url} onChange={e => setUrl(e.target.value)}
                        placeholder="https://example.com/landing-page"
                        className="pl-9" disabled={analyzing} />
                    </div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Contesto aggiuntivo (opzionale)</label>
                  <Textarea value={contextNotes} onChange={e => setContextNotes(e.target.value)}
                    placeholder="Es. Questa è una VSL page per donne 50+, prodotto dental supplement..."
                    rows={2} disabled={analyzing} />
                </div>
                <Button onClick={analyze} disabled={analyzing || !url.trim()}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground gap-2">
                  {analyzing ? <><RefreshCw className="w-4 h-4 animate-spin" /> {statusMsg || "Analisi in corso..."}</> : <><Brain className="w-4 h-4" /> Analizza Funnel</>}
                </Button>
              </div>

              {analyzing && streamText && (
                <div className="bg-muted/40 border border-border rounded-lg p-4 max-h-64 overflow-y-auto">
                  <p className="text-xs font-mono text-muted-foreground whitespace-pre-wrap">{streamText}</p>
                  <span className="inline-block w-1 h-3 bg-primary animate-pulse ml-0.5 align-middle" />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* History Tab */}
      {activeTab === "history" && (
        <div className="space-y-4">
          {loadingHistory ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Caricamento...</div>
          ) : history.length === 0 ? (
            <div className="py-16 text-center border-2 border-dashed border-border rounded-xl">
              <Clock className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Nessuna analisi ancora. Esegui la tua prima analisi CRO!</p>
            </div>
          ) : (
            <div className="space-y-3">
              {history.map(item => {
                const parsed = parseReport(item.report_json);
                return (
                  <div key={item.id} className="bg-card border border-border rounded-xl p-4 hover:border-primary/30 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <a href={item.url} target="_blank" rel="noopener noreferrer"
                          className="text-sm font-medium text-foreground hover:text-primary transition-colors truncate block">
                          {item.url}
                        </a>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="w-3 h-3" /> {formatDate(item.created_at)}
                          </span>
                          {parsed && (
                            <span className="text-xs text-muted-foreground">
                              {parsed.critical_issues?.length || 0} problemi · {parsed.priority_actions?.length || 0} azioni
                            </span>
                          )}
                        </div>
                        {item.context_notes && <p className="text-xs text-muted-foreground mt-1 italic truncate">{item.context_notes}</p>}
                      </div>
                      <Button size="sm" variant="outline" onClick={() => viewHistoryItem(item)}
                        className="gap-1.5 ml-4 flex-shrink-0" disabled={!parsed}>
                        Vedi <ChevronRight className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
