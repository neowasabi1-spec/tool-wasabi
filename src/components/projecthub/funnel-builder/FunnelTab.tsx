import { useState, useRef, useEffect, useCallback } from "react";
import {
  useListFunnelSteps,
  useCreateFunnelStep,
  useUpdateFunnelStep,
  useDeleteFunnelStep,
  useGetFunnelStepChat,
  getListFunnelStepsQueryKey,
  getGetFunnelStepChatQueryKey,
} from "@/lib/projecthub-api";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Trash2,
  Copy,
  ChevronDown,
  Zap,
  MessageSquare,
  Eye,
  X,
  Send,
  Globe,
  Wand2,
  RefreshCw,
  Library,
  Search,
  Check,
  ArrowDownToLine,
  Upload,
  FileCode,
  ExternalLink,
} from "lucide-react";

type FunnelStep = {
  id: number;
  project_id: string;
  step_number: number;
  page_name: string;
  step_type: string;
  url: string;
  html_file_path: string | null;
  html_original_name: string | null;
  target: string;
  angle: string;
  prompt_notes: string;
  auto_gen: string;
  fidelity_mode: string;
  product: string;
  status: string;
  result_content: string | null;
  feedback: string;
  created_at: string;
};

type ChatMsg = { role: "user" | "assistant"; message: string };

const STEP_TYPES = [
  "Landing Page", "Advertorial", "Checkout", "Upsell",
  "Downsell", "Thank You", "Quiz", "Bridge Page", "VSL",
];

const BASE_URL = "";

function statusBadge(status: string) {
  if (status === "completed") return <Badge className="bg-green-100 text-green-700 border-green-200 text-[10px] px-1.5 py-0.5 whitespace-nowrap">Completato</Badge>;
  if (status === "in_progress") return <Badge className="bg-amber-100 text-amber-700 border-amber-200 text-[10px] px-1.5 py-0.5 whitespace-nowrap">In Corso</Badge>;
  return <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5 whitespace-nowrap text-muted-foreground">Pending</Badge>;
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`w-full text-[10px] font-medium rounded px-1.5 py-0.5 transition-colors ${
        value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"
      }`}
    >
      {value ? "ON" : "OFF"}
    </button>
  );
}

function InlineEdit({
  value,
  onChange,
  placeholder,
  className = "",
  multiline = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(value); }, [value]);

  const commit = () => {
    setEditing(false);
    if (draft !== value) onChange(draft);
  };

  if (!editing) {
    return (
      <div
        onClick={() => { setDraft(value); setEditing(true); setTimeout(() => ref.current?.focus(), 0); }}
        className={`cursor-text text-[11px] text-foreground min-h-[20px] hover:bg-muted/40 rounded px-1 py-0.5 transition-colors ${!value ? "text-muted-foreground italic" : ""} ${className}`}
      >
        {value || placeholder || "—"}
      </div>
    );
  }

  const sharedProps = {
    ref,
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" && !multiline) commit(); if (e.key === "Escape") { setDraft(value); setEditing(false); } },
    className: `text-[11px] w-full border border-primary/50 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary bg-background ${className}`,
    autoFocus: true,
  };

  return multiline
    ? <textarea {...sharedProps} rows={2} style={{ resize: "none" }} />
    : <input {...sharedProps} />;
}

