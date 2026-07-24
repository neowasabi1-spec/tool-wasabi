import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Trash2, Upload, Play, Search, ArrowLeft, ExternalLink,
  BarChart2, Calendar, Globe, X, RefreshCw, Image as ImageIcon,
  Video, Bookmark, CheckSquare, Square, TrendingUp, Download,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { FunnelMonitoringSection } from "./FunnelMonitoringSection";
import { getUploadUrl } from "@/lib/projecthub-storage";

const BASE_URL = "";

type CompetitorWithStats = {
  id: number;
  project_id: string;
  name: string;
  ads_library_url: string;
  scrape_count: number;
  frequency: string;
  brand_type: string;
  notes: string;
  is_active: string;
  last_scraped: string | null;
  created_at: string;
  ads_count: number;
  video_count: number;
  image_count: number;
  hooks: string[];
  headlines: string[];
  monitoring_status: "attivo" | "in_analisi";
  last_check: string | null;
  preview_path?: string;
  preview_type?: string;
};

type CompetitorAd = {
  id: number;
  project_id: string;
  brand_id: number;
  file_path: string;
  media_type: string;
  name: string;
  headline: string;
  hook: string;
  body_text: string;
  is_active: string;
  created_at: string;
};

function formatDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" });
}

// Force a download of a creative. Local (storage) files go through the
// file-proxy with `download=1` (Content-Disposition: attachment); remote URLs
// are opened directly (best effort — cross-origin can't always be forced).
function downloadCreative(ad: { file_path: string; name?: string; media_type?: string }) {
  if (!ad.file_path) return;
  const isRemote = /^https?:\/\//i.test(ad.file_path);
  const base = getUploadUrl(ad.file_path);
  const href = isRemote ? base : `${base}${base.includes("?") ? "&" : "?"}download=1`;
  const a = document.createElement("a");
  a.href = href;
  a.download = (ad.name || "creative").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (isRemote) a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Colori per i placeholder delle ads (senza immagine)
const AD_GRADIENTS = [
  { bg: "from-slate-800 to-slate-900", text: "text-white" },
  { bg: "from-emerald-600 to-emerald-800", text: "text-white" },
  { bg: "from-orange-500 to-orange-700", text: "text-white" },
  { bg: "from-sky-500 to-sky-800", text: "text-white" },
  { bg: "from-violet-600 to-violet-900", text: "text-white" },
  { bg: "from-rose-500 to-rose-800", text: "text-white" },
  { bg: "from-amber-500 to-amber-700", text: "text-white" },
  { bg: "from-teal-500 to-teal-800", text: "text-white" },
  { bg: "from-indigo-600 to-indigo-900", text: "text-white" },
  { bg: "from-lime-500 to-lime-700", text: "text-white" },
];

// Componente card placeholder senza file (renderizza il testo come ad)
function AdPlaceholder({ ad, index }: { ad: CompetitorAd; index: number }) {
  const g = AD_GRADIENTS[index % AD_GRADIENTS.length];
  return (
    <div className={`w-full h-full bg-gradient-to-br ${g.bg} flex flex-col items-start justify-end p-3 relative overflow-hidden`}>
      {/* Decorative circle */}
      <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-white/5" />
      <div className="absolute top-1/3 -left-4 w-16 h-16 rounded-full bg-white/5" />
      {/* Badge tipo */}
      <div className="absolute top-2.5 left-2.5">
        <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${ad.media_type === "video" ? "bg-purple-500 text-white" : "bg-blue-500 text-white"}`}>
          {ad.media_type === "video" ? "VIDEO" : "IMG"}
        </span>
      </div>
      {/* Headline testo grande */}
      <div className={`${g.text} space-y-1`}>
        {ad.hook && (
          <p className="text-[10px] opacity-70 leading-tight line-clamp-2">{ad.hook}</p>
        )}
        <p className="text-sm font-black leading-tight line-clamp-3">{ad.headline || ad.name}</p>
      </div>
    </div>
  );
}

// ── COMPETITOR LIST VIEW ──
function CompetitorList({ projectId, onSelect }: { projectId: string; onSelect: (c: CompetitorWithStats) => void }) {
  const { toast } = useToast();
  const [competitors, setCompetitors] = useState<CompetitorWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: "", ads_library_url: "", scrape_count: "20", frequency: "every_7_days" });
  const [adding, setAdding] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library`);
      if (r.ok) setCompetitors(await r.json());
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [projectId]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { toast({ title: "Enter the domain/name", variant: "destructive" }); return; }
    setAdding(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, scrape_count: Number(form.scrape_count) }),
      });
      if (r.ok) {
        await load();
        setAddOpen(false); setForm({ name: "", ads_library_url: "", scrape_count: "20", frequency: "every_7_days" });
        toast({ title: "Competitor added!" });
      }
    } catch { toast({ title: "Error", variant: "destructive" }); } finally { setAdding(false); }
  };

  const del = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    setCompetitors(p => p.filter(c => c.id !== id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${id}`, { method: "DELETE" });
    toast({ title: "Competitor removed" });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Competitor Library</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Monitor competitors and save their templates</p>
        </div>
        <Button onClick={() => setAddOpen(true)} className="bg-primary text-white gap-1.5 text-sm">
          <Plus className="w-4 h-4" /> Add Competitor
        </Button>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading...</div>
      ) : competitors.length === 0 ? (
        <div className="py-24 text-center border-2 border-dashed border-border rounded-2xl">
          <Globe className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-base font-semibold text-foreground mb-1">No competitors monitored</p>
          <p className="text-sm text-muted-foreground mb-4">Add a competitor by entering its domain or ads library URL.</p>
          <Button onClick={() => setAddOpen(true)} className="bg-primary text-white gap-1.5">
            <Plus className="w-4 h-4" /> Add Competitor
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {competitors.map(c => (
            <div key={c.id}
              onClick={() => onSelect(c)}
              className="group relative bg-card border border-border rounded-2xl overflow-hidden hover:border-primary/40 hover:shadow-lg transition-all cursor-pointer">

              {/* Preview */}
              <div className="aspect-[4/3] relative overflow-hidden bg-gradient-to-br from-slate-800 to-slate-900">
                {c.preview_path ? (
                  c.preview_type === "video" ? (
                    <video src={getUploadUrl(c.preview_path)} muted playsInline preload="metadata"
                      className="w-full h-full object-cover" />
                  ) : (
                    <img src={getUploadUrl(c.preview_path)} alt={c.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  )
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Globe className="w-10 h-10 text-white/20" />
                  </div>
                )}
                {c.preview_type === "video" && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-11 h-11 rounded-full bg-black/50 flex items-center justify-center">
                      <Play className="w-5 h-5 text-white" />
                    </div>
                  </div>
                )}
                {/* Monitoring dot */}
                <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 bg-black/45 backdrop-blur-sm rounded-full px-2 py-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${c.monitoring_status === "attivo" ? "bg-green-400" : "bg-amber-400"}`} />
                  <span className="text-[9px] font-bold text-white uppercase tracking-wide">
                    {c.monitoring_status === "attivo" ? "Active" : "Analyzing"}
                  </span>
                </div>
                {/* Actions */}
                <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {c.ads_library_url && (
                    <a href={c.ads_library_url} target="_blank" rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="p-1.5 rounded-lg bg-black/45 backdrop-blur-sm text-white/90 hover:text-white transition-colors">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                  <button onClick={e => del(e, c.id)}
                    className="p-1.5 rounded-lg bg-black/45 backdrop-blur-sm text-white/90 hover:text-red-400 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Footer */}
              <div className="p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <div className="w-6 h-6 rounded-full bg-gradient-to-br from-orange-400 to-orange-600 flex items-center justify-center flex-shrink-0">
                    <span className="text-white font-bold text-[10px] uppercase">{c.name.charAt(0)}</span>
                  </div>
                  <p className="text-sm font-semibold text-foreground truncate">{c.name}</p>
                </div>
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1"><BarChart2 className="w-3.5 h-3.5" /> {c.ads_count}</span>
                  <span className="flex items-center gap-1"><ImageIcon className="w-3.5 h-3.5" /> {c.image_count}</span>
                  <span className="flex items-center gap-1"><Video className="w-3.5 h-3.5" /> {c.video_count}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add Competitor</DialogTitle></DialogHeader>
          <form onSubmit={add} className="space-y-4 mt-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Domain / Name *</label>
              <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                placeholder="E.g. bioma.health, ProDentim…" className="text-sm" autoFocus />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Ads Library URL</label>
              <Input value={form.ads_library_url} onChange={e => setForm(p => ({ ...p, ads_library_url: e.target.value }))}
                placeholder="https://facebook.com/ads/library/…" className="text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground"># Ads to monitor</label>
                <Input type="number" min="1" value={form.scrape_count} onChange={e => setForm(p => ({ ...p, scrape_count: e.target.value }))} className="text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">Frequency</label>
                <select value={form.frequency} onChange={e => setForm(p => ({ ...p, frequency: e.target.value }))}
                  className="w-full text-sm border border-border rounded-md px-3 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-primary">
                  {[["once","Once"],["daily","Daily"],["every_3_days","Every 3 days"],["every_7_days","Every 7 days"]].map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={adding} className="bg-primary text-white gap-1.5">
                {adding ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Adding...</> : <><Plus className="w-3.5 h-3.5" /> Add</>}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── COMPETITOR DETAIL VIEW ──
function CompetitorDetail({ projectId, competitor, onBack }: { projectId: string; competitor: CompetitorWithStats; onBack: () => void }) {
  const { toast } = useToast();
  const [ads, setAds] = useState<CompetitorAd[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [adForm, setAdForm] = useState({ name: "", headline: "", hook: "", body_text: "" });
  const [fileLabel, setFileLabel] = useState("");
  const [detailAd, setDetailAd] = useState<CompetitorAd | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${competitor.id}/ads`);
      if (r.ok) setAds(await r.json());
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [competitor.id]);

  const uploadAd = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) { toast({ title: "Select a file", variant: "destructive" }); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      Object.entries(adForm).forEach(([k, v]) => fd.append(k, v));
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${competitor.id}/ads`, { method: "POST", body: fd });
      if (r.ok) {
        const ad = await r.json(); setAds(p => [...p, ad]);
        setUploadOpen(false); setAdForm({ name: "", headline: "", hook: "", body_text: "" }); setFileLabel("");
        toast({ title: "Ad added!" });
      }
    } catch { toast({ title: "Error", variant: "destructive" }); } finally { setUploading(false); }
  };

  const delAd = async (id: number) => {
    setAds(p => p.filter(a => a.id !== id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${competitor.id}/ads/${id}`, { method: "DELETE" });
    toast({ title: "Ad removed" });
  };

  const saveToTemplates = async (ids: number[]) => {
    if (ids.length === 0) return;
    setSaving(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${competitor.id}/ads/save-to-templates`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ad_ids: ids }),
      });
      if (r.ok) {
        const saved = await r.json();
        setSelected(new Set());
        toast({ title: `${saved.length} ad${saved.length > 1 ? "s" : ""} saved to templates!` });
      }
    } catch { toast({ title: "Save error", variant: "destructive" }); } finally { setSaving(false); }
  };

  const toggleSelect = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const filtered = ads
    .filter(a => filter === "all" || a.media_type === filter)
    .filter(a => !search || a.name.toLowerCase().includes(search.toLowerCase()) || a.headline.toLowerCase().includes(search.toLowerCase()) || a.hook.toLowerCase().includes(search.toLowerCase()));

  const allSelected = filtered.length > 0 && filtered.every(a => selected.has(a.id));
  const toggleAll = () => allSelected ? setSelected(new Set()) : setSelected(new Set(filtered.map(a => a.id)));

  const videoCount = ads.filter(a => a.media_type === "video").length;
  const imageCount = ads.filter(a => a.media_type === "image").length;
  const hooks = [...new Set(ads.map(a => a.hook).filter(Boolean))];
  const headlines = [...new Set(ads.map(a => a.headline).filter(Boolean))];

  return (
    <div className="space-y-5">
      {/* Breadcrumb */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" /> Competitor Library
          </button>
          <span className="text-muted-foreground">/</span>
          <span className="text-sm font-semibold text-foreground">{competitor.name}</span>
          {competitor.ads_library_url && (
            <a href={competitor.ads_library_url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors">
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
        <Button onClick={() => setUploadOpen(true)} className="bg-primary text-white gap-1.5 text-sm">
          <Upload className="w-4 h-4" /> Add Ad
        </Button>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Total creatives", value: ads.length, icon: BarChart2, color: "text-primary" },
          { label: "Images", value: imageCount, icon: ImageIcon, color: "text-blue-500" },
          { label: "Video", value: videoCount, icon: Video, color: "text-purple-500" },
          { label: "Unique hooks", value: hooks.length, icon: Globe, color: "text-orange-500" },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-card border border-border rounded-xl p-4 text-center">
            <Icon className={`w-5 h-5 mx-auto mb-1 ${color}`} />
            <p className="text-xl font-bold text-foreground">{value}</p>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
          </div>
        ))}
      </div>

      {/* Hooks & Headlines */}
      {(hooks.length > 0 || headlines.length > 0) && (
        <div className="grid grid-cols-2 gap-3">
          {hooks.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-amber-800 uppercase tracking-wide mb-2">Hooks Used</p>
              <div className="flex flex-wrap gap-1.5">
                {hooks.slice(0, 6).map(h => (
                  <span key={h} className="text-[10px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">{h}</span>
                ))}
                {hooks.length > 6 && <span className="text-[10px] text-amber-600">+{hooks.length - 6} more</span>}
              </div>
            </div>
          )}
          {headlines.length > 0 && (
            <div className="bg-sky-50 border border-sky-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-sky-800 uppercase tracking-wide mb-2">Headlines Used</p>
              <div className="flex flex-col gap-1">
                {headlines.slice(0, 4).map(h => (
                  <p key={h} className="text-[10px] text-sky-700 truncate">• {h}</p>
                ))}
                {headlines.length > 4 && <p className="text-[10px] text-sky-500">+{headlines.length - 4} more</p>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search creatives..." className="pl-8 h-8 text-sm" />
        </div>
        <div className="flex items-center gap-1 border border-border rounded-lg p-0.5 bg-muted/30">
          {(["all","image","video"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${f === filter ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {f === "all" ? "All" : f === "image" ? "Images" : "Video"}
            </button>
          ))}
        </div>
      </div>

      {/* ── SELECTION BAR (always visible when ads exist) ── */}
      {filtered.length > 0 && (
        <div className="flex items-center gap-3 bg-muted/30 border border-border rounded-xl px-4 py-2.5">
          <label className="flex items-center gap-2 cursor-pointer select-none" onClick={toggleAll}>
            {allSelected
              ? <CheckSquare className="w-4 h-4 text-primary" />
              : <Square className="w-4 h-4 text-muted-foreground" />}
            <span className="text-xs font-medium text-foreground">
              {allSelected ? "Deselect all" : "Select all"}
            </span>
          </label>
          {selected.size > 0 && (
            <span className="text-xs text-muted-foreground border-l border-border pl-3">{selected.size} selected</span>
          )}
          {selected.size > 0 && (
            <Button size="sm" onClick={() => saveToTemplates(Array.from(selected))} disabled={saving}
              className="ml-auto bg-sky-500 hover:bg-sky-600 text-white gap-1.5 h-8 text-xs px-4">
              {saving
                ? <><RefreshCw className="w-3 h-3 animate-spin" /> Saving...</>
                : <><Bookmark className="w-3.5 h-3.5" /> Import to templates ({selected.size})</>}
            </Button>
          )}
        </div>
      )}

      {/* Ads grid */}
      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="py-20 text-center border-2 border-dashed border-border rounded-2xl">
          <BarChart2 className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-semibold text-foreground mb-1">No ads found</p>
          <p className="text-xs text-muted-foreground mb-4">{search ? "Try a different search." : "Upload this competitor's ads."}</p>
          {!search && (
            <Button size="sm" onClick={() => setUploadOpen(true)} className="bg-primary text-white gap-1.5">
              <Upload className="w-3.5 h-3.5" /> Add Ad
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
          {filtered.map((ad, idx) => {
            const isSelected = selected.has(ad.id);
            const hasFile = !!ad.file_path;
            return (
              <div key={ad.id}
                className={`group relative rounded-2xl overflow-hidden bg-card border-2 transition-all duration-200 cursor-pointer
                  ${isSelected ? "border-primary shadow-[0_0_0_3px_rgba(34,197,94,0.2)]" : "border-transparent hover:border-border hover:shadow-lg"}`}
                onClick={() => setDetailAd(ad)}>

                {/* Thumbnail / Placeholder */}
                <div className="aspect-[4/5] relative overflow-hidden rounded-xl">
                  {hasFile ? (
                    ad.media_type === "video" ? (
                      <div className="w-full h-full relative bg-gradient-to-br from-slate-700 to-slate-900">
                        <video src={getUploadUrl(ad.file_path)} muted playsInline preload="metadata"
                          className="w-full h-full object-cover" />
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <div className="w-11 h-11 rounded-full bg-black/50 flex items-center justify-center">
                            <Play className="w-5 h-5 text-white" />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <img src={getUploadUrl(ad.file_path)} alt={ad.name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                    )
                  ) : (
                    <AdPlaceholder ad={ad} index={idx} />
                  )}

                  {/* ── CHECKBOX (always visible top-right) ── */}
                  <button
                    onClick={e => toggleSelect(ad.id, e)}
                    className={`absolute top-2 right-2 z-10 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all
                      ${isSelected
                        ? "bg-primary border-primary shadow-md"
                        : "bg-white/80 border-white/60 shadow-sm hover:border-primary/60 hover:bg-white"}`}>
                    {isSelected && (
                      <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>

                  {/* Active badge */}
                  {ad.is_active === "true" && (
                    <div className="absolute top-2 left-2">
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-green-500 text-white shadow-sm">ACTIVE</span>
                    </div>
                  )}

                  {/* Hover overlay — "Save template" */}
                  <div className="absolute inset-x-0 bottom-0 opacity-0 group-hover:opacity-100 transition-opacity p-2">
                    <button
                      onClick={e => { e.stopPropagation(); saveToTemplates([ad.id]); }}
                      className="w-full flex items-center justify-center gap-1.5 bg-sky-500 text-white text-[10px] font-bold py-2 rounded-lg hover:bg-sky-600 transition-colors shadow-lg">
                      <Bookmark className="w-3 h-3" /> Save template
                    </button>
                  </div>
                </div>

                {/* Footer card */}
                <div className="px-2 py-2 space-y-0.5">
                  <p className="text-xs font-semibold text-foreground truncate leading-tight">
                    {ad.headline || ad.name || "Ad"}
                  </p>
                  {ad.hook && (
                    <p className="text-[10px] text-muted-foreground truncate">{ad.hook}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Ad detail side panel */}
      {detailAd && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/40" onClick={() => setDetailAd(null)} />
          <div className="w-80 bg-card border-l border-border h-full overflow-y-auto shadow-2xl flex flex-col">
            <div className="p-4 border-b border-border flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">Ad Detail</span>
              <button onClick={() => setDetailAd(null)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 border-b border-border space-y-2">
              <Button onClick={() => { saveToTemplates([detailAd.id]); setDetailAd(null); }}
                className="w-full bg-sky-500 hover:bg-sky-600 text-white gap-2">
                <Bookmark className="w-4 h-4" /> Add to my templates
              </Button>
              {detailAd.file_path && (
                <Button variant="outline" onClick={() => downloadCreative(detailAd)}
                  className="w-full gap-2">
                  <Download className="w-4 h-4" /> Download {detailAd.media_type === "video" ? "video" : "image"}
                </Button>
              )}
            </div>
            {/* Preview */}
            <div className="p-4 border-b border-border">
              {detailAd.file_path ? (
                detailAd.media_type === "video"
                  ? <video src={getUploadUrl(detailAd.file_path)} controls playsInline preload="metadata"
                      className="w-full rounded-xl bg-black max-h-72" />
                  : <img src={getUploadUrl(detailAd.file_path)} alt={detailAd.name} className="w-full rounded-xl object-contain max-h-72" />
              ) : (
                <div className="aspect-[4/5] rounded-xl overflow-hidden max-h-48">
                  <AdPlaceholder ad={detailAd} index={ads.indexOf(detailAd)} />
                </div>
              )}
            </div>
            {/* Details */}
            <div className="p-4 space-y-4 flex-1">
              <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-semibold">Creative Content</p>
              {detailAd.headline && (
                <div>
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Headline</p>
                  <p className="text-sm font-semibold text-foreground">{detailAd.headline}</p>
                </div>
              )}
              {detailAd.hook && (
                <div>
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Hook</p>
                  <p className="text-sm text-foreground">{detailAd.hook}</p>
                </div>
              )}
              {detailAd.body_text && (
                <div>
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">
                    {detailAd.media_type === "video" ? "Transcript" : "Body Text"}
                  </p>
                  <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto pr-1">{detailAd.body_text}</p>
                </div>
              )}
              <div className="pt-2 border-t border-border space-y-2">
                <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-semibold">Specs</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Format</p>
                    <p className="font-medium text-foreground capitalize">{detailAd.media_type}</p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Status</p>
                    <p className={`font-medium ${detailAd.is_active === "true" ? "text-green-600" : "text-muted-foreground"}`}>
                      {detailAd.is_active === "true" ? "Active" : "Inactive"}
                    </p>
                  </div>
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-border">
              <button onClick={() => { delAd(detailAd.id); setDetailAd(null); }}
                className="w-full text-xs text-destructive hover:bg-destructive/5 py-2 rounded-lg transition-colors flex items-center justify-center gap-1.5">
                <Trash2 className="w-3.5 h-3.5" /> Remove ad
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upload dialog */}
      <Dialog open={uploadOpen} onOpenChange={v => { setUploadOpen(v); if (!v) { setAdForm({ name: "", headline: "", hook: "", body_text: "" }); setFileLabel(""); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add Ad — {competitor.name}</DialogTitle></DialogHeader>
          <form onSubmit={uploadAd} className="space-y-3 mt-2">
            <div className="border-2 border-dashed border-border rounded-xl p-4 text-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors"
              onClick={() => fileRef.current?.click()}>
              <Upload className="w-6 h-6 text-muted-foreground mx-auto mb-1" />
              <p className="text-xs text-muted-foreground">{fileLabel || "Click to select (image or video)"}</p>
              <input ref={fileRef} type="file" accept="image/*,video/*" className="hidden" onChange={() => {
                const f = fileRef.current?.files?.[0];
                if (f) { setFileLabel(f.name); if (!adForm.name) setAdForm(p => ({ ...p, name: f.name.replace(/\.[^.]+$/, "") })); }
              }} />
            </div>
            {[
              { label: "Name", key: "name", placeholder: "E.g. Health starts in the gut" },
              { label: "Headline", key: "headline", placeholder: "Ad headline text..." },
              { label: "Hook", key: "hook", placeholder: "E.g. How's your gut really doing?" },
              { label: "Body text", key: "body_text", placeholder: "Main ad copy..." },
            ].map(({ label, key, placeholder }) => (
              <div key={key} className="space-y-1">
                <label className="text-xs font-medium text-foreground">{label}</label>
                <Input value={adForm[key as keyof typeof adForm]} onChange={e => setAdForm(p => ({ ...p, [key]: e.target.value }))}
                  placeholder={placeholder} className="text-sm" />
              </div>
            ))}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={uploading} className="bg-primary text-white gap-1.5">
                {uploading ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Uploading...</> : <><Upload className="w-3.5 h-3.5" /> Add</>}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── MAIN EXPORT ──
type Tab = "ads" | "funnel";

export function CompetitorLibrarySection({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<Tab>("ads");
  const [selected, setSelected] = useState<CompetitorWithStats | null>(null);

  // If viewing a competitor detail, stay in ads view regardless
  if (selected) {
    return (
      <div className="space-y-4">
        {/* Tab bar */}
        <div className="flex items-center gap-1 border-b border-border pb-0">
          {([
            { id: "ads" as Tab, label: "Ads Library", icon: BarChart2 },
            { id: "funnel" as Tab, label: "Funnel Monitoring", icon: TrendingUp },
          ] as const).map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => { setTab(id); setSelected(null); }}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px
                ${tab === id || id === "ads"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}>
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>
        <CompetitorDetail projectId={projectId} competitor={selected} onBack={() => setSelected(null)} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border pb-0">
        {([
          { id: "ads" as Tab, label: "Ads Library", icon: BarChart2 },
          { id: "funnel" as Tab, label: "Funnel Monitoring", icon: TrendingUp },
        ] as const).map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px
              ${tab === id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}>
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {tab === "ads" && <CompetitorList projectId={projectId} onSelect={setSelected} />}
      {tab === "funnel" && <FunnelMonitoringSection projectId={projectId} />}
    </div>
  );
}
