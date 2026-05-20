import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Trash2, Upload, Zap, RefreshCw,
  CheckCircle, X, LayoutGrid, Play, Globe,
  ChevronDown, ExternalLink, Palette, Search, ArrowUpDown,
  Bookmark, Calendar, SlidersHorizontal, BookmarkCheck,
  Repeat2, Eye, Layers, Sparkles, Copy, Filter,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { getUploadUrl } from "@/lib/projecthub-storage";

const BASE_URL = "";

type CreativeTemplate = {
  id: number; project_id: string; name: string; source_brand: string;
  category: string; file_path: string; media_type: string; tags: string; created_at: string;
};
type CompetitorBrand = {
  id: number; project_id: string; name: string; ads_library_url: string;
  scrape_count: number; frequency: string; brand_type: string; notes: string;
  creative_quality_notes: string; is_active: string; created_at: string;
};
type AutomationJob = {
  id: number; project_id: string; brand_id: number | null; mode: string;
  frequency: string; media_type: string; ads_count: number; iterations_per_ad: number;
  status: string; created_at: string;
};
type CreativeOutput = {
  id: number; project_id: string; type: string; angle: string;
  concept_notes: string; output_status: string; feedback: string; created_at: string;
};
type CompetitorAdWithBrand = {
  id: number; brand_id: number; brand_name: string; headline: string;
  hook: string; body_text: string; file_path: string; media_type: string; created_at: string;
};
type CreativeIteration = {
  id: number; project_id: string; competitor_ad_id: number | null;
  brand_name: string; competitor_headline: string; competitor_hook: string;
  competitor_body: string; competitor_gradient: string;
  iteration_headline: string; iteration_hook: string; iteration_body: string;
  angle_notes: string; elements_json: string; analysis: string; created_at: string;
};
type CreativeSwipe = {
  id: number; project_id: string; competitor_ad_id: number | null; brand_id: number | null;
  brand_name: string; competitor_headline: string; competitor_hook: string;
  competitor_body: string; competitor_gradient: string;
  swipe_headline: string; swipe_hook: string; swipe_body: string;
  swipe_notes: string; elements_json: string; analysis: string; created_at: string;
};
type CreativeAngle = {
  id: number; project_id: string; angle_name: string; rationale: string;
  competitor_insights: string; our_ads_insights: string; market_insights: string;
  ad_style: string; target: string; hook_angle: string; created_at: string;
};
type CreativeGenerated = {
  id: number; project_id: string; angle_id: number | null; angle_name: string;
  headline: string; hook: string; body: string; ad_style: string; target: string;
  format: string; gradient_idx: string; status: string; generation_notes: string; created_at: string;
};

const ITER_GRADIENTS = [
  { bg: "from-violet-600 to-purple-700", light: "from-violet-100 to-purple-100", accent: "#7c3aed" },
  { bg: "from-rose-500 to-pink-600", light: "from-rose-100 to-pink-100", accent: "#e11d48" },
  { bg: "from-amber-500 to-orange-600", light: "from-amber-100 to-orange-100", accent: "#d97706" },
  { bg: "from-emerald-500 to-teal-600", light: "from-emerald-100 to-teal-100", accent: "#059669" },
  { bg: "from-blue-500 to-indigo-600", light: "from-blue-100 to-indigo-100", accent: "#2563eb" },
  { bg: "from-fuchsia-500 to-pink-500", light: "from-fuchsia-100 to-pink-100", accent: "#c026d3" },
  { bg: "from-cyan-500 to-sky-600", light: "from-cyan-100 to-sky-100", accent: "#0891b2" },
  { bg: "from-red-500 to-orange-500", light: "from-red-100 to-orange-100", accent: "#dc2626" },
  { bg: "from-indigo-500 to-violet-600", light: "from-indigo-100 to-violet-100", accent: "#4338ca" },
  { bg: "from-green-500 to-emerald-600", light: "from-green-100 to-emerald-100", accent: "#16a34a" },
];

function getGradient(index: number) { return ITER_GRADIENTS[index % ITER_GRADIENTS.length]; }

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" });
}

// ─── TAB 1: TEMPLATE SALVATI ───
function TemplateSalvati({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [templates, setTemplates] = useState<CreativeTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({ name: "", source_brand: "", category: "", tags: "" });
  const [fileLabel, setFileLabel] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/templates`);
      if (r.ok) setTemplates(await r.json());
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [projectId]);

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) { toast({ title: "Seleziona un file", variant: "destructive" }); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      Object.entries(form).forEach(([k, v]) => fd.append(k, v));
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/templates`, { method: "POST", body: fd });
      if (r.ok) {
        const t = await r.json(); setTemplates(prev => [...prev, t]);
        setUploadOpen(false); setForm({ name: "", source_brand: "", category: "", tags: "" }); setFileLabel("");
        toast({ title: "Template salvato!" });
      }
    } catch { toast({ title: "Errore upload", variant: "destructive" }); } finally { setUploading(false); }
  };

  const del = async (id: number) => {
    setTemplates(prev => prev.filter(t => t.id !== id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/templates/${id}`, { method: "DELETE" });
    toast({ title: "Template eliminato" });
  };

  const delSelected = async () => {
    const ids = Array.from(selected);
    setTemplates(prev => prev.filter(t => !selected.has(t.id)));
    setSelected(new Set()); setSelectionMode(false);
    await Promise.all(ids.map(id => fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/templates/${id}`, { method: "DELETE" })));
    toast({ title: `${ids.length} template eliminati` });
  };

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const allFiltered = templates
    .filter(t => filter === "all" || t.media_type === filter)
    .filter(t => !search || t.name.toLowerCase().includes(search.toLowerCase()) || (t.source_brand || "").toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sort === "newest"
      ? new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      : new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

  const allSelected = allFiltered.length > 0 && allFiltered.every(t => selected.has(t.id));

  const toggleAll = () => {
    if (allSelected) { setSelected(new Set()); }
    else { setSelected(new Set(allFiltered.map(t => t.id))); }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold text-foreground">I miei template</h3>
          <p className="text-xs text-muted-foreground">{templates.length} template salvati</p>
        </div>
        <Button onClick={() => setUploadOpen(true)} className="bg-primary text-white gap-1.5 text-sm">
          <Upload className="w-4 h-4" /> Carica un template
        </Button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca template..." className="pl-8 h-8 text-sm" />
        </div>

        {/* Filter */}
        <div className="flex items-center gap-1 border border-border rounded-lg p-0.5 bg-muted/30">
          {(["all", "image", "video"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${f === filter ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {f === "all" ? "Tutti" : f === "image" ? "Immagini" : "Video"}
            </button>
          ))}
        </div>

        {/* Sort */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded-lg bg-background hover:bg-muted transition-colors font-medium">
              <ArrowUpDown className="w-3 h-3" />
              {sort === "newest" ? "Più recenti" : "Più vecchi"}
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="text-sm">
            <DropdownMenuItem onClick={() => setSort("newest")}>Più recenti</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSort("oldest")}>Più vecchi</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Selection toggle */}
        <button onClick={() => { setSelectionMode(v => !v); setSelected(new Set()); }}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded-lg font-medium transition-colors ${selectionMode ? "border-primary text-primary bg-primary/5" : "border-border bg-background hover:bg-muted"}`}>
          <SlidersHorizontal className="w-3 h-3" /> Seleziona
        </button>
      </div>

      {/* Selection bar */}
      {selectionMode && (
        <div className="flex items-center gap-3 bg-muted/40 border border-border rounded-lg px-4 py-2">
          <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-foreground">
            <input type="checkbox" checked={allSelected} onChange={toggleAll}
              className="w-4 h-4 rounded accent-primary" />
            {allSelected ? "Deseleziona tutti" : "Seleziona tutti"}
          </label>
          {selected.size > 0 && (
            <>
              <span className="text-xs text-muted-foreground">{selected.size} selezionati</span>
              <button onClick={delSelected}
                className="ml-auto flex items-center gap-1.5 text-xs text-destructive hover:bg-destructive/10 px-3 py-1.5 rounded-lg transition-colors font-medium border border-destructive/30">
                <Trash2 className="w-3 h-3" /> Elimina selezionati
              </button>
            </>
          )}
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Caricamento...</div>
      ) : allFiltered.length === 0 ? (
        <div className="py-20 text-center border-2 border-dashed border-border rounded-2xl">
          <BookmarkCheck className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-semibold text-foreground mb-1">
            {search ? "Nessun risultato" : "Nessun template salvato"}
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            {search ? "Prova con un'altra ricerca." : "Carica le tue migliori creative o salvale dai competitor."}
          </p>
          {!search && (
            <Button size="sm" onClick={() => setUploadOpen(true)} className="bg-primary text-white gap-1.5">
              <Upload className="w-3.5 h-3.5" /> Carica un template
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
          {allFiltered.map(t => {
            const isSelected = selected.has(t.id);
            const isCompetitor = !!t.source_brand;
            return (
              <div key={t.id}
                onClick={() => selectionMode && toggleSelect(t.id)}
                className={`group relative rounded-xl overflow-hidden bg-card border transition-all duration-200 cursor-pointer
                  ${selectionMode ? "cursor-pointer" : ""}
                  ${isSelected ? "border-primary ring-2 ring-primary/30 shadow-md" : "border-border hover:border-primary/40 hover:shadow-lg"}`}>

                {/* Thumbnail */}
                <div className="aspect-[4/5] bg-muted relative overflow-hidden">
                  {t.media_type === "image" && t.file_path ? (
                    <img src={getUploadUrl(t.file_path)} alt={t.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  ) : t.media_type === "video" ? (
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900">
                      <Play className="w-10 h-10 text-white/70" />
                    </div>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-muted/60">
                      <BookmarkCheck className="w-8 h-8 text-muted-foreground/40" />
                    </div>
                  )}

                  {/* Da Competitor badge */}
                  {isCompetitor && (
                    <div className="absolute top-2 left-2">
                      <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-sky-500 text-white tracking-wide shadow">
                        Da Competitor
                      </span>
                    </div>
                  )}

                  {/* Checkbox (selection mode or hover) */}
                  {(selectionMode || isSelected) && (
                    <div className="absolute top-2 right-2">
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? "bg-primary border-primary" : "bg-white/80 border-white"}`}>
                        {isSelected && <CheckCircle className="w-3.5 h-3.5 text-white fill-white" />}
                      </div>
                    </div>
                  )}

                  {/* Hover overlay (only when NOT in selection mode) */}
                  {!selectionMode && (
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2">
                      <button
                        onClick={e => { e.stopPropagation(); toast({ title: "Funzione in arrivo", description: "Usa template per swipe/iterazione" }); }}
                        className="flex items-center gap-1.5 bg-white text-black text-xs font-bold px-4 py-2 rounded-full hover:bg-primary hover:text-white transition-colors shadow-lg">
                        <Bookmark className="w-3.5 h-3.5" /> Usa template
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); del(t.id); }}
                        className="flex items-center gap-1 text-white/70 hover:text-red-400 text-[10px] transition-colors">
                        <Trash2 className="w-3 h-3" /> Elimina
                      </button>
                    </div>
                  )}
                </div>

                {/* Card footer */}
                <div className="p-2.5 space-y-0.5">
                  <p className="text-xs font-semibold text-foreground truncate leading-tight">
                    {t.source_brand ? `Template da ${t.source_brand}` : t.name}
                  </p>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-0.5">
                      <Calendar className="w-2.5 h-2.5" /> {formatDate(t.created_at)}
                    </span>
                    {t.category && (
                      <span className="text-[9px] px-1.5 py-0.5 bg-muted rounded-full">{t.category}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Upload Dialog */}
      <Dialog open={uploadOpen} onOpenChange={v => { setUploadOpen(v); if (!v) { setFileLabel(""); setForm({ name: "", source_brand: "", category: "", tags: "" }); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Salva Template Creative</DialogTitle></DialogHeader>
          <form onSubmit={upload} className="space-y-4 mt-2">
            <div className="border-2 border-dashed border-border rounded-xl p-5 text-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors"
              onClick={() => fileRef.current?.click()}>
              <Upload className="w-7 h-7 text-muted-foreground mx-auto mb-2" />
              <p className="text-xs text-muted-foreground font-medium">{fileLabel || "Clicca per selezionare (immagine o video)"}</p>
              <input ref={fileRef} type="file" accept="image/*,video/*" className="hidden" onChange={() => {
                const f = fileRef.current?.files?.[0];
                if (f) { setFileLabel(f.name); if (!form.name) setForm(prev => ({ ...prev, name: f.name.replace(/\.[^.]+$/, "") })); }
              }} />
            </div>
            {[
              { label: "Nome *", key: "name", placeholder: "Es. Prima/Dopo UGC" },
              { label: "Brand Sorgente (Competitor)", key: "source_brand", placeholder: "Es. bioma.health, ProDentim…" },
              { label: "Categoria", key: "category", placeholder: "Es. UGC, Testimonial, Demo..." },
              { label: "Tag", key: "tags", placeholder: "Es. before-after, urgency..." },
            ].map(({ label, key, placeholder }) => (
              <div key={key} className="space-y-1">
                <label className="text-xs font-medium text-foreground">{label}</label>
                <Input value={form[key as keyof typeof form]} onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))} placeholder={placeholder} className="text-sm" />
              </div>
            ))}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setUploadOpen(false)}>Annulla</Button>
              <Button type="submit" disabled={uploading} className="bg-primary text-white gap-1.5">
                {uploading ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Caricamento...</> : <><Bookmark className="w-3.5 h-3.5" /> Salva Template</>}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── ITERAZIONE POPUP (confronto originale vs iterata) ───