function ResultModal({ step, onClose }: { step: FunnelStep; onClose: () => void }) {
  const content = step.result_content || "";
  // Heuristica: il contenuto è HTML renderizzabile? (clone/swipe producono
  // markup). Se sì, default sull'anteprima visiva; altrimenti solo testo.
  const looksLikeHtml = /<(!doctype|html|head|body|div|section|main|header|img|h1|p|a|span)[\s>]/i.test(content);
  const [view, setView] = useState<"preview" | "code">(looksLikeHtml ? "preview" : "code");

  // HTML "stabilizzato" per l'anteprima: riarma gli accordion/FAQ (Funnelish &
  // generici sono puro JS e nello snapshot clonato non sono interattivi),
  // inietta <base href> per gli asset relativi e sblocca lo scroll. Calcolato
  // via dynamic import per non appesantire il bundle e cadere su `content` raw
  // se qualcosa va storto.
  const [previewHtml, setPreviewHtml] = useState<string>(content);
  useEffect(() => {
    let alive = true;
    if (!content) {
      setPreviewHtml("");
      return;
    }
    setPreviewHtml(content);
    (async () => {
      try {
        const { stabilizeClonedHtml } = await import("@/lib/spa-rescue");
        const fixed = stabilizeClonedHtml(content, step.url || "");
        if (alive) setPreviewHtml(fixed);
      } catch {
        /* fallback: content raw già impostato */
      }
    })();
    return () => {
      alive = false;
    };
  }, [content, step.url]);

  const openInNewTab = useCallback(() => {
    if (!content) return;
    const blob = new Blob([previewHtml || content], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    // Revoca differita: lascia il tempo al tab di caricare.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, [content, previewHtml]);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-primary" />
            Risultato — {step.page_name || `Step ${step.step_number}`}
          </DialogTitle>
        </DialogHeader>

        {content && (
          <div className="flex items-center gap-2 mt-2">
            <div className="inline-flex rounded-lg border border-border overflow-hidden">
              <button
                onClick={() => setView("preview")}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${view === "preview" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground"}`}
              >
                <Globe className="w-3.5 h-3.5" /> Anteprima
              </button>
              <button
                onClick={() => setView("code")}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${view === "code" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground"}`}
              >
                <FileCode className="w-3.5 h-3.5" /> HTML
              </button>
            </div>
            <button
              onClick={openInNewTab}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors"
              title="Apri la pagina in una nuova scheda"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Apri in nuova scheda
            </button>
          </div>
        )}

        <div className="mt-4 flex-1 overflow-y-auto">
          {!content ? (
            <p className="text-muted-foreground italic text-sm">Nessun contenuto generato ancora. Premi SWIPE per generare.</p>
          ) : view === "preview" ? (
            <iframe
              srcDoc={previewHtml || content}
              title={`preview-${step.id}`}
              className="w-full h-[70vh] rounded-xl border border-border bg-white"
              sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
            />
          ) : (
            <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm text-foreground bg-muted/30 rounded-xl p-6 border border-border">
              {content}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChatPanel({
  step,
  projectId,
  onClose,
}: {
  step: FunnelStep;
  projectId: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: chatHistory } = useGetFunnelStepChat(projectId, step.id, {
    query: { queryKey: getGetFunnelStepChatQueryKey(projectId, step.id) },
  });

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chatHistory) {
      setMessages(chatHistory.map(h => ({ role: h.role as "user" | "assistant", message: h.message })));
    }
  }, [chatHistory]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  const sendMessage = async () => {
    if (!input.trim() || streaming) return;
    const msg = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", message: msg }]);
    setStreaming(true);
    setStreamingText("");

    try {
      const resp = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/funnel-steps/${step.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      if (!resp.body) throw new Error("No stream");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";

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
            if (d.content) { full += d.content; setStreamingText(full); }
            if (d.done) {
              setMessages(prev => [...prev, { role: "assistant", message: full }]);
              setStreamingText("");
              queryClient.invalidateQueries({ queryKey: getGetFunnelStepChatQueryKey(projectId, step.id) });
            }
          } catch { /* ignore */ }
        }
      }
    } catch {
      toast({ title: "Errore chat", variant: "destructive" });
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="fixed right-0 top-0 h-full w-[420px] bg-card border-l border-border shadow-2xl flex flex-col z-50">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
        <div>
          <p className="font-semibold text-foreground text-sm">AI Editor</p>
          <p className="text-xs text-muted-foreground truncate max-w-[300px]">{step.page_name || `Step ${step.step_number}`}</p>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && !streaming && (
          <div className="text-center py-8">
            <MessageSquare className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">Chiedi all'AI di modificare il contenuto del funnel step.</p>
            <p className="text-xs text-muted-foreground mt-1">Es: "Rendi il titolo più aggressivo" o "Aggiungi una sezione testimonial"</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[90%] rounded-xl px-3 py-2 text-xs ${
              m.role === "user"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-foreground border border-border"
            }`}>
              <p className="whitespace-pre-wrap">{m.message}</p>
            </div>
          </div>
        ))}
        {streaming && streamingText && (
          <div className="flex justify-start">
            <div className="max-w-[90%] rounded-xl px-3 py-2 text-xs bg-muted text-foreground border border-border">
              <p className="whitespace-pre-wrap">{streamingText}</p>
              <span className="inline-block w-1 h-3 bg-primary animate-pulse ml-0.5 align-middle" />
            </div>
          </div>
        )}
        {streaming && !streamingText && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-xl px-3 py-2 text-xs text-muted-foreground">Generando…</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-border flex-shrink-0">
        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            placeholder="Descrivi cosa vuoi modificare…"
            rows={2}
            className="text-xs flex-1 resize-none"
            disabled={streaming}
          />
          <Button
            size="sm"
            onClick={sendMessage}
            disabled={streaming || !input.trim()}
            className="bg-primary hover:bg-primary/90 text-primary-foreground self-end"
          >
            <Send className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

type FunnelLibraryEntry = {
  id: number;
  name: string;
  stepCount: number;
  funnelType: string;
  types: string[];
};

function FunnelLibraryDialog({
  open,
  onClose,
  currentProjectId,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  currentprojectId: string;
  onImported: () => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [library, setLibrary] = useState<FunnelLibraryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState<number | null>(null);
  const [imported, setImported] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`${BASE_URL}/api/projecthub/funnel-library`)
      .then(r => r.json())
      .then((data: FunnelLibraryEntry[]) => {
        setLibrary(data.filter(f => f.id !== currentProjectId));
        setLoading(false);
      })
      .catch(() => {
        toast({ title: "Errore caricamento libreria", variant: "destructive" });
        setLoading(false);
      });
  }, [open, currentProjectId, toast]);

  const filtered = library.filter(f =>
    !search.trim() || f.name.toLowerCase().includes(search.toLowerCase()) || f.funnelType.toLowerCase().includes(search.toLowerCase())
  );

  const doImport = async (source: FunnelLibraryEntry) => {
    setImporting(source.id);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${currentProjectId}/funnel-steps/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceProjectId: source.id }),
      });
      if (r.ok) {
        setImported(prev => new Set(prev).add(source.id));
        toast({ title: "Funnel importato!", description: `${source.stepCount} step aggiunti da "${source.name}".` });
        onImported();
      } else {
        const err = await r.json();
        toast({ title: "Errore importazione", description: err.error ?? "Errore sconosciuto", variant: "destructive" });
      }
    } catch {
      toast({ title: "Errore di rete", variant: "destructive" });
    } finally {
      setImporting(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Library className="w-4 h-4 text-primary" />
            Importa da Funnel Esistente
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">Seleziona un funnel salvato da un altro brand o competitor per importarne gli step.</p>
        </DialogHeader>

        {/* Search */}
        <div className="px-6 pt-4 pb-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Cerca funnel per nome o tipo..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>

        {/* List */}
        <div className="px-6 pb-6 max-h-[380px] overflow-y-auto space-y-1.5">
          {loading && (
            <div className="py-10 text-center text-sm text-muted-foreground">Caricamento libreria…</div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {library.length === 0 ? "Nessun funnel salvato in altri progetti." : "Nessun risultato per la ricerca."}
            </div>
          )}
          {!loading && filtered.map(f => {
            const isImporting = importing === f.id;
            const isImported = imported.has(f.id);
            return (
              <div
                key={f.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 hover:bg-muted/40 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{f.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {f.funnelType} &mdash; {f.stepCount} {f.stepCount === 1 ? "step" : "step"}
                    {f.types.length > 0 && (
                      <span className="ml-1.5 text-muted-foreground/60">({f.types.slice(0, 3).join(", ")}{f.types.length > 3 ? "…" : ""})</span>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => !isImported && doImport(f)}
                  disabled={isImporting || isImported}
                  className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                    isImported
                      ? "bg-green-100 text-green-700 cursor-default"
                      : isImporting
                        ? "bg-muted text-muted-foreground cursor-wait"
                        : "bg-primary text-primary-foreground hover:bg-primary/90"
                  }`}
                >
                  {isImported ? (
                    <><Check className="w-3 h-3" /> Importato</>
                  ) : isImporting ? (
                    <><RefreshCw className="w-3 h-3 animate-spin" /> Importo…</>
                  ) : (
                    <><ArrowDownToLine className="w-3 h-3" /> Importa</>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UrlOrHtmlCell({
  step,
  projectId,
  onPatch,
  onStepUpdate,
}: {
  step: FunnelStep;
  projectId: string;
  onPatch: (patch: Record<string, string>) => void;
  onStepUpdate: (updated: FunnelStep) => void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);

  const hasHtml = !!step.html_file_path;
  const htmlUrl = `${BASE_URL}/api/projecthub/projects/${projectId}/funnel-steps/${step.id}/html`;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const form = new FormData();
    form.append("html", file);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/funnel-steps/${step.id}/upload-html`, {
        method: "POST",
        body: form,
      });
      if (r.ok) {
        const updated = await r.json() as FunnelStep;
        onStepUpdate(updated);
        toast({ title: "HTML caricato!", description: file.name });
      } else {
        const err = await r.json();
        toast({ title: "Errore upload", description: err.error, variant: "destructive" });
      }
    } catch {
      toast({ title: "Errore di rete", variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleRemoveHtml = async () => {
    setRemoving(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/funnel-steps/${step.id}/html`, { method: "DELETE" });
      if (r.ok) {
        const updated = await r.json() as FunnelStep;
        onStepUpdate(updated);
        toast({ title: "HTML rimosso" });
      }
    } catch {
      toast({ title: "Errore", variant: "destructive" });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="flex items-center gap-1 min-w-0">
      {hasHtml ? (
        /* HTML file mode */
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <FileCode className="w-3 h-3 text-blue-500 flex-shrink-0" />
          <span className="text-[10px] text-blue-700 truncate max-w-[90px]" title={step.html_original_name ?? "file.html"}>
            {step.html_original_name ?? "file.html"}
          </span>
          <a
            href={htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Anteprima HTML"
            className="text-blue-500 hover:text-blue-700 flex-shrink-0"
          >
            <ExternalLink className="w-3 h-3" />
          </a>
          <button
            onClick={handleRemoveHtml}
            disabled={removing}
            title="Rimuovi HTML"
            className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors flex-shrink-0"
          >
            {removing ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : <X className="w-2.5 h-2.5" />}
          </button>
        </div>
      ) : (
        /* URL text mode */
        <>
          <InlineEdit value={step.url} onChange={v => onPatch({ url: v })} placeholder="https://..." className="flex-1 min-w-0" />
          {step.url && (
            <a href={step.url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors flex-shrink-0">
              <Globe className="w-3 h-3" />
            </a>
          )}
        </>
      )}

      {/* Upload HTML button — always visible */}
      <button
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        title={hasHtml ? "Sostituisci file HTML" : "Carica file HTML"}
        className="p-0.5 rounded hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition-colors flex-shrink-0"
      >
        {uploading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
      </button>
      <input ref={fileRef} type="file" accept=".html,.htm,text/html" className="hidden" onChange={handleFileChange} />
    </div>
  );
}

export function FunnelTab({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: steps, isLoading } = useListFunnelSteps(projectId, {
    query: { queryKey: getListFunnelStepsQueryKey(projectId) },
  });

  const [localSteps, setLocalSteps] = useState<FunnelStep[]>([]);
  const [swipingSteps, setSwipingSteps] = useState<Set<number>>(new Set());
  const [swipeProgress, setSwipeProgress] = useState<Record<number, string>>({});
  const [resultStep, setResultStep] = useState<FunnelStep | null>(null);
  const [chatStep, setChatStep] = useState<FunnelStep | null>(null);
  const [domain, setDomain] = useState("");
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [customTypeMode, setCustomTypeMode] = useState(false);
  const [customTypeName, setCustomTypeName] = useState("");
  const customTypeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (steps !== undefined) setLocalSteps(steps as FunnelStep[]);
  }, [steps]);

  const createStep = useCreateFunnelStep({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListFunnelStepsQueryKey(projectId) });
      },
      onError: () => toast({ title: "Errore", description: "Impossibile aggiungere step.", variant: "destructive" }),
    },
  });

  const updateStep = useUpdateFunnelStep({
    mutation: {
      onSuccess: (updated) => {
        setLocalSteps(prev => prev.map(s => s.id === (updated as FunnelStep).id ? (updated as FunnelStep) : s));
        queryClient.invalidateQueries({ queryKey: getListFunnelStepsQueryKey(projectId) });
      },
    },
  });

  const deleteStep = useDeleteFunnelStep({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListFunnelStepsQueryKey(projectId) });
        toast({ title: "Step eliminato" });
      },
    },
  });

  const addStep = (type = "Landing Page") => {
    const nextNum = (localSteps.length > 0 ? Math.max(...localSteps.map(s => s.step_number)) : 0) + 1;
    createStep.mutate({
      projectId,
      data: { step_number: nextNum, page_name: "", step_type: type },
    });
  };

  const duplicateStep = (step: FunnelStep) => {
    const nextNum = (localSteps.length > 0 ? Math.max(...localSteps.map(s => s.step_number)) : 0) + 1;
    createStep.mutate({
      projectId,
      data: {
        step_number: nextNum,
        page_name: `${step.page_name} (copia)`,
        step_type: step.step_type,
        url: step.url,
        target: step.target,
        angle: step.angle,
        prompt_notes: step.prompt_notes,
        auto_gen: step.auto_gen,
        fidelity_mode: step.fidelity_mode,
        product: step.product,
      },
    });
  };

  const patchStep = (stepId: number, patch: Record<string, string>) => {
    setLocalSteps(prev => prev.map(s => s.id === stepId ? { ...s, ...patch } : s));
    updateStep.mutate({ projectId, stepId, data: patch });
  };

  const autoNameSteps = () => {
    if (!domain.trim()) { toast({ title: "Inserisci un dominio prima", variant: "destructive" }); return; }
    const dom = domain.replace(/https?:\/\//, "").replace(/\/$/, "");
    localSteps.forEach((step, i) => {
      const slug = step.page_name
        ? step.page_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        : step.step_type.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const url = `https://${dom}/${slug}${i > 0 ? `-${i + 1}` : ""}`;
      patchStep(step.id, { url });
    });
    toast({ title: "URL generati!", description: `Domini assegnati su ${dom}` });
  };

  const triggerSwipe = useCallback(async (step: FunnelStep) => {
    if (swipingSteps.has(step.id)) return;
    setSwipingSteps(prev => new Set(prev).add(step.id));
    setSwipeProgress(prev => ({ ...prev, [step.id]: "" }));
    setLocalSteps(prev => prev.map(s => s.id === step.id ? { ...s, status: "in_progress" } : s));

    try {
      const resp = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/funnel-steps/${step.id}/swipe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!resp.body) throw new Error("No stream");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";

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
            if (d.content) { full += d.content; setSwipeProgress(prev => ({ ...prev, [step.id]: full })); }
            if (d.done) {
              setLocalSteps(prev => prev.map(s => s.id === step.id ? { ...s, status: "completed", result_content: full } : s));
              queryClient.invalidateQueries({ queryKey: getListFunnelStepsQueryKey(projectId) });
              toast({ title: "SWIPE completato!", description: `"${step.page_name || "Step"}" generato con successo.` });
            }
            if (d.error) throw new Error(d.error);
          } catch { /* ignore parse */ }
        }
      }
    } catch {
      setLocalSteps(prev => prev.map(s => s.id === step.id ? { ...s, status: "pending" } : s));
      toast({ title: "SWIPE fallito", variant: "destructive" });
    } finally {
      setSwipingSteps(prev => { const n = new Set(prev); n.delete(step.id); return n; });
      setSwipeProgress(prev => { const n = { ...prev }; delete n[step.id]; return n; });
    }
  }, [swipingSteps, projectId, queryClient, toast]);

  const cleanAll = () => {
    if (!localSteps.length) return;
    if (!confirm("Eliminare tutti gli step?")) return;
    localSteps.forEach(s => deleteStep.mutate({ projectId, stepId: s.id }));
  };

  if (isLoading) return <div className="py-12 text-center text-sm text-muted-foreground">Caricamento…</div>;

  return (
    <div className="space-y-4 relative">
      {/* Top bar row 1 */}
      <div className="flex items-center gap-2 flex-wrap">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground gap-2" size="sm">
              <Plus className="w-3.5 h-3.5" />
              Aggiungi Step
              <ChevronDown className="w-3 h-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem onClick={() => addStep("Landing Page")}>Landing Page</DropdownMenuItem>
            <DropdownMenuItem onClick={() => addStep("Advertorial")}>Advertorial</DropdownMenuItem>
            <DropdownMenuItem onClick={() => addStep("Checkout")}>Checkout</DropdownMenuItem>
            <DropdownMenuItem onClick={() => addStep("Upsell")}>Upsell</DropdownMenuItem>
            <DropdownMenuItem onClick={() => addStep("Downsell")}>Downsell</DropdownMenuItem>
            <DropdownMenuItem onClick={() => addStep("Thank You")}>Thank You</DropdownMenuItem>
            <DropdownMenuItem onClick={() => addStep("Quiz")}>Quiz</DropdownMenuItem>
            <DropdownMenuItem onClick={() => addStep("Bridge Page")}>Bridge Page</DropdownMenuItem>
            <DropdownMenuItem onClick={() => addStep("VSL")}>VSL</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setCustomTypeName("");
                setCustomTypeMode(true);
                setTimeout(() => customTypeRef.current?.focus(), 50);
              }}
              className="text-primary font-medium gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Personalizzato…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="text-sm text-muted-foreground">{localSteps.length} {localSteps.length === 1 ? "step" : "step"}</span>

        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 border-primary/40 text-primary hover:bg-primary/5 hover:border-primary"
          onClick={() => setShowImportDialog(true)}
        >
          <Library className="w-3.5 h-3.5" />
          Importa da Funnel Esistente
        </Button>

        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5 text-destructive hover:text-destructive" onClick={cleanAll}>
            <Trash2 className="w-3.5 h-3.5" />
            Pulisci
          </Button>
        </div>
      </div>

      {/* Custom type input row */}
      {customTypeMode && (
        <div className="flex items-center gap-2 p-3 bg-primary/5 border border-primary/20 rounded-lg">
          <Plus className="w-3.5 h-3.5 text-primary flex-shrink-0" />
          <span className="text-sm text-primary font-medium whitespace-nowrap">Tipo step:</span>
          <input
            ref={customTypeRef}
            value={customTypeName}
            onChange={e => setCustomTypeName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                const t = customTypeName.trim();
                if (t) { addStep(t); setCustomTypeMode(false); setCustomTypeName(""); }
              }
              if (e.key === "Escape") { setCustomTypeMode(false); setCustomTypeName(""); }
            }}
            placeholder="Es. Order Bump, Lead Gen, Webinar…"
            className="flex-1 px-3 py-1.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 max-w-xs"
          />
          <button
            onClick={() => {
              const t = customTypeName.trim();
              if (t) { addStep(t); setCustomTypeMode(false); setCustomTypeName(""); }
            }}
            disabled={!customTypeName.trim()}
            className="px-3 py-1.5 text-xs font-semibold rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Aggiungi
          </button>
          <button
            onClick={() => { setCustomTypeMode(false); setCustomTypeName(""); }}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Domain row */}
      <div className="flex items-center gap-3">
        <Globe className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <span className="text-sm text-muted-foreground">Dominio:</span>
        <Input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="myfunnel.com"
          className="max-w-[220px] h-8 text-sm"
        />
        <Button size="sm" variant="outline" onClick={autoNameSteps} className="gap-1.5 text-amber-600 border-amber-300 hover:bg-amber-50">
          <Wand2 className="w-3.5 h-3.5" />
          Auto-Name Steps
        </Button>
      </div>

      {/* Empty state */}
      {localSteps.length === 0 && (
        <div className="py-16 text-center border-2 border-dashed border-border rounded-xl">
          <Zap className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-medium text-foreground mb-1">Nessun step ancora</p>
          <p className="text-xs text-muted-foreground mb-4">Aggiungi il primo step del tuo funnel</p>
          <Button onClick={() => addStep()} size="sm" className="bg-primary text-primary-foreground gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Aggiungi Step
          </Button>
        </div>
      )}

      {/* Table */}
      {localSteps.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-xs border-collapse min-w-[1400px]">
            <thead>
              <tr className="bg-muted/60 border-b border-border">
                {["#", "Pagina", "Tipo", "URL", "Target", "Angolo", "Prompt / Note", "Auto-gen", "Fidelity", "Prodotto", "Status", "Risultato", "Feedback", "Azioni"].map(h => (
                  <th key={h} className="text-left px-3 py-2 font-semibold text-muted-foreground text-[10px] uppercase tracking-wider whitespace-nowrap border-r border-border/50 last:border-r-0">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {localSteps.map((step, idx) => {
                const swiping = swipingSteps.has(step.id);
                const progress = swipeProgress[step.id];
                const rowBg = idx % 2 === 0 ? "bg-card" : "bg-muted/20";

                return (
                  <tr key={step.id} className={`${rowBg} border-b border-border/50 last:border-b-0 hover:bg-primary/5 transition-colors group`}>
                    {/* # */}
                    <td className="px-3 py-2 border-r border-border/50 text-center">
                      <span className="w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-mono font-bold text-muted-foreground mx-auto">
                        {step.step_number}
                      </span>
                    </td>

                    {/* Page name */}
                    <td className="px-2 py-1 border-r border-border/50 min-w-[140px] max-w-[180px]">
                      <InlineEdit value={step.page_name} onChange={v => patchStep(step.id, { page_name: v })} placeholder="Nome pagina" />
                    </td>

                    {/* Type */}
                    <td className="px-2 py-1 border-r border-border/50 min-w-[130px]">
                      <Select value={step.step_type} onValueChange={v => patchStep(step.id, { step_type: v })}>
                        <SelectTrigger className="h-6 text-[11px] border-0 bg-transparent hover:bg-muted/40 px-1 py-0 focus:ring-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STEP_TYPES.map(t => <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>

                    {/* URL / HTML */}
                    <td className="px-2 py-1 border-r border-border/50 min-w-[180px] max-w-[220px]">
                      <UrlOrHtmlCell
                        step={step}
                        projectId={projectId}
                        onPatch={patch => patchStep(step.id, patch)}
                        onStepUpdate={updated => setLocalSteps(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s))}
                      />
                    </td>

                    {/* Target */}
                    <td className="px-2 py-1 border-r border-border/50 min-w-[120px] max-w-[150px]">
                      <InlineEdit value={step.target} onChange={v => patchStep(step.id, { target: v })} placeholder="Target…" />
                    </td>

                    {/* Angle */}
                    <td className="px-2 py-1 border-r border-border/50 min-w-[120px] max-w-[150px]">
                      <InlineEdit value={step.angle} onChange={v => patchStep(step.id, { angle: v })} placeholder="Angolo…" />
                    </td>

                    {/* Prompt/Notes */}
                    <td className="px-2 py-1 border-r border-border/50 min-w-[140px] max-w-[180px]">
                      <InlineEdit value={step.prompt_notes} onChange={v => patchStep(step.id, { prompt_notes: v })} placeholder="Note AI…" multiline />
                    </td>

                    {/* Auto-gen */}
                    <td className="px-2 py-1 border-r border-border/50 text-center min-w-[60px]">
                      <Toggle value={step.auto_gen === "true"} onChange={v => patchStep(step.id, { auto_gen: String(v) })} label="Auto" />
                    </td>

                    {/* Fidelity */}
                    <td className="px-2 py-1 border-r border-border/50 text-center min-w-[60px]">
                      <Toggle value={step.fidelity_mode === "true"} onChange={v => patchStep(step.id, { fidelity_mode: String(v) })} label="Fidelity" />
                    </td>

                    {/* Product */}
                    <td className="px-2 py-1 border-r border-border/50 min-w-[100px] max-w-[130px]">
                      <InlineEdit value={step.product} onChange={v => patchStep(step.id, { product: v })} placeholder="Prodotto…" />
                    </td>

                    {/* Status */}
                    <td className="px-2 py-1 border-r border-border/50 text-center min-w-[90px]">
                      {swiping && progress ? (
                        <div className="flex items-center gap-1">
                          <RefreshCw className="w-3 h-3 text-amber-500 animate-spin flex-shrink-0" />
                          <span className="text-[9px] text-amber-600 truncate max-w-[60px]">Generating…</span>
                        </div>
                      ) : statusBadge(step.status)}
                    </td>

                    {/* Result */}
                    <td className="px-2 py-1 border-r border-border/50 text-center min-w-[80px]">
                      {step.result_content ? (
                        <button
                          onClick={() => setResultStep(step)}
                          className="text-[10px] text-primary hover:underline flex items-center gap-1 mx-auto"
                        >
                          <Eye className="w-3 h-3" />
                          Vedi
                        </button>
                      ) : (
                        <span className="text-muted-foreground text-[10px]">—</span>
                      )}
                    </td>

                    {/* Feedback */}
                    <td className="px-2 py-1 border-r border-border/50 min-w-[120px] max-w-[160px]">
                      <InlineEdit value={step.feedback} onChange={v => patchStep(step.id, { feedback: v })} placeholder="Feedback…" />
                    </td>

                    {/* Actions */}
                    <td className="px-2 py-1 min-w-[140px]">
                      <div className="flex items-center gap-1">
                        {/* SWIPE */}
                        <button
                          onClick={() => triggerSwipe(step)}
                          disabled={swiping}
                          title="Genera con AI (SWIPE)"
                          className={`flex items-center gap-0.5 px-2 py-1 rounded text-[10px] font-semibold transition-colors ${
                            swiping
                              ? "bg-amber-200 text-amber-700 cursor-not-allowed"
                              : "bg-amber-400 hover:bg-amber-500 text-black"
                          }`}
                        >
                          {swiping ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                          SWIPE
                        </button>

                        {/* Chat */}
                        <button
                          onClick={() => setChatStep(step)}
                          title="AI Chat Editor"
                          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <MessageSquare className="w-3.5 h-3.5" />
                        </button>

                        {/* Duplicate */}
                        <button
                          onClick={() => duplicateStep(step)}
                          title="Duplica step"
                          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>

                        {/* Delete */}
                        <button
                          onClick={() => deleteStep.mutate({ projectId, stepId: step.id })}
                          title="Elimina step"
                          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Result Modal */}
      {resultStep && <ResultModal step={resultStep} onClose={() => setResultStep(null)} />}

      {/* Chat Panel */}
      {chatStep && (
        <ChatPanel step={chatStep} projectId={projectId} onClose={() => setChatStep(null)} />
      )}

      {/* Import Library Dialog */}
      <FunnelLibraryDialog
        open={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        currentProjectId={projectId}
        onImported={() => {
          queryClient.invalidateQueries({ queryKey: getListFunnelStepsQueryKey(projectId) });
        }}
      />
    </div>
  );
}