function IterationPopup({ iteration, onClose }: { iteration: CreativeIteration; onClose: () => void }) {
  const adIdx = Number(iteration.competitor_gradient ?? 0);
  const gComp = getGradient(adIdx);
  const gIter = getGradient(adIdx + 3);
  const elements: string[] = (() => { try { return JSON.parse(iteration.elements_json); } catch { return []; } })();

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-4xl p-0 overflow-hidden gap-0">
        {/* Split-screen */}
        <div className="grid grid-cols-2" style={{ minHeight: 380 }}>
          {/* LEFT — Originale */}
          <div className="relative bg-slate-800 flex flex-col items-center justify-center p-6 overflow-hidden">
            <div className="absolute inset-0 opacity-20 bg-gradient-to-br from-slate-700 to-slate-900" />
            <div className="absolute top-3 left-3 z-10">
              <span className="text-[10px] font-bold px-3 py-1 bg-white/20 text-white rounded-full backdrop-blur-sm border border-white/30">
                Ad Originale
              </span>
            </div>
            <div className={`relative z-10 w-36 h-48 rounded-2xl bg-gradient-to-br ${gComp.bg} shadow-2xl flex flex-col items-start justify-end p-4 overflow-hidden`}>
              <div className="absolute inset-0 opacity-10 bg-white rounded-2xl" />
              <p className="text-white font-bold text-sm leading-tight mb-1 relative z-10">{iteration.competitor_headline}</p>
              <p className="text-white/80 text-[11px] leading-tight relative z-10">{iteration.competitor_hook}</p>
            </div>
          </div>

          {/* RIGHT — Iterata */}
          <div className={`relative bg-gradient-to-br ${gIter.light} flex flex-col items-center justify-center p-6 overflow-hidden`}>
            <div className="absolute top-3 left-3 z-10">
              <span className="text-[10px] font-bold px-3 py-1 rounded-full flex items-center gap-1.5 border border-white/60 bg-white/60 backdrop-blur-sm"
                style={{ color: gIter.accent }}>
                <Sparkles className="w-3 h-3" /> Iterata
              </span>
            </div>
            <div className={`relative z-10 w-36 h-48 rounded-2xl bg-gradient-to-br ${gIter.bg} shadow-2xl flex flex-col items-start justify-end p-4 overflow-hidden`}>
              <div className="absolute inset-0 opacity-10 bg-white rounded-2xl" />
              <p className="text-white font-bold text-sm leading-tight mb-1 relative z-10">{iteration.iteration_headline}</p>
              <p className="text-white/80 text-[11px] leading-tight relative z-10">{iteration.iteration_hook}</p>
            </div>
          </div>
        </div>

        {/* Bottom panel */}
        <div className="bg-background border-t border-border p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-sky-100 text-sky-700 rounded-full">{iteration.brand_name}</span>
                {iteration.angle_notes && <span className="text-[10px] text-muted-foreground italic">{iteration.angle_notes}</span>}
              </div>
              <p className="text-sm font-bold text-foreground mb-0.5">{iteration.iteration_headline}</p>
              <p className="text-xs text-muted-foreground">{iteration.iteration_hook}</p>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <Button size="sm" className="h-8 text-xs bg-amber-500 hover:bg-amber-600 text-black font-bold gap-1.5">
                <Zap className="w-3.5 h-3.5" /> Genera altre
              </Button>
              <button onClick={onClose} className="p-2 rounded-lg hover:bg-muted transition-colors">
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          </div>

          {/* Copy blocks */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-muted/30 border border-border rounded-lg p-3">
              <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Ad Originale</p>
              <div className="space-y-1.5">
                <div><span className="text-[10px] font-semibold text-foreground">Headline: </span><span className="text-[10px] text-muted-foreground">{iteration.competitor_headline}</span></div>
                <div><span className="text-[10px] font-semibold text-foreground">Hook: </span><span className="text-[10px] text-muted-foreground">{iteration.competitor_hook}</span></div>
                {iteration.competitor_body && <div><span className="text-[10px] font-semibold text-foreground">Body: </span><span className="text-[10px] text-muted-foreground">{iteration.competitor_body}</span></div>}
              </div>
            </div>
            <div className="border rounded-lg p-3" style={{ borderColor: `${gIter.accent}40`, backgroundColor: `${gIter.accent}08` }}>
              <p className="text-[9px] font-bold uppercase tracking-wider mb-2" style={{ color: gIter.accent }}>Iterazione</p>
              <div className="space-y-1.5">
                <div><span className="text-[10px] font-semibold text-foreground">Headline: </span><span className="text-[10px] text-foreground">{iteration.iteration_headline}</span></div>
                <div><span className="text-[10px] font-semibold text-foreground">Hook: </span><span className="text-[10px] text-foreground">{iteration.iteration_hook}</span></div>
                {iteration.iteration_body && <div><span className="text-[10px] font-semibold text-foreground">Body: </span><span className="text-[10px] text-foreground">{iteration.iteration_body}</span></div>}
              </div>
            </div>
          </div>

          {/* Elements iterated */}
          {elements.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Elementi Iterati</p>
              <div className="flex flex-wrap gap-1.5">
                {elements.map((el, i) => (
                  <span key={i} className="text-[10px] font-medium px-2 py-0.5 rounded-full border"
                    style={{ borderColor: `${gIter.accent}50`, color: gIter.accent, backgroundColor: `${gIter.accent}10` }}>
                    {el}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Analysis */}
          {iteration.analysis && (
            <div className="bg-violet-50 border border-violet-200 rounded-xl p-3">
              <p className="text-[10px] font-bold text-violet-700 uppercase tracking-wider mb-1 flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> Analisi Iterazione
              </p>
              <p className="text-xs text-violet-900 leading-relaxed">{iteration.analysis}</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── TAB 2: ITERAZIONE ───
type IterPeriod = "today" | "yesterday" | "week" | "month" | "custom";

function Iterazione({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  // Competitor ads (top box)
  const [competitorAds, setCompetitorAds] = useState<CompetitorAdWithBrand[]>([]);
  const [loadingAds, setLoadingAds] = useState(true);
  const [selectedAd, setSelectedAd] = useState<CompetitorAdWithBrand | null>(null);
  // Generation
  const [angleNotes, setAngleNotes] = useState("");
  const [iterCount, setIterCount] = useState(3);
  const [generating, setGenerating] = useState(false);
  const [streamText, setStreamText] = useState("");
  // Iterations (bottom box)
  const [period, setPeriod] = useState<IterPeriod>("today");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [iterations, setIterations] = useState<CreativeIteration[]>([]);
  const [loadingIters, setLoadingIters] = useState(true);
  const [previewIter, setPreviewIter] = useState<CreativeIteration | null>(null);

  const loadAds = async () => {
    setLoadingAds(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/competitor-ads`);
      if (r.ok) setCompetitorAds(await r.json());
    } finally { setLoadingAds(false); }
  };

  const loadIterations = async (p: IterPeriod = period, cs = customStart, ce = customEnd) => {
    setLoadingIters(true);
    try {
      let url = `${BASE_URL}/api/projecthub/projects/${projectId}/creative/iterations?period=${p}`;
      if (p === "custom") url += `&start=${cs}&end=${ce}`;
      const r = await fetch(url);
      if (r.ok) setIterations(await r.json());
    } finally { setLoadingIters(false); }
  };

  useEffect(() => { loadAds(); loadIterations(); }, [projectId]);

  const changePeriod = (p: IterPeriod) => { setPeriod(p); if (p !== "custom") loadIterations(p); };

  const saveIteration = async (iterData: Omit<CreativeIteration, "id" | "project_id">) => {
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/iterations`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(iterData),
      });
      if (r.ok) { const saved = await r.json(); setIterations(prev => [saved, ...prev]); }
    } catch { /* ignore */ }
  };

  const deleteIteration = async (id: number) => {
    setIterations(prev => prev.filter(i => i.id !== id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/iterations/${id}`, { method: "DELETE" });
    toast({ title: "Iterazione eliminata" });
  };

  const generate = async () => {
    if (!selectedAd) { toast({ title: "Seleziona prima un'ad competitor", variant: "destructive" }); return; }
    setGenerating(true); setStreamText("");
    let full = "";
    try {
      const refDesc = `Headline: "${selectedAd.headline}". Hook: "${selectedAd.hook}". ${selectedAd.body_text ? `Body: "${selectedAd.body_text}".` : ""} Brand: ${selectedAd.brand_name}.`;
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/iterazione`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference_description: refDesc, angle_notes: angleNotes, iterations_per_ad: iterCount }),
      });
      if (!r.body) throw new Error();
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const d = JSON.parse(line.slice(5).trim());
            if (d.content) { full += d.content; setStreamText(full); }
            if (d.done) {
              toast({ title: `${iterCount} iterazioni generate!`, description: "Salvate nella sezione sotto." });
              // Parse and save each iteration
              const blocks = full.split(/(?:═══|---|\*\*\*|ITERAZIONE\s*\d+|Creative\s*\d+:)/i)
                .map(b => b.trim()).filter(b => b.length > 30);
              for (let i = 0; i < Math.min(blocks.length, iterCount); i++) {
                const block = blocks[i];
                const hlMatch = block.match(/(?:Headline|headline)[:\s]*["»]?([^"\n]+)["»]?/i);
                const hookMatch = block.match(/(?:Hook|hook)[:\s]*["»]?([^"\n]+)["»]?/i);
                const bodyMatch = block.match(/(?:Body|body|copy)[:\s]*["»]?([^"\n]{10,})["»]?/i);
                const elemMatch = block.match(/(?:Elementi|Elements|Angle)[:\s]*(.+)/i);
                const analysisMatch = block.match(/(?:Analisi|Analysis|Perché|Why)[:\s]*(.{20,})/i);
                await saveIteration({
                  competitor_ad_id: selectedAd.id,
                  brand_name: selectedAd.brand_name,
                  competitor_headline: selectedAd.headline,
                  competitor_hook: selectedAd.hook,
                  competitor_body: selectedAd.body_text,
                  competitor_gradient: String(selectedAd.id % ITER_GRADIENTS.length),
                  iteration_headline: hlMatch?.[1]?.trim() ?? `Iterazione ${i + 1} di ${selectedAd.headline}`,
                  iteration_hook: hookMatch?.[1]?.trim() ?? `Nuovo angolo per ${selectedAd.brand_name}`,
                  iteration_body: bodyMatch?.[1]?.trim() ?? "",
                  angle_notes: angleNotes,
                  elements_json: JSON.stringify(elemMatch?.[1]?.split(/[,;]/).map(s => s.trim()).filter(Boolean) ?? ["Headline", "Hook", "Angolo"]),
                  analysis: analysisMatch?.[1]?.trim() ?? block.slice(0, 200),
                  created_at: new Date().toISOString(),
                });
              }
              loadIterations();
            }
            if (d.error) toast({ title: "Errore", variant: "destructive" });
          } catch { /* ignore */ }
        }
      }
    } catch { toast({ title: "Errore generazione", variant: "destructive" }); } finally { setGenerating(false); }
  };

  const PERIOD_LABELS: Record<IterPeriod, string> = {
    today: "Oggi", yesterday: "Ieri", week: "Settimana scorsa",
    month: "Mese corrente", custom: "Personalizzata",
  };

  return (
    <div className="space-y-5">
      {/* ── TOP BOX: Competitor Ads ── */}
      <div className="border border-border rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-muted/20">
          <div>
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <Layers className="w-4 h-4 text-sky-500" /> Ads Competitor in Esame
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">Seleziona un'ad per avviare l'iterazione AI</p>
          </div>
          {selectedAd && (
            <button onClick={() => setSelectedAd(null)} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
              <X className="w-3 h-3" /> Deseleziona
            </button>
          )}
        </div>

        <div className="p-4">
          {loadingAds ? (
            <div className="py-12 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" /> Caricamento ads...
            </div>
          ) : competitorAds.length === 0 ? (
            <div className="py-12 text-center">
              <Globe className="w-10 h-10 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">Nessuna ad competitor. Aggiungile dalla <strong>Competitor Library</strong>.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
              {competitorAds.map(ad => {
                const g = getGradient(ad.id);
                const isSelected = selectedAd?.id === ad.id;
                return (
                  <div key={ad.id} onClick={() => setSelectedAd(isSelected ? null : ad)}
                    className={`group relative rounded-xl overflow-hidden cursor-pointer transition-all duration-200 border-2
                      ${isSelected
                        ? "border-primary shadow-lg shadow-primary/20 scale-[0.98]"
                        : "border-transparent hover:border-primary/30 hover:shadow-md"}`}>
                    <div className={`aspect-[4/5] bg-gradient-to-br ${g.bg} flex flex-col items-start justify-end p-3 relative`}>
                      {/* Brand badge */}
                      <div className="absolute top-2 left-2">
                        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-white/25 text-white backdrop-blur-sm">
                          {ad.brand_name}
                        </span>
                      </div>
                      {/* Selection check */}
                      {isSelected && (
                        <div className="absolute top-2 right-2 w-5 h-5 bg-primary rounded-full flex items-center justify-center shadow">
                          <CheckCircle className="w-3.5 h-3.5 text-white fill-white" />
                        </div>
                      )}
                      {/* Hover overlay */}
                      <div className={`absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity ${isSelected ? "opacity-0" : "opacity-0 group-hover:opacity-100"}`}>
                        <span className="text-[10px] font-bold text-white bg-white/20 px-2 py-1 rounded-full backdrop-blur-sm">
                          Seleziona
                        </span>
                      </div>
                      {/* Text */}
                      <p className="text-white font-bold text-xs leading-tight mb-0.5 relative z-10 line-clamp-2">{ad.headline}</p>
                      <p className="text-white/75 text-[10px] leading-tight relative z-10 line-clamp-1">{ad.hook}</p>
                    </div>
                    <div className="bg-card border-t border-white/10 px-2.5 py-1.5">
                      <p className="text-[10px] text-muted-foreground truncate">{ad.brand_name}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Generation panel — shows when ad is selected */}
        {selectedAd && (
          <div className="border-t border-primary/20 bg-primary/5 px-5 py-4">
            <div className="flex items-start gap-4 flex-wrap">
              <div className="flex-1 min-w-48 space-y-1">
                <label className="text-xs font-medium text-foreground">Angolo da preservare (opzionale)</label>
                <Input value={angleNotes} onChange={e => setAngleNotes(e.target.value)}
                  placeholder="Es. Mantieni hook urgente, adatta al nostro prodotto" className="text-xs h-8" disabled={generating} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">N° iterazioni</label>
                <div className="flex gap-1.5">
                  {[1, 3, 5].map(n => (
                    <button key={n} onClick={() => setIterCount(n)}
                      className={`w-9 h-8 rounded-lg text-sm font-bold transition-colors ${n === iterCount ? "bg-primary text-white" : "bg-background border border-border text-muted-foreground hover:border-primary"}`}>
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <Button onClick={generate} disabled={generating} className="bg-amber-500 hover:bg-amber-600 text-black font-bold gap-1.5 h-9 self-end">
                {generating
                  ? <><RefreshCw className="w-4 h-4 animate-spin" /> Generando...</>
                  : <><Zap className="w-4 h-4" /> Genera {iterCount} Iterazioni</>}
              </Button>
            </div>
            {/* Ad sorgente preview */}
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">Ad sorgente:</span>
              <span className="text-sky-600 font-medium">{selectedAd.brand_name}</span>
              <span>—</span>
              <span className="italic">{selectedAd.headline}</span>
            </div>

            {/* Streaming output */}
            {(generating || streamText) && (
              <div className="mt-3 bg-muted/30 border border-border rounded-lg p-3 max-h-40 overflow-y-auto">
                <pre className="text-[10px] text-foreground whitespace-pre-wrap font-sans leading-relaxed">{streamText}</pre>
                {generating && <span className="inline-block w-1 h-3 bg-amber-500 animate-pulse ml-0.5 align-middle" />}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── BOTTOM BOX: Iterazioni salvate ── */}
      <div className="border border-border rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-muted/20 flex-wrap gap-3">
          <div>
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <Repeat2 className="w-4 h-4 text-amber-500" /> Iterazioni
              {iterations.length > 0 && <span className="text-[10px] font-bold px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full">{iterations.length}</span>}
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">Clicca su un'iterazione per vedere il confronto con l'originale</p>
          </div>
          {/* Period filter */}
          <div className="flex items-center gap-1 flex-wrap">
            {(["today", "yesterday", "week", "month", "custom"] as IterPeriod[]).map(p => (
              <button key={p} onClick={() => changePeriod(p)}
                className={`text-[11px] font-medium px-3 py-1.5 rounded-lg transition-colors border ${period === p
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"}`}>
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        {/* Custom date picker */}
        {period === "custom" && (
          <div className="px-5 py-3 border-b border-border bg-muted/10 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-foreground">Dal</label>
              <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)}
                className="text-xs border border-border rounded-lg px-2 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-foreground">Al</label>
              <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)}
                className="text-xs border border-border rounded-lg px-2 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <Button size="sm" onClick={() => loadIterations("custom", customStart, customEnd)}
              className="h-7 text-xs bg-primary text-white gap-1">
              <Filter className="w-3 h-3" /> Filtra
            </Button>
          </div>
        )}

        <div className="p-4">
          {loadingIters ? (
            <div className="py-16 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" /> Caricamento...
            </div>
          ) : iterations.length === 0 ? (
            <div className="py-16 text-center border-2 border-dashed border-border rounded-xl">
              <Repeat2 className="w-10 h-10 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-sm font-semibold text-foreground mb-1">Nessuna iterazione {PERIOD_LABELS[period].toLowerCase()}</p>
              <p className="text-xs text-muted-foreground">Seleziona un'ad competitor e genera le prime iterazioni.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
              {iterations.map((iter) => {
                const g = getGradient(Number(iter.competitor_gradient ?? 0) + 3);
                return (
                  <div key={iter.id} className="group relative rounded-xl overflow-hidden cursor-pointer border border-border hover:border-primary/40 hover:shadow-lg transition-all duration-200"
                    onClick={() => setPreviewIter(iter)}>
                    <div className={`aspect-[4/5] bg-gradient-to-br ${g.bg} flex flex-col items-start justify-end p-3 relative`}>
                      {/* Badges */}
                      <div className="absolute top-2 left-2">
                        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-amber-400 text-amber-900">ITER</span>
                      </div>
                      <div className="absolute top-2 right-2">
                        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-sky-500 text-white">{iter.brand_name.slice(0, 8)}</span>
                      </div>
                      {/* Hover overlay */}
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <span className="text-[11px] font-bold text-white bg-white/20 px-3 py-1.5 rounded-full backdrop-blur-sm flex items-center gap-1.5">
                          <Eye className="w-3.5 h-3.5" /> Confronta
                        </span>
                      </div>
                      {/* Text */}
                      <p className="text-white font-bold text-xs leading-tight mb-0.5 relative z-10 line-clamp-2">{iter.iteration_headline}</p>
                      <p className="text-white/75 text-[10px] leading-tight relative z-10 line-clamp-1">{iter.iteration_hook}</p>
                    </div>
                    <div className="bg-card px-2.5 py-1.5 flex items-center justify-between border-t border-border/50">
                      <p className="text-[10px] text-muted-foreground truncate flex-1">
                        {new Date(iter.created_at).toLocaleDateString("it-IT", { day: "2-digit", month: "short" })}
                      </p>
                      <button onClick={e => { e.stopPropagation(); deleteIteration(iter.id); }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive p-0.5 ml-1">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Popup confronto */}
      {previewIter && <IterationPopup iteration={previewIter} onClose={() => setPreviewIter(null)} />}
    </div>
  );
}

// ─── SWIPE POPUP ───
function SwipePopup({ swipe, onClose }: { swipe: CreativeSwipe; onClose: () => void }) {
  const gComp = getGradient(Number(swipe.competitor_gradient ?? 0));
  const gSwipe = getGradient(Number(swipe.competitor_gradient ?? 0) + 4);
  const elements: string[] = (() => { try { return JSON.parse(swipe.elements_json); } catch { return []; } })();
  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-4xl p-0 overflow-hidden gap-0">
        <div className="grid grid-cols-2" style={{ minHeight: 380 }}>
          {/* LEFT — Originale */}
          <div className="relative bg-slate-800 flex flex-col items-center justify-center p-6 overflow-hidden">
            <div className="absolute inset-0 opacity-10 bg-gradient-to-br from-slate-600 to-slate-900" />
            <div className="absolute top-3 left-3 z-10">
              <span className="text-[10px] font-bold px-3 py-1 bg-white/20 text-white rounded-full backdrop-blur-sm border border-white/30">Ad Originale</span>
            </div>
            <div className={`relative z-10 w-36 h-48 rounded-2xl bg-gradient-to-br ${gComp.bg} shadow-2xl flex flex-col items-start justify-end p-4 overflow-hidden`}>
              <div className="absolute inset-0 opacity-10 bg-white rounded-2xl" />
              <p className="text-white font-bold text-sm leading-tight mb-1 relative z-10 line-clamp-3">{swipe.competitor_headline}</p>
              <p className="text-white/80 text-[11px] leading-tight relative z-10 line-clamp-2">{swipe.competitor_hook}</p>
            </div>
          </div>
          {/* RIGHT — Swiped */}
          <div className={`relative bg-gradient-to-br ${gSwipe.light} flex flex-col items-center justify-center p-6 overflow-hidden`}>
            <div className="absolute top-3 left-3 z-10">
              <span className="text-[10px] font-bold px-3 py-1 rounded-full flex items-center gap-1.5 border border-white/60 bg-white/60 backdrop-blur-sm" style={{ color: gSwipe.accent }}>
                <Sparkles className="w-3 h-3" /> Swiped
              </span>
            </div>
            <div className={`relative z-10 w-36 h-48 rounded-2xl bg-gradient-to-br ${gSwipe.bg} shadow-2xl flex flex-col items-start justify-end p-4 overflow-hidden`}>
              <div className="absolute inset-0 opacity-10 bg-white rounded-2xl" />
              <p className="text-white font-bold text-sm leading-tight mb-1 relative z-10 line-clamp-3">{swipe.swipe_headline}</p>
              <p className="text-white/80 text-[11px] leading-tight relative z-10 line-clamp-2">{swipe.swipe_hook}</p>
            </div>
          </div>
        </div>
        {/* Bottom panel */}
        <div className="bg-background border-t border-border p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-sky-100 text-sky-700 rounded-full">{swipe.brand_name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(swipe.created_at).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <p className="text-sm font-bold text-foreground mb-0.5">{swipe.swipe_headline}</p>
              <p className="text-xs text-muted-foreground">{swipe.swipe_hook}</p>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <Button size="sm" className="h-8 text-xs bg-amber-500 hover:bg-amber-600 text-black font-bold gap-1.5">
                <Zap className="w-3.5 h-3.5" /> Genera 10 Iterazioni
              </Button>
              <button onClick={onClose} className="p-2 rounded-lg hover:bg-muted transition-colors">
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-muted/30 border border-border rounded-lg p-3">
              <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Ad Originale</p>
              <div className="space-y-1.5">
                <div><span className="text-[10px] font-semibold text-foreground">Headline: </span><span className="text-[10px] text-muted-foreground">{swipe.competitor_headline}</span></div>
                <div><span className="text-[10px] font-semibold text-foreground">Hook: </span><span className="text-[10px] text-muted-foreground">{swipe.competitor_hook}</span></div>
                {swipe.competitor_body && <div><span className="text-[10px] font-semibold text-foreground">Body: </span><span className="text-[10px] text-muted-foreground">{swipe.competitor_body}</span></div>}
              </div>
            </div>
            <div className="border rounded-lg p-3" style={{ borderColor: `${gSwipe.accent}40`, backgroundColor: `${gSwipe.accent}08` }}>
              <p className="text-[9px] font-bold uppercase tracking-wider mb-2" style={{ color: gSwipe.accent }}>Swipe</p>
              <div className="space-y-1.5">
                <div><span className="text-[10px] font-semibold text-foreground">Headline: </span><span className="text-[10px] text-foreground">{swipe.swipe_headline}</span></div>
                <div><span className="text-[10px] font-semibold text-foreground">Hook: </span><span className="text-[10px] text-foreground">{swipe.swipe_hook}</span></div>
                {swipe.swipe_body && <div><span className="text-[10px] font-semibold text-foreground">Body: </span><span className="text-[10px] text-foreground">{swipe.swipe_body}</span></div>}
              </div>
            </div>
          </div>
          {elements.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Elementi Swipati</p>
              <div className="flex flex-wrap gap-1.5">
                {elements.map((el, i) => (
                  <span key={i} className="text-[10px] font-medium px-2 py-0.5 rounded-full border"
                    style={{ borderColor: `${gSwipe.accent}50`, color: gSwipe.accent, backgroundColor: `${gSwipe.accent}10` }}>
                    {el}
                  </span>
                ))}
              </div>
            </div>
          )}
          {swipe.analysis && (
            <div className="bg-violet-50 border border-violet-200 rounded-xl p-3">
              <p className="text-[10px] font-bold text-violet-700 uppercase tracking-wider mb-1 flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> Analisi Swipe
              </p>
              <p className="text-xs text-violet-900 leading-relaxed">{swipe.analysis}</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── TAB: SWIPE ───
type SwipePeriod = "today" | "yesterday" | "week" | "month";

function SwipeTab({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [brands, setBrands] = useState<CompetitorBrand[]>([]);
  const [loadingBrands, setLoadingBrands] = useState(true);
  const [expandedBrand, setExpandedBrand] = useState<number | null>(null);
  const [allAds, setAllAds] = useState<CompetitorAdWithBrand[]>([]);
  const [allSwipes, setAllSwipes] = useState<CreativeSwipe[]>([]);
  const [loadingSwipes, setLoadingSwipes] = useState(true);
  const [boardPeriod, setBoardPeriod] = useState<SwipePeriod>("today");
  const [generatingFor, setGeneratingFor] = useState<number | null>(null);
  const [genStream, setGenStream] = useState<Record<number, string>>({});
  const [previewSwipe, setPreviewSwipe] = useState<CreativeSwipe | null>(null);

  const loadAll = async () => {
    setLoadingBrands(true); setLoadingSwipes(true);
    try {
      const [rb, ra, rs] = await Promise.all([
        fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/brands`),
        fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/competitor-ads`),
        fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/swipes`),
      ]);
      if (rb.ok) { const all: CompetitorBrand[] = await rb.json(); setBrands(all.filter(b => b.brand_type === "competitor")); }
      if (ra.ok) setAllAds(await ra.json());
      if (rs.ok) setAllSwipes(await rs.json());
    } finally { setLoadingBrands(false); setLoadingSwipes(false); }
  };

  useEffect(() => { loadAll(); }, [projectId]);

  // Filter helpers
  const adsForBrand = (brandId: number) => allAds.filter(a => a.brand_id === brandId);
  const swipesForBrand = (brandId: number) => allSwipes.filter(s => s.brand_id === brandId);
  const swipeForAd = (adId: number) => allSwipes.find(s => s.competitor_ad_id === adId);

  // Board filter by period
  const now = new Date();
  const boardSwipes = allSwipes.filter(s => {
    const d = new Date(s.created_at);
    if (boardPeriod === "today") return d >= new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (boardPeriod === "yesterday") {
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return d >= new Date(today.getTime() - 86400000) && d < today;
    }
    if (boardPeriod === "week") return d >= new Date(now.getTime() - 7 * 86400000);
    if (boardPeriod === "month") return d >= new Date(now.getFullYear(), now.getMonth(), 1);
    return true;
  });

  const saveSwipe = async (data: Omit<CreativeSwipe, "id" | "project_id">) => {
    const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/swipes`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    if (r.ok) { const saved: CreativeSwipe = await r.json(); setAllSwipes(prev => [saved, ...prev]); return saved; }
    return null;
  };

  const deleteSwipe = async (id: number) => {
    setAllSwipes(prev => prev.filter(s => s.id !== id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/swipes/${id}`, { method: "DELETE" });
    toast({ title: "Swipe eliminata" });
  };

  const generateSwipeForAd = async (ad: CompetitorAdWithBrand) => {
    if (generatingFor !== null) return;
    setGeneratingFor(ad.id);
    setGenStream(prev => ({ ...prev, [ad.id]: "" }));
    let full = "";
    try {
      const refDesc = `Headline: "${ad.headline}". Hook: "${ad.hook}". ${ad.body_text ? `Body: "${ad.body_text}".` : ""} Brand: ${ad.brand_name}.`;
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/swipe-generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference_description: refDesc, swipe_instructions: "Adatta al prodotto del progetto mantenendo la struttura e l'angolo originale dell'ad." }),
      });
      if (!r.body) throw new Error();
      const reader = r.body.getReader(); const decoder = new TextDecoder(); let buf = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const d = JSON.parse(line.slice(5).trim());
            if (d.content) { full += d.content; setGenStream(prev => ({ ...prev, [ad.id]: full })); }
            if (d.done) {
              const hl = full.match(/(?:Headline|Titolo)[:\s]*["»]?([^\n"»]{5,80})/i)?.[1]?.trim();
              const hook = full.match(/(?:Hook|Gancio|Apertura)[:\s]*["»]?([^\n"»]{5,120})/i)?.[1]?.trim();
              const body = full.match(/(?:Body|Testo|Copy)[:\s]*["»]?([^\n"»]{10,})/i)?.[1]?.trim();
              const elem = full.match(/(?:Elementi|Elements|Swipati)[:\s]*(.+)/i)?.[1];
              const analysis = full.match(/(?:Analisi|Strategia|Perché|Spiegazione)[:\s]*(.{20,})/i)?.[1]?.trim();
              const saved = await saveSwipe({
                competitor_ad_id: ad.id, brand_id: ad.brand_id, brand_name: ad.brand_name,
                competitor_headline: ad.headline, competitor_hook: ad.hook, competitor_body: ad.body_text,
                competitor_gradient: String(ad.id % ITER_GRADIENTS.length),
                swipe_headline: hl ?? `Swipe di "${ad.headline}"`,
                swipe_hook: hook ?? ad.hook, swipe_body: body ?? "", swipe_notes: "",
                elements_json: JSON.stringify(elem?.split(/[,;]/).map(s => s.trim()).filter(Boolean) ?? ["Headline", "Hook", "Struttura"]),
                analysis: analysis ?? full.slice(0, 300),
                created_at: new Date().toISOString(),
              });
              toast({ title: "Swipe creata e salvata!" });
              if (saved) setPreviewSwipe(saved);
            }
            if (d.error) toast({ title: "Errore generazione", variant: "destructive" });
          } catch { /* ignore */ }
        }
      }
    } catch { toast({ title: "Errore generazione", variant: "destructive" });
    } finally { setGeneratingFor(null); setGenStream(prev => { const n = { ...prev }; delete n[ad.id]; return n; }); }
  };

  const PERIOD_LABELS: Record<SwipePeriod, string> = {
    today: "Oggi", yesterday: "Ieri", week: "Settimana scorsa", month: "Mese corrente",
  };

  return (
    <div className="space-y-5">
      {/* ── BRAND DASHBOARD ACCORDION ── */}
      <div className="border border-border rounded-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-border bg-muted/20">
          <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
            <LayoutGrid className="w-4 h-4 text-violet-500" /> Dashboard Brand
          </h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">Espandi un brand per vedere le ads importate e le swipe create</p>
        </div>

        {loadingBrands ? (
          <div className="py-10 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
            <RefreshCw className="w-4 h-4 animate-spin" /> Caricamento...
          </div>
        ) : brands.length === 0 ? (
          <div className="py-12 text-center p-6">
            <Globe className="w-10 h-10 text-muted-foreground/20 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">Nessun competitor. Aggiungili dalla tab <strong>Lista Competitors</strong>.</p>
          </div>
        ) : (
          brands.map((brand, brandIdx) => {
            const bAds = adsForBrand(brand.id);
            const bSwipes = swipesForBrand(brand.id);
            const isExpanded = expandedBrand === brand.id;
            const brandG = getGradient(brandIdx);
            return (
              <div key={brand.id} className="border-b border-border last:border-b-0">
                {/* Brand header */}
                <button onClick={() => setExpandedBrand(isExpanded ? null : brand.id)}
                  className="w-full flex items-center gap-4 px-5 py-4 hover:bg-muted/20 transition-colors text-left group">
                  <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${brandG.bg} flex items-center justify-center flex-shrink-0 shadow-sm`}>
                    <span className="text-white font-black text-base">{brand.name.charAt(0).toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-foreground">{brand.name}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {bAds.length} ads importate
                      <span className="mx-1.5 opacity-40">•</span>
                      <span className={bSwipes.length > 0 ? "text-primary font-semibold" : ""}>{bSwipes.length} swipate</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-muted text-muted-foreground">{bAds.length} ads</span>
                    {bSwipes.length > 0 && (
                      <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-primary/10 text-primary">{bSwipes.length} swipe ✓</span>
                    )}
                    <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`} />
                  </div>
                </button>

                {/* Expanded: ad list */}
                {isExpanded && (
                  <div className="border-t border-border/50 bg-muted/5">
                    {bAds.length === 0 ? (
                      <div className="py-8 text-center text-sm text-muted-foreground">Nessuna ad importata per questo brand.</div>
                    ) : (
                      <div className="divide-y divide-border/30">
                        {bAds.map((ad) => {
                          const existing = swipeForAd(ad.id);
                          const isGen = generatingFor === ad.id;
                          const gComp = getGradient(ad.id % ITER_GRADIENTS.length);
                          const gSw = getGradient((ad.id % ITER_GRADIENTS.length) + 4);
                          return (
                            <div key={ad.id} className="px-5 py-3.5 flex items-center gap-4">
                              {/* Original mini card */}
                              <div className={`w-[72px] h-24 rounded-xl bg-gradient-to-br ${gComp.bg} flex flex-col justify-end p-2 relative overflow-hidden flex-shrink-0 shadow-sm`}>
                                <div className="absolute top-1.5 left-1.5 px-1 py-0.5 rounded-md bg-black/30 backdrop-blur-sm">
                                  <span className="text-white text-[7px] font-bold">ORIG</span>
                                </div>
                                <p className="text-white font-bold text-[8px] leading-tight relative z-10 line-clamp-2">{ad.headline}</p>
                              </div>
                              {/* Arrow */}
                              <div className="flex-shrink-0 flex items-center text-muted-foreground">
                                <div className="w-5 h-px bg-border" />
                                <span className="text-base px-0.5">→</span>
                                <div className="w-5 h-px bg-border" />
                              </div>
                              {/* Swipe card or action */}
                              {existing ? (
                                <div onClick={() => setPreviewSwipe(existing)}
                                  className={`w-[72px] h-24 rounded-xl bg-gradient-to-br ${gSw.bg} flex flex-col justify-end p-2 relative overflow-hidden flex-shrink-0 cursor-pointer shadow-sm group/card`}>
                                  <div className="absolute top-1.5 left-1.5 px-1 py-0.5 rounded-md bg-white/20 backdrop-blur-sm">
                                    <span className="text-white text-[7px] font-bold">SWIPE</span>
                                  </div>
                                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/card:opacity-100 transition-opacity flex items-center justify-center rounded-xl">
                                    <Eye className="w-4 h-4 text-white" />
                                  </div>
                                  <p className="text-white font-bold text-[8px] leading-tight relative z-10 line-clamp-2">{existing.swipe_headline}</p>
                                </div>
                              ) : isGen ? (
                                <div className="w-[72px] h-24 rounded-xl bg-muted border-2 border-dashed border-primary/40 flex flex-col items-center justify-center gap-1.5 flex-shrink-0">
                                  <RefreshCw className="w-4 h-4 text-primary animate-spin" />
                                  <p className="text-[8px] text-primary font-medium">Generando...</p>
                                </div>
                              ) : (
                                <button onClick={() => generateSwipeForAd(ad)} disabled={generatingFor !== null}
                                  className="w-[72px] h-24 rounded-xl bg-background border-2 border-dashed border-border hover:border-primary/50 hover:bg-primary/5 transition-all flex flex-col items-center justify-center gap-1.5 flex-shrink-0 group/btn disabled:opacity-40 disabled:cursor-not-allowed">
                                  <Zap className="w-4 h-4 text-muted-foreground group-hover/btn:text-primary transition-colors" />
                                  <p className="text-[8px] text-muted-foreground group-hover/btn:text-primary font-medium text-center leading-tight transition-colors">Swipa<br/>questa ad</p>
                                </button>
                              )}
                              {/* Info + stream */}
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-semibold text-foreground truncate">{ad.headline}</p>
                                <p className="text-[10px] text-muted-foreground truncate mt-0.5">{ad.hook}</p>
                                {existing && (
                                  <div className="flex items-center gap-2 mt-1.5">
                                    <p className="text-[9px] text-primary font-medium flex items-center gap-1">
                                      <CheckCircle className="w-2.5 h-2.5" />
                                      Swipata il {new Date(existing.created_at).toLocaleDateString("it-IT", { day: "2-digit", month: "short" })}
                                    </p>
                                  </div>
                                )}
                                {isGen && genStream[ad.id] && (
                                  <div className="mt-2 text-[9px] text-muted-foreground bg-muted/30 rounded-lg p-1.5 max-h-10 overflow-hidden">
                                    <pre className="font-sans whitespace-pre-wrap line-clamp-2">{genStream[ad.id]}</pre>
                                  </div>
                                )}
                              </div>
                              {/* Actions */}
                              <div className="flex items-center gap-2 flex-shrink-0">
                                {existing && (
                                  <>
                                    <button onClick={() => setPreviewSwipe(existing)}
                                      className="px-3 py-1.5 text-[10px] font-semibold border border-border rounded-lg hover:bg-muted transition-colors flex items-center gap-1 whitespace-nowrap">
                                      <Eye className="w-3 h-3" /> Vedi
                                    </button>
                                    <button onClick={() => deleteSwipe(existing.id)}
                                      className="p-1.5 text-muted-foreground hover:text-destructive transition-colors opacity-50 hover:opacity-100 rounded-lg hover:bg-destructive/10">
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </>
                                )}
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
          })
        )}
      </div>

      {/* ── BOARD DELLE SWIPE ── */}
      <div className="border border-border rounded-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-border bg-muted/20 flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <Copy className="w-4 h-4 text-amber-500" /> Board delle Swipe
              {boardSwipes.length > 0 && (
                <span className="text-[10px] font-bold px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full">{boardSwipes.length}</span>
              )}
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">Clicca su una card per vedere il confronto con l'ad originale e il brand di riferimento</p>
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {(["today", "yesterday", "week", "month"] as SwipePeriod[]).map(p => (
              <button key={p} onClick={() => setBoardPeriod(p)}
                className={`text-[11px] font-medium px-3 py-1.5 rounded-lg transition-colors border ${boardPeriod === p
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"}`}>
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        <div className="p-4">
          {loadingSwipes ? (
            <div className="py-16 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" /> Caricamento...
            </div>
          ) : boardSwipes.length === 0 ? (
            <div className="py-16 text-center border-2 border-dashed border-border rounded-xl">
              <Copy className="w-10 h-10 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-sm font-semibold text-foreground mb-1">Nessuna swipe {PERIOD_LABELS[boardPeriod].toLowerCase()}</p>
              <p className="text-xs text-muted-foreground">Usa il pulsante "Swipa" sulle ads nel dashboard brand qui sopra.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {boardSwipes.map(swipe => {
                const gC = getGradient(Number(swipe.competitor_gradient ?? 0));
                const gS = getGradient(Number(swipe.competitor_gradient ?? 0) + 4);
                return (
                  <div key={swipe.id} onClick={() => setPreviewSwipe(swipe)}
                    className="group border border-border rounded-xl p-3 cursor-pointer hover:border-primary/40 hover:shadow-md transition-all bg-card">
                    {/* Mini pair */}
                    <div className="flex items-center gap-2.5 mb-3">
                      <div className={`w-14 h-[72px] rounded-lg bg-gradient-to-br ${gC.bg} flex flex-col justify-end p-1.5 relative overflow-hidden flex-shrink-0 shadow-sm`}>
                        <div className="absolute top-1 left-1 px-0.5 py-0.5 rounded bg-black/30">
                          <span className="text-white text-[6px] font-bold">ORIG</span>
                        </div>
                        <p className="text-white font-bold text-[7px] leading-tight line-clamp-2 relative z-10">{swipe.competitor_headline}</p>
                      </div>
                      <span className="text-muted-foreground text-xl font-thin flex-shrink-0">→</span>
                      <div className={`w-14 h-[72px] rounded-lg bg-gradient-to-br ${gS.bg} flex flex-col justify-end p-1.5 relative overflow-hidden flex-shrink-0 shadow-sm`}>
                        <div className="absolute top-1 left-1 px-0.5 py-0.5 rounded bg-white/20">
                          <span className="text-white text-[6px] font-bold">SWIPE</span>
                        </div>
                        <p className="text-white font-bold text-[7px] leading-tight line-clamp-2 relative z-10">{swipe.swipe_headline}</p>
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700">{swipe.brand_name}</span>
                        <p className="text-[11px] font-semibold text-foreground mt-1.5 line-clamp-2 leading-tight">{swipe.swipe_headline}</p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between border-t border-border/40 pt-2">
                      <p className="text-[10px] text-muted-foreground">
                        {new Date(swipe.created_at).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </p>
                      <span className="text-[10px] font-semibold text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                        <Eye className="w-3 h-3" /> Confronta
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {previewSwipe && <SwipePopup swipe={previewSwipe} onClose={() => setPreviewSwipe(null)} />}
    </div>
  );
}

// ─── ROBOT SVG MASCOT ───
function RobotSVG({ thinking }: { thinking: boolean }) {
  return (
    <svg viewBox="0 0 80 105" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-[72px] h-[90px] drop-shadow-xl flex-shrink-0">
      <rect x="35" y="0" width="10" height="16" rx="5" fill="#22c55e"/>
      <circle cx="40" cy="5" r="6" fill="#22c55e"/>
      <rect x="8" y="16" width="64" height="48" rx="16" fill="#1e293b"/>
      <circle cx="28" cy="37" r="10" fill="#22c55e" opacity="0.12"/>
      <circle cx="52" cy="37" r="10" fill="#22c55e" opacity="0.12"/>
      <circle cx="28" cy="37" r="8" fill="#22c55e"/>
      <circle cx="52" cy="37" r="8" fill="#22c55e"/>
      <circle cx="28" cy="37" r="4" fill="#0f172a"/>
      <circle cx="52" cy="37" r="4" fill="#0f172a"/>
      <circle cx="30" cy="35" r="1.8" fill="white"/>
      <circle cx="54" cy="35" r="1.8" fill="white"/>
      <path d={thinking ? "M 27 52 Q 40 52 53 52" : "M 27 52 Q 40 60 53 52"}
        stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" fill="none"
        style={{ transition: "d 0.4s ease" }}/>
      <rect x="6" y="67" width="68" height="38" rx="13" fill="#0f172a"/>
      <rect x="16" y="76" width="48" height="20" rx="7" fill="#1e293b"/>
      <circle cx="30" cy="86" r="4.5" fill={thinking ? "#f59e0b" : "#22c55e"}/>
      <circle cx="40" cy="86" r="4.5" fill={thinking ? "#22c55e" : "#f59e0b"}/>
      <circle cx="50" cy="86" r="4.5" fill="#3b82f6"/>
    </svg>
  );
}

// ─── TAB: NUOVE CREATIVE ───
type GenPeriod = "today" | "yesterday" | "week" | "month";

function NuoveCreative({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [angles, setAngles] = useState<CreativeAngle[]>([]);
  const [loadingAngles, setLoadingAngles] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeStream, setAnalyzeStream] = useState("");
  const [genPanel, setGenPanel] = useState<CreativeAngle | null>(null);
  const [genCount, setGenCount] = useState(3);
  const [genFormat, setGenFormat] = useState("images");
  const [generatingAngle, setGeneratingAngle] = useState(false);
  const [genStream, setGenStream] = useState("");
  const [generated, setGenerated] = useState<CreativeGenerated[]>([]);
  const [loadingGenerated, setLoadingGenerated] = useState(true);
  const [boardPeriod, setBoardPeriod] = useState<GenPeriod>("today");

  const loadAll = async () => {
    setLoadingAngles(true); setLoadingGenerated(true);
    try {
      const [ra, rg] = await Promise.all([
        fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/angles`),
        fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/generated`),
      ]);
      if (ra.ok) setAngles(await ra.json());
      if (rg.ok) setGenerated(await rg.json());
    } finally { setLoadingAngles(false); setLoadingGenerated(false); }
  };

  useEffect(() => { loadAll(); }, [projectId]);

  const now = new Date();
  const boardItems = generated.filter(g => {
    const d = new Date(g.created_at);
    if (boardPeriod === "today") return d >= new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (boardPeriod === "yesterday") { const t = new Date(now.getFullYear(), now.getMonth(), now.getDate()); return d >= new Date(t.getTime() - 86400000) && d < t; }
    if (boardPeriod === "week") return d >= new Date(now.getTime() - 7 * 86400000);
    if (boardPeriod === "month") return d >= new Date(now.getFullYear(), now.getMonth(), 1);
    return true;
  });

  const analyzeAngles = async () => {
    setAnalyzing(true); setAnalyzeStream(""); setAngles([]);
    let full = "";
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/angles/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      if (!r.body) throw new Error();
      const reader = r.body.getReader(); const decoder = new TextDecoder(); let buf = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const d = JSON.parse(line.slice(5).trim());
            if (d.content) { full += d.content; setAnalyzeStream(full); }
            if (d.done) { toast({ title: "Analisi completata!" }); await loadAll(); }
            if (d.error) toast({ title: "Errore analisi", variant: "destructive" });
          } catch { /* ignore */ }
        }
      }
    } catch { toast({ title: "Errore", variant: "destructive" }); } finally { setAnalyzing(false); }
  };

  const deleteAngle = async (id: number) => {
    setAngles(prev => prev.filter(a => a.id !== id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/angles/${id}`, { method: "DELETE" });
  };

  const generateFromAngle = async () => {
    if (!genPanel) return;
    setGeneratingAngle(true); setGenStream("");
    let full = "";
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/generate-angle`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ angle_id: genPanel.id, angle_name: genPanel.angle_name, rationale: genPanel.rationale, ad_style: genPanel.ad_style, target: genPanel.target, hook_angle: genPanel.hook_angle, count: genCount, format: genFormat }),
      });
      if (!r.body) throw new Error();
      const reader = r.body.getReader(); const decoder = new TextDecoder(); let buf = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const d = JSON.parse(line.slice(5).trim());
            if (d.content) { full += d.content; setGenStream(full); }
            if (d.done) { toast({ title: `${genCount} creative generate!` }); setGenPanel(null); await loadAll(); }
            if (d.error) toast({ title: "Errore generazione", variant: "destructive" });
          } catch { /* ignore */ }
        }
      }
    } catch { toast({ title: "Errore", variant: "destructive" }); } finally { setGeneratingAngle(false); }
  };

  const deleteGenerated = async (id: number) => {
    setGenerated(prev => prev.filter(g => g.id !== id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/generated/${id}`, { method: "DELETE" });
  };

  const updateGenerated = async (id: number, status: string) => {
    setGenerated(prev => prev.map(g => g.id === id ? { ...g, status } : g));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/generated/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
    });
  };

  const PERIOD_LABELS: Record<GenPeriod, string> = { today: "Oggi", yesterday: "Ieri", week: "Settimana scorsa", month: "Mese corrente" };

  const TABLE_COLS: { key: keyof CreativeAngle; label: string; w: string; bg: string; textColor: string }[] = [
    { key: "rationale", label: "Perché funziona", w: "min-w-[190px]", bg: "bg-violet-50/60", textColor: "text-violet-900" },
    { key: "competitor_insights", label: "Analisi Competitor", w: "min-w-[190px]", bg: "bg-red-50/50", textColor: "text-red-900" },
    { key: "our_ads_insights", label: "Nostre Ads", w: "min-w-[180px]", bg: "bg-blue-50/50", textColor: "text-blue-900" },
    { key: "market_insights", label: "Ricerca Mercato", w: "min-w-[180px]", bg: "bg-emerald-50/50", textColor: "text-emerald-900" },
    { key: "ad_style", label: "Stile Ad", w: "min-w-[110px]", bg: "bg-amber-50/50", textColor: "text-amber-900" },
    { key: "target", label: "Target", w: "min-w-[150px]", bg: "bg-sky-50/50", textColor: "text-sky-900" },
    { key: "hook_angle", label: "Hook", w: "min-w-[130px]", bg: "bg-pink-50/50", textColor: "text-pink-900" },
  ];

  return (
    <div className="space-y-5">
      {/* ── ROBOT + ANGOLI TABLE ── */}
      <div className="border border-border rounded-2xl overflow-hidden">
        {/* Dark robot header */}
        <div className="flex items-center gap-5 px-5 py-4 bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 border-b border-slate-700">
          <RobotSVG thinking={analyzing} />
          <div className="flex-1 min-w-0">
            <div className="bg-white/10 border border-white/15 backdrop-blur-sm rounded-2xl rounded-tl-sm px-4 py-3 mb-3">
              <p className="text-white text-xs leading-relaxed">
                {analyzing
                  ? "Sto analizzando le ads competitor, i brief di progetto e i pattern di mercato... elaboro i migliori angoli creativi 🧠"
                  : angles.length > 0
                  ? `Ho trovato ${angles.length} angoli creativi ad alto potenziale. Clicca su un angolo e poi su "Genera" per creare le creative. 🚀`
                  : "Ciao! Sono il tuo AI creativo. Clicca \"Analizza Angoli\" per farmi scansionare competitor, nostre ads e ricerca di mercato. Troverò i migliori angoli creativi. 💡"}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button onClick={analyzeAngles} disabled={analyzing}
                className="bg-primary hover:bg-primary/90 text-white font-bold gap-2 h-9 text-xs">
                {analyzing
                  ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Analisi in corso…</>
                  : angles.length > 0
                  ? <><RefreshCw className="w-3.5 h-3.5" /> Rigenera Angoli</>
                  : <><Zap className="w-3.5 h-3.5" /> Analizza Angoli</>}
              </Button>
              {angles.length > 0 && !analyzing && (
                <span className="text-xs text-white/50">{angles.length} angoli trovati</span>
              )}
            </div>
          </div>
        </div>

        {/* Streaming while analyzing */}
        {analyzing && analyzeStream && (
          <div className="px-5 py-2.5 bg-muted/10 border-b border-border max-h-24 overflow-hidden">
            <pre className="text-[10px] text-muted-foreground font-sans whitespace-pre-wrap line-clamp-5">{analyzeStream}</pre>
            <span className="inline-block w-1 h-2.5 bg-primary animate-pulse ml-0.5 align-middle" />
          </div>
        )}

        {/* Empty state */}
        {!analyzing && angles.length === 0 && (
          <div className="py-16 text-center">
            <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-3">
              <Zap className="w-8 h-8 text-muted-foreground/30" />
            </div>
            <p className="text-sm font-semibold text-foreground mb-1">Nessun angolo ancora</p>
            <p className="text-xs text-muted-foreground">Premi "Analizza Angoli" per far partire l'analisi AI.</p>
          </div>
        )}

        {/* Excel-style angles table */}
        {!analyzing && angles.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" style={{ minWidth: 1150 }}>
              <thead>
                <tr className="bg-muted/30 border-b-2 border-border">
                  <th className="sticky left-0 z-10 bg-muted/40 text-left px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-10 border-r border-border">#</th>
                  <th className="sticky left-10 z-10 bg-muted/40 text-left px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground min-w-[150px] border-r border-border">Angolo</th>
                  {TABLE_COLS.map(col => (
                    <th key={col.key} className={`text-left px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground ${col.w} ${col.bg} border-r border-border/50 last:border-r-0`}>
                      {col.label}
                    </th>
                  ))}
                  <th className="text-center px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground min-w-[80px]">Azione</th>
                </tr>
              </thead>
              <tbody>
                {angles.map((angle, idx) => {
                  const g = getGradient(idx);
                  return (
                    <tr key={angle.id} className="border-b border-border/40 last:border-b-0 hover:bg-muted/10 transition-colors group/row">
                      {/* # */}
                      <td className="sticky left-0 z-10 bg-background group-hover/row:bg-muted/10 px-3 py-3 border-r border-border w-10">
                        <div className={`w-7 h-7 rounded-lg bg-gradient-to-br ${g.bg} flex items-center justify-center shadow-sm`}>
                          <span className="text-white font-black text-[10px]">{idx + 1}</span>
                        </div>
                      </td>
                      {/* Angle name */}
                      <td className="sticky left-10 z-10 bg-background group-hover/row:bg-muted/10 px-3 py-3 min-w-[150px] border-r border-border">
                        <p className="text-[11px] font-bold text-foreground leading-tight">{angle.angle_name}</p>
                      </td>
                      {/* Data columns */}
                      {TABLE_COLS.map(col => (
                        <td key={col.key} className={`px-3 py-3 ${col.w} ${col.bg} border-r border-border/30 align-top`}>
                          {col.key === "ad_style" || col.key === "hook_angle" ? (
                            <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full inline-block ${
                              col.key === "ad_style" ? "bg-amber-100 text-amber-800" : "bg-pink-100 text-pink-800"
                            }`}>{String(angle[col.key])}</span>
                          ) : (
                            <p className={`text-[10px] leading-snug line-clamp-3 ${col.textColor}`}>{String(angle[col.key])}</p>
                          )}
                        </td>
                      ))}
                      {/* Actions */}
                      <td className="px-2 py-3 text-center">
                        <div className="flex flex-col items-center gap-1">
                          <Button size="sm" onClick={() => setGenPanel(angle)}
                            className="h-6 text-[9px] px-2.5 bg-primary hover:bg-primary/90 text-white font-bold gap-1 w-full">
                            <Zap className="w-2.5 h-2.5" /> Genera
                          </Button>
                          <button onClick={() => deleteAngle(angle.id)}
                            className="opacity-0 group-hover/row:opacity-100 transition-opacity p-0.5 text-muted-foreground hover:text-destructive rounded">
                            <Trash2 className="w-3 h-3" />
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
      </div>

      {/* ── GENERATION MODAL ── */}
      {genPanel && (
        <Dialog open onOpenChange={v => !v && !generatingAngle && setGenPanel(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-sm">
                <Zap className="w-4 h-4 text-primary" /> Genera Creative — {genPanel.angle_name}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {/* Angle summary */}
              {(() => {
                const g = getGradient(angles.indexOf(genPanel));
                return (
                  <div className={`rounded-xl p-3 border border-border bg-gradient-to-r ${g.light}`}>
                    <p className="text-xs font-bold text-foreground mb-1">{genPanel.angle_name}</p>
                    <p className="text-[10px] text-muted-foreground">{genPanel.rationale.slice(0, 130)}…</p>
                    <div className="flex gap-1.5 mt-2">
                      <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">{genPanel.ad_style}</span>
                      <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-pink-100 text-pink-800">{genPanel.hook_angle}</span>
                    </div>
                  </div>
                );
              })()}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Quante creative</label>
                  <div className="flex gap-1.5">
                    {[1, 3, 5].map(n => (
                      <button key={n} onClick={() => setGenCount(n)}
                        className={`flex-1 h-8 rounded-lg text-xs font-bold transition-colors ${n === genCount ? "bg-primary text-white" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}>{n}</button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Formato</label>
                  <div className="flex gap-1.5">
                    {[{ v: "images", l: "Img" }, { v: "video", l: "Video" }, { v: "both", l: "Mix" }].map(({ v, l }) => (
                      <button key={v} onClick={() => setGenFormat(v)}
                        className={`flex-1 h-8 rounded-lg text-xs font-bold transition-colors ${v === genFormat ? "bg-primary text-white" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}>{l}</button>
                    ))}
                  </div>
                </div>
              </div>
              {genStream && (
                <div className="bg-muted/30 rounded-xl p-3 max-h-44 overflow-y-auto border border-border">
                  <pre className="text-[10px] text-foreground font-sans whitespace-pre-wrap">{genStream}</pre>
                  {generatingAngle && <span className="inline-block w-1 h-2.5 bg-primary animate-pulse ml-0.5 align-middle" />}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setGenPanel(null)} disabled={generatingAngle}>Annulla</Button>
                <Button size="sm" onClick={generateFromAngle} disabled={generatingAngle} className="bg-primary text-white font-bold gap-2">
                  {generatingAngle ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Generando {genCount}…</> : <><Zap className="w-3.5 h-3.5" /> Genera {genCount} Creative</>}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* ── BOARD CREATIVE GENERATE ── */}
      <div className="border border-border rounded-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-border bg-muted/20 flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <LayoutGrid className="w-4 h-4 text-primary" /> Board Creative Generate
              {boardItems.length > 0 && <span className="text-[10px] font-bold px-2 py-0.5 bg-primary/10 text-primary rounded-full">{boardItems.length}</span>}
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">Creative generate dall'AI, organizzate per data</p>
          </div>
          <div className="flex items-center gap-1">
            {(["today", "yesterday", "week", "month"] as GenPeriod[]).map(p => (
              <button key={p} onClick={() => setBoardPeriod(p)}
                className={`text-[11px] font-medium px-3 py-1.5 rounded-lg transition-colors border ${boardPeriod === p
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"}`}>
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
        </div>
        <div className="p-4">
          {loadingGenerated ? (
            <div className="py-16 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" /> Caricamento…
            </div>
          ) : boardItems.length === 0 ? (
            <div className="py-16 text-center border-2 border-dashed border-border rounded-xl">
              <LayoutGrid className="w-10 h-10 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-sm font-semibold text-foreground mb-1">Nessuna creativa {PERIOD_LABELS[boardPeriod].toLowerCase()}</p>
              <p className="text-xs text-muted-foreground">Usa "Genera" su un angolo della tabella qui sopra.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {boardItems.map((gen, idx) => {
                const g = getGradient(Number(gen.gradient_idx ?? idx));
                return (
                  <div key={gen.id} className={`group relative border rounded-xl overflow-hidden hover:shadow-md transition-all ${gen.status === "approved" ? "border-primary/40 ring-1 ring-primary/20" : gen.status === "rejected" ? "border-destructive/30 opacity-60" : "border-border"}`}>
                    {/* Visual card */}
                    <div className={`h-32 bg-gradient-to-br ${g.bg} flex flex-col justify-end p-3 relative overflow-hidden`}>
                      <div className="absolute inset-0 bg-black/20" />
                      <div className="absolute top-2 right-2 z-10">
                        <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full ${gen.status === "approved" ? "bg-primary text-white" : gen.status === "rejected" ? "bg-destructive text-white" : "bg-white/25 text-white backdrop-blur-sm"}`}>
                          {gen.status === "approved" ? "✓ OK" : gen.status === "rejected" ? "✗" : "Draft"}
                        </span>
                      </div>
                      <button onClick={() => deleteGenerated(gen.id)}
                        className="absolute top-2 left-2 z-10 p-1 rounded bg-black/30 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/50">
                        <Trash2 className="w-3 h-3" />
                      </button>
                      <p className="text-white font-bold text-xs leading-tight relative z-10 line-clamp-2">{gen.headline}</p>
                      <p className="text-white/75 text-[10px] leading-tight relative z-10 mt-0.5 line-clamp-1">{gen.hook}</p>
                    </div>
                    {/* Info panel */}
                    <div className="p-3 bg-card">
                      <div className="flex flex-wrap gap-1 mb-2">
                        {gen.angle_name && <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 max-w-[110px] truncate">{gen.angle_name}</span>}
                        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">{gen.format}</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground line-clamp-2 leading-snug mb-2">{gen.body}</p>
                      <div className="flex items-center justify-between gap-1">
                        <p className="text-[9px] text-muted-foreground">{new Date(gen.created_at).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</p>
                        {gen.status === "draft" && (
                          <div className="flex gap-1">
                            <button onClick={() => updateGenerated(gen.id, "approved")}
                              className="p-1 rounded bg-primary/10 text-primary hover:bg-primary hover:text-white transition-colors">
                              <CheckCircle className="w-3 h-3" />
                            </button>
                            <button onClick={() => updateGenerated(gen.id, "rejected")}
                              className="p-1 rounded bg-destructive/10 text-destructive hover:bg-destructive hover:text-white transition-colors">
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── TAB 5: DASHBOARD ───
function CreativeDashboard({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [brands, setBrands] = useState<CompetitorBrand[]>([]);
  const [jobs, setJobs] = useState<AutomationJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [addBrandOpen, setAddBrandOpen] = useState(false);
  const [addJobOpen, setAddJobOpen] = useState(false);
  const [brandType, setBrandType] = useState<"competitor" | "inspiration">("competitor");
  const [brandForm, setBrandForm] = useState({ name: "", ads_library_url: "", scrape_count: "10", frequency: "every_7_days", notes: "", creative_quality_notes: "" });
  const [jobForm, setJobForm] = useState({ brand_id: "", mode: "swipe", frequency: "daily", media_type: "both", ads_count: "5", iterations_per_ad: "3" });

  const load = async () => {
    setLoading(true);
    try {
      const [br, jr] = await Promise.all([
        fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/brands`),
        fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/jobs`),
      ]);
      if (br.ok) setBrands(await br.json());
      if (jr.ok) setJobs(await jr.json());
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [projectId]);

  const addBrand = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/brands`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...brandForm, brand_type: brandType, scrape_count: Number(brandForm.scrape_count) }),
      });
      if (r.ok) { const brand = await r.json(); setBrands(prev => [...prev, brand]); setAddBrandOpen(false); setBrandForm({ name: "", ads_library_url: "", scrape_count: "10", frequency: "every_7_days", notes: "", creative_quality_notes: "" }); toast({ title: "Brand aggiunto!" }); }
    } catch { toast({ title: "Errore", variant: "destructive" }); }
  };

  const addJob = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/jobs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...jobForm, ads_count: Number(jobForm.ads_count), iterations_per_ad: Number(jobForm.iterations_per_ad), brand_id: jobForm.brand_id || null }),
      });
      if (r.ok) { const job = await r.json(); setJobs(prev => [...prev, job]); setAddJobOpen(false); toast({ title: "Job creato!" }); }
    } catch { toast({ title: "Errore", variant: "destructive" }); }
  };

  const delBrand = async (id: number) => {
    setBrands(prev => prev.filter(b => b.id !== id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/brands/${id}`, { method: "DELETE" });
  };

  const delJob = async (id: number) => {
    setJobs(prev => prev.filter(j => j.id !== id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/jobs/${id}`, { method: "DELETE" });
  };

  const toggleJob = async (job: AutomationJob) => {
    const status = job.status === "active" ? "paused" : "active";
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status } : j));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/jobs/${job.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
    });
  };

  const competitorBrands = brands.filter(b => b.brand_type === "competitor");
  const inspirationBrands = brands.filter(b => b.brand_type === "inspiration");

  const estimatedOutput = jobs.filter(j => j.status === "active")
    .reduce((sum, j) => sum + (j.ads_count * j.iterations_per_ad), 0);

  const BrandTable = ({ items, type }: { items: CompetitorBrand[]; type: "competitor" | "inspiration" }) => (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-sm text-foreground">{type === "competitor" ? "Brand Competitor" : "Brand Ispiratori"}</h4>
        <Button size="sm" onClick={() => { setBrandType(type); setAddBrandOpen(true); }} className="bg-primary text-white gap-1.5 h-7 text-xs">
          <Plus className="w-3 h-3" /> Aggiungi
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground italic py-4 text-center border border-dashed border-border rounded-lg">
          Nessun brand aggiunto ancora.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/60 border-b border-border">
                {["Brand", "Ads Library URL", "N° Ads", "Frequenza", "Attivo", "Azioni"].map(h => (
                  <th key={h} className="text-left px-3 py-2 font-semibold text-muted-foreground text-[10px] uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map(b => (
                <tr key={b.id} className="border-b border-border/50 last:border-b-0 hover:bg-muted/20">
                  <td className="px-3 py-2 font-medium text-foreground">{b.name}</td>
                  <td className="px-3 py-2">
                    {b.ads_library_url ? (
                      <a href={b.ads_library_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline flex items-center gap-1">
                        Link <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2">{b.scrape_count}</td>
                  <td className="px-3 py-2 text-muted-foreground">{b.frequency.replace(/_/g, " ")}</td>
                  <td className="px-3 py-2">
                    <button onClick={() => {
                      const newVal = b.is_active === "true" ? "false" : "true";
                      setBrands(prev => prev.map(x => x.id === b.id ? { ...x, is_active: newVal } : x));
                      fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/brands/${b.id}`, {
                        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_active: newVal }),
                      });
                    }} className={`w-8 h-4 rounded-full transition-colors ${b.is_active === "true" ? "bg-primary" : "bg-muted"}`}>
                      <div className={`w-3 h-3 rounded-full bg-white shadow transition-transform mx-0.5 ${b.is_active === "true" ? "translate-x-4" : "translate-x-0"}`} />
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <button onClick={() => delBrand(b.id)} className="text-muted-foreground hover:text-destructive transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Output estimate */}
      {estimatedOutput > 0 && (
        <div className="bg-primary/5 border border-primary/20 rounded-xl p-4">
          <p className="text-sm font-semibold text-foreground">Stima output giornaliero: <span className="text-primary">~{estimatedOutput} ads/giorno</span></p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {jobs.filter(j => j.status === "active").map(j => `${j.ads_count} ads × ${j.iterations_per_ad} iter`).join(" + ")} = {estimatedOutput}
          </p>
        </div>
      )}

      <BrandTable items={competitorBrands} type="competitor" />
      <BrandTable items={inspirationBrands} type="inspiration" />

      {/* Automation Jobs */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="font-semibold text-sm text-foreground">Automation Jobs</h4>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="text-xs h-7 gap-1">Run All Now</Button>
            <Button size="sm" onClick={() => setAddJobOpen(true)} className="bg-primary text-white gap-1.5 h-7 text-xs">
              <Plus className="w-3 h-3" /> Nuovo Job
            </Button>
          </div>
        </div>
        {jobs.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-4 text-center border border-dashed border-border rounded-lg">Nessun job configurato.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/60 border-b border-border">
                  {["Modalità", "Freq.", "Media", "# Ads", "Iter./Ad", "Status", "Azioni"].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-semibold text-muted-foreground text-[10px] uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.map(j => (
                  <tr key={j.id} className="border-b border-border/50 last:border-b-0 hover:bg-muted/20">
                    <td className="px-3 py-2">
                      <Badge className={`text-[9px] ${j.mode === "iteration" ? "bg-purple-100 text-purple-700" : j.mode === "swipe" ? "bg-amber-100 text-amber-700" : j.mode === "new" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}`}>
                        {j.mode === "iteration" ? "🔁 Iterazione" : j.mode === "swipe" ? "🔀 Swipe" : j.mode === "new" ? "✨ Nuove" : "📌 Template"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{j.frequency}</td>
                    <td className="px-3 py-2 text-muted-foreground">{j.media_type}</td>
                    <td className="px-3 py-2">{j.ads_count}</td>
                    <td className="px-3 py-2">{j.iterations_per_ad}</td>
                    <td className="px-3 py-2">
                      <button onClick={() => toggleJob(j)}
                        className={`w-8 h-4 rounded-full transition-colors ${j.status === "active" ? "bg-primary" : "bg-muted"}`}>
                        <div className={`w-3 h-3 rounded-full bg-white shadow transition-transform mx-0.5 ${j.status === "active" ? "translate-x-4" : "translate-x-0"}`} />
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <button onClick={() => delJob(j.id)} className="text-muted-foreground hover:text-destructive transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add Brand Modal */}
      <Dialog open={addBrandOpen} onOpenChange={setAddBrandOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Aggiungi {brandType === "competitor" ? "Competitor" : "Brand Ispirazione"}</DialogTitle></DialogHeader>
          <form onSubmit={addBrand} className="space-y-3 mt-2">
            {[
              { label: "Nome Brand *", key: "name", placeholder: "Es. HerbaLife" },
              { label: "Ads Library URL", key: "ads_library_url", placeholder: "https://facebook.com/ads/library/..." },
              { label: "N° Ads da scrapare", key: "scrape_count", placeholder: "10" },
              ...(brandType === "inspiration" ? [{ label: "Note qualità creative", key: "creative_quality_notes", placeholder: "Perché questo brand è ispirazione..." }] : []),
              { label: "Note", key: "notes", placeholder: "Note aggiuntive..." },
            ].map(({ label, key, placeholder }) => (
              <div key={key} className="space-y-1">
                <label className="text-xs font-medium text-foreground">{label}</label>
                <Input value={brandForm[key as keyof typeof brandForm]} onChange={e => setBrandForm(prev => ({ ...prev, [key]: e.target.value }))} placeholder={placeholder} className="text-sm" />
              </div>
            ))}
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Frequenza</label>
              <select value={brandForm.frequency} onChange={e => setBrandForm(prev => ({ ...prev, frequency: e.target.value }))} className="w-full text-sm border border-border rounded-md px-3 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-primary">
                {["once", "daily", "every_3_days", "every_5_days", "every_7_days"].map(f => <option key={f} value={f}>{f.replace(/_/g, " ")}</option>)}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setAddBrandOpen(false)}>Annulla</Button>
              <Button type="submit" className="bg-primary text-white">Aggiungi</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add Job Modal */}
      <Dialog open={addJobOpen} onOpenChange={setAddJobOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Nuovo Automation Job</DialogTitle></DialogHeader>
          <form onSubmit={addJob} className="space-y-3 mt-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Brand</label>
              <select value={jobForm.brand_id} onChange={e => setJobForm(prev => ({ ...prev, brand_id: e.target.value }))} className="w-full text-sm border border-border rounded-md px-3 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-primary">
                <option value="">Nessun brand specifico</option>
                {brands.map(b => <option key={b.id} value={b.id}>{b.name} ({b.brand_type})</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "Modalità", key: "mode", opts: [{ v: "swipe", l: "Swipe" }, { v: "iteration", l: "Iterazione" }, { v: "new", l: "Nuove" }, { v: "template", l: "Template" }] },
                { label: "Frequenza", key: "frequency", opts: [{ v: "daily", l: "Giornaliero" }, { v: "every_3_days", l: "Ogni 3gg" }, { v: "every_7_days", l: "Ogni 7gg" }] },
                { label: "Media", key: "media_type", opts: [{ v: "images", l: "Immagini" }, { v: "videos", l: "Video" }, { v: "both", l: "Entrambi" }] },
              ].map(({ label, key, opts }) => (
                <div key={key} className="space-y-1">
                  <label className="text-xs font-medium text-foreground">{label}</label>
                  <select value={jobForm[key as keyof typeof jobForm]} onChange={e => setJobForm(prev => ({ ...prev, [key]: e.target.value }))} className="w-full text-xs border border-border rounded-md px-2 py-1.5 bg-background focus:outline-none">
                    {opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                  </select>
                </div>
              ))}
              {[{ label: "N° Ads", key: "ads_count", placeholder: "5" }, { label: "Iter./Ad", key: "iterations_per_ad", placeholder: "3" }].map(({ label, key, placeholder }) => (
                <div key={key} className="space-y-1">
                  <label className="text-xs font-medium text-foreground">{label}</label>
                  <Input value={jobForm[key as keyof typeof jobForm]} onChange={e => setJobForm(prev => ({ ...prev, [key]: e.target.value }))} placeholder={placeholder} className="text-xs h-8" type="number" min="1" />
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setAddJobOpen(false)}>Annulla</Button>
              <Button type="submit" className="bg-primary text-white">Crea Job</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── TAB: LISTA COMPETITORS ───
function ListaCompetitors({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [items, setItems] = useState<CompetitorBrand[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: "", ads_library_url: "", scrape_count: "10", frequency: "every_7_days" });
  const [adding, setAdding] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/brands`);
      if (r.ok) { const all: CompetitorBrand[] = await r.json(); setItems(all.filter(b => b.brand_type === "competitor")); }
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [projectId]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { toast({ title: "Inserisci il nome", variant: "destructive" }); return; }
    setAdding(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/brands`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, brand_type: "competitor", scrape_count: Number(form.scrape_count), notes: "", creative_quality_notes: "" }),
      });
      if (r.ok) {
        const b = await r.json(); setItems(prev => [...prev, b]);
        setForm({ name: "", ads_library_url: "", scrape_count: "10", frequency: "every_7_days" });
        setShowForm(false); toast({ title: "Competitor aggiunto!" });
      }
    } catch { toast({ title: "Errore", variant: "destructive" }); } finally { setAdding(false); }
  };

  const del = async (id: number) => {
    setItems(prev => prev.filter(b => b.id !== id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/brands/${id}`, { method: "DELETE" });
    toast({ title: "Competitor rimosso" });
  };

  const FREQ_LABELS: Record<string, string> = { once: "Una volta", daily: "Giornaliero", every_3_days: "Ogni 3 giorni", every_5_days: "Ogni 5 giorni", every_7_days: "Ogni 7 giorni" };

  return (
    <div className="space-y-5">
      {/* Add form */}
      <div className="bg-red-50 border border-red-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-red-900 text-sm flex items-center gap-2">
              <Globe className="w-4 h-4 text-red-500" /> Lista Competitors
            </h3>
            <p className="text-xs text-red-600/70 mt-0.5">Brand competitor da monitorare per scraping ads e analisi creativa.</p>
          </div>
          <Button size="sm" onClick={() => setShowForm(v => !v)} className="bg-red-500 hover:bg-red-600 text-white gap-1.5 h-7 text-xs">
            <Plus className="w-3 h-3" /> Aggiungi Competitor
          </Button>
        </div>

        {showForm && (
          <form onSubmit={add} className="bg-white/70 border border-red-100 rounded-lg p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-red-900">Nome Competitor *</label>
                <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Es. HerbaLife, NutraVista…" className="text-sm border-red-200 focus:ring-red-300" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-red-900">Link Ads Library</label>
                <Input value={form.ads_library_url} onChange={e => setForm(p => ({ ...p, ads_library_url: e.target.value }))} placeholder="https://facebook.com/ads/library/…" className="text-sm border-red-200" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-red-900">N° Ads da scrapare</label>
                <Input type="number" min="1" value={form.scrape_count} onChange={e => setForm(p => ({ ...p, scrape_count: e.target.value }))} className="text-sm border-red-200" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-red-900">Frequenza scraping</label>
                <select value={form.frequency} onChange={e => setForm(p => ({ ...p, frequency: e.target.value }))} className="w-full text-sm border border-red-200 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-red-300">
                  {Object.entries(FREQ_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setShowForm(false)}>Annulla</Button>
              <Button type="submit" size="sm" disabled={adding} className="bg-red-500 hover:bg-red-600 text-white">
                {adding ? "Salvataggio…" : "Aggiungi"}
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Caricamento…</div>
      ) : items.length === 0 ? (
        <div className="py-12 text-center border-2 border-dashed border-red-200 rounded-xl bg-red-50/30">
          <Globe className="w-8 h-8 text-red-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-red-700">Nessun competitor aggiunto</p>
          <p className="text-xs text-red-500/70 mt-1">Clicca "Aggiungi Competitor" per iniziare.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-red-200">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-red-100/60 border-b border-red-200">
                {["Brand", "Ads Library", "N° Ads", "Frequenza", "Azioni"].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 font-semibold text-red-700 text-[10px] uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((b, i) => (
                <tr key={b.id} className={`border-b border-red-100 last:border-b-0 hover:bg-red-50/60 transition-colors ${i % 2 === 0 ? "bg-white/60" : "bg-red-50/20"}`}>
                  <td className="px-4 py-2.5 font-semibold text-foreground">{b.name}</td>
                  <td className="px-4 py-2.5">
                    {b.ads_library_url ? (
                      <a href={b.ads_library_url} target="_blank" rel="noopener noreferrer" className="text-red-600 hover:underline flex items-center gap-1">
                        Apri <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-foreground">{b.scrape_count}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{FREQ_LABELS[b.frequency] ?? b.frequency}</td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => del(b.id)} className="text-muted-foreground hover:text-destructive transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── TAB: LISTA BRAND ───
function ListaBrand({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [items, setItems] = useState<CompetitorBrand[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: "", ads_library_url: "", scrape_count: "10", frequency: "every_7_days" });
  const [adding, setAdding] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/brands`);
      if (r.ok) { const all: CompetitorBrand[] = await r.json(); setItems(all.filter(b => b.brand_type === "inspiration")); }
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [projectId]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { toast({ title: "Inserisci il nome", variant: "destructive" }); return; }
    setAdding(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/brands`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, brand_type: "inspiration", scrape_count: Number(form.scrape_count), notes: "", creative_quality_notes: "" }),
      });
      if (r.ok) {
        const b = await r.json(); setItems(prev => [...prev, b]);
        setForm({ name: "", ads_library_url: "", scrape_count: "10", frequency: "every_7_days" });
        setShowForm(false); toast({ title: "Brand aggiunto!" });
      }
    } catch { toast({ title: "Errore", variant: "destructive" }); } finally { setAdding(false); }
  };

  const del = async (id: number) => {
    setItems(prev => prev.filter(b => b.id !== id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/creative/brands/${id}`, { method: "DELETE" });
    toast({ title: "Brand rimosso" });
  };

  const FREQ_LABELS: Record<string, string> = { once: "Una volta", daily: "Giornaliero", every_3_days: "Ogni 3 giorni", every_5_days: "Ogni 5 giorni", every_7_days: "Ogni 7 giorni" };

  return (
    <div className="space-y-5">
      {/* Add form */}
      <div className="bg-rose-50/60 border border-rose-150 rounded-xl p-5 space-y-4" style={{ borderColor: "#fecdd3" }}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-rose-900 text-sm flex items-center gap-2">
              <LayoutGrid className="w-4 h-4 text-rose-400" /> Lista Brand
            </h3>
            <p className="text-xs text-rose-600/70 mt-0.5">Brand di ispirazione da monitorare per benchmark e riferimento creativo.</p>
          </div>
          <Button size="sm" onClick={() => setShowForm(v => !v)} className="bg-rose-400 hover:bg-rose-500 text-white gap-1.5 h-7 text-xs">
            <Plus className="w-3 h-3" /> Aggiungi Brand
          </Button>
        </div>

        {showForm && (
          <form onSubmit={add} className="bg-white/70 border border-rose-100 rounded-lg p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-rose-900">Nome Brand *</label>
                <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Es. Bioma, ProDentim…" className="text-sm" style={{ borderColor: "#fecdd3" }} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-rose-900">Link Ads Library</label>
                <Input value={form.ads_library_url} onChange={e => setForm(p => ({ ...p, ads_library_url: e.target.value }))} placeholder="https://facebook.com/ads/library/…" className="text-sm" style={{ borderColor: "#fecdd3" }} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-rose-900">N° Ads da scrapare</label>
                <Input type="number" min="1" value={form.scrape_count} onChange={e => setForm(p => ({ ...p, scrape_count: e.target.value }))} className="text-sm" style={{ borderColor: "#fecdd3" }} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-rose-900">Frequenza scraping</label>
                <select value={form.frequency} onChange={e => setForm(p => ({ ...p, frequency: e.target.value }))} className="w-full text-sm border rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-rose-300" style={{ borderColor: "#fecdd3" }}>
                  {Object.entries(FREQ_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setShowForm(false)}>Annulla</Button>
              <Button type="submit" size="sm" disabled={adding} className="bg-rose-400 hover:bg-rose-500 text-white">
                {adding ? "Salvataggio…" : "Aggiungi"}
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Caricamento…</div>
      ) : items.length === 0 ? (
        <div className="py-12 text-center border-2 border-dashed rounded-xl" style={{ borderColor: "#fecdd3", background: "rgba(255,228,230,0.2)" }}>
          <LayoutGrid className="w-8 h-8 mx-auto mb-2" style={{ color: "#fda4af" }} />
          <p className="text-sm font-medium text-rose-700">Nessun brand aggiunto</p>
          <p className="text-xs text-rose-500/70 mt-1">Clicca "Aggiungi Brand" per iniziare.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border" style={{ borderColor: "#fecdd3" }}>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b" style={{ background: "rgba(255,228,230,0.4)", borderColor: "#fecdd3" }}>
                {["Brand", "Ads Library", "N° Ads", "Frequenza", "Azioni"].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 font-semibold text-[10px] uppercase tracking-wider" style={{ color: "#be123c" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((b, i) => (
                <tr key={b.id} className="border-b last:border-b-0 hover:bg-rose-50/40 transition-colors" style={{ borderColor: "#fecdd3", background: i % 2 === 0 ? "white" : "rgba(255,228,230,0.1)" }}>
                  <td className="px-4 py-2.5 font-semibold text-foreground">{b.name}</td>
                  <td className="px-4 py-2.5">
                    {b.ads_library_url ? (
                      <a href={b.ads_library_url} target="_blank" rel="noopener noreferrer" className="text-rose-500 hover:underline flex items-center gap-1">
                        Apri <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-foreground">{b.scrape_count}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{FREQ_LABELS[b.frequency] ?? b.frequency}</td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => del(b.id)} className="text-muted-foreground hover:text-destructive transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── MAIN CREATIVE SECTION ───
const CREATIVE_TABS = [
  { id: "competitors", label: "Lista Competitors", yellow: true },
  { id: "brand", label: "Lista Brand", yellow: true },
  { id: "templates", label: "Template Salvati", yellow: false },
  { id: "iterazione", label: "Iterazione", yellow: false },
  { id: "swipe", label: "Swipe", yellow: false },
  { id: "nuove", label: "Nuove Creative", yellow: false },
  { id: "dashboard", label: "Dashboard", yellow: false },
] as const;

type CreativeTabId = typeof CREATIVE_TABS[number]["id"];

export function CreativeSection({ projectId }: { projectId: string }) {
  const [activeTab, setActiveTab] = useState<CreativeTabId>("competitors");

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1 flex items-center gap-2">
          <Palette className="w-5 h-5 text-primary" /> Creative
        </h2>
        <p className="text-sm text-muted-foreground">Template, iterazioni, swipe e generazione autonoma di creative pubblicitarie.</p>
      </div>

      <div className="flex gap-0 border-b border-border overflow-x-auto">
        {CREATIVE_TABS.map(tab => {
          const isActive = tab.id === activeTab;
          if (tab.yellow) {
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors border-b-2 -mb-px flex-shrink-0 ${
                  isActive
                    ? "border-amber-400 text-amber-600 bg-amber-50/50"
                    : "border-transparent text-amber-500/80 hover:text-amber-600 hover:bg-amber-50/30"
                }`}>
                {tab.label}
              </button>
            );
          }
          return (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px flex-shrink-0 ${
                isActive ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}>
              {tab.label}
            </button>
          );
        })}
      </div>

      <div>
        {activeTab === "competitors" && <ListaCompetitors projectId={projectId} />}
        {activeTab === "brand" && <ListaBrand projectId={projectId} />}
        {activeTab === "templates" && <TemplateSalvati projectId={projectId} />}
        {activeTab === "iterazione" && <Iterazione projectId={projectId} />}
        {activeTab === "swipe" && <SwipeTab projectId={projectId} />}
        {activeTab === "nuove" && <NuoveCreative projectId={projectId} />}
        {activeTab === "dashboard" && <CreativeDashboard projectId={projectId} />}
      </div>
    </div>
  );
}
