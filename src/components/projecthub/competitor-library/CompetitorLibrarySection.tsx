import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import {
  Plus, Trash2, Upload, Play, Search, ArrowLeft, ExternalLink,
  BarChart2, Calendar, Globe, X, RefreshCw, Image as ImageIcon,
  Video, Bookmark, CheckSquare, Square, TrendingUp, Download, Copy, Check,
  Settings, Zap, FileText, Eye, LayoutTemplate, Repeat, Star, Flame,
  Scissors, Film, Sparkles,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { FunnelMonitoringSection } from "./FunnelMonitoringSection";
import { getUploadUrl } from "@/lib/projecthub-storage";
import { getSupabaseBrowser } from "@/lib/supabase-browser";

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
  previews?: { file_path: string; media_type: string }[];
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
  // Phase 1 winner signals (from Meta Ad Library via Apify) + manual override.
  ad_started_at?: string | null;
  ad_active?: string;
  ad_variants?: number;
  is_winner?: boolean;
  // Phase 1: Claude-rewritten script adapted to the user's product.
  rewritten_script?: string | null;
};

function formatDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" });
}

// ── Winner detection (Phase 1) ──────────────────────────────────────────────
// A creative is a likely "winner" when it has been running for a long time and
// is still live — advertisers cut losers fast, so longevity is the cheapest
// proxy for performance. A manual flag always wins.
const WINNER_DAYS = 21;
const PROMISING_DAYS = 10;

function daysRunning(ad: CompetitorAd): number | null {
  if (!ad.ad_started_at) return null;
  const t = new Date(ad.ad_started_at).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

type WinnerTier = "winner" | "promising" | null;

function winnerTier(ad: CompetitorAd): WinnerTier {
  if (ad.is_winner) return "winner";
  const active = ad.ad_active === "true" || ad.is_active === "true";
  const d = daysRunning(ad);
  if (d !== null && active) {
    if (d >= WINNER_DAYS) return "winner";
    if (d >= PROMISING_DAYS) return "promising";
  }
  return null;
}

function WinnerBadge({ ad, className = "" }: { ad: CompetitorAd; className?: string }) {
  const tier = winnerTier(ad);
  if (!tier) return null;
  const d = daysRunning(ad);
  const label = tier === "winner" ? "WINNER" : "PROMISING";
  const cls = tier === "winner"
    ? "bg-amber-400 text-amber-950"
    : "bg-sky-400 text-sky-950";
  return (
    <span
      title={d !== null ? `Running ${d} day${d === 1 ? "" : "s"}${ad.is_winner ? " · marked as winner" : ""}` : "Marked as winner"}
      className={`inline-flex items-center gap-0.5 text-[9px] font-black px-1.5 py-0.5 rounded-full shadow-sm ${cls} ${className}`}>
      {tier === "winner" ? "🔥" : "⭐"} {label}
    </span>
  );
}

// PATCH a creative's manual winner flag. Returns the updated flag or null.
async function setWinnerFlag(projectId: string, brandId: number, adId: number, next: boolean): Promise<boolean | null> {
  try {
    const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${brandId}/ads/${adId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_winner: next }),
    });
    if (!r.ok) return null;
    return next;
  } catch { return null; }
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

// Small media thumbnail: image, or video first-frame with a play badge.
function MediaThumb({ path, type, className = "" }: { path: string; type: string; className?: string }) {
  if (!path) {
    return <div className={`bg-slate-800 flex items-center justify-center ${className}`}><Globe className="w-6 h-6 text-white/20" /></div>;
  }
  if (type === "video") {
    return (
      <div className={`relative bg-slate-900 ${className}`}>
        <video src={getUploadUrl(path)} muted playsInline preload="metadata" className="w-full h-full object-cover" />
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-8 h-8 rounded-full bg-black/50 flex items-center justify-center"><Play className="w-3.5 h-3.5 text-white" /></div>
        </div>
      </div>
    );
  }
  return <img src={getUploadUrl(path)} alt="" className={`object-cover ${className}`} />;
}

// Up to 4 creatives shown as a 1/2/4-up mosaic for the competitor card.
function Mosaic({ items }: { items: { file_path: string; media_type: string }[] }) {
  const list = items.slice(0, 4);
  if (list.length <= 1) {
    const it = list[0];
    return <MediaThumb path={it?.file_path || ""} type={it?.media_type || ""} className="w-full h-full" />;
  }
  return (
    <div className={`grid w-full h-full gap-0.5 ${list.length === 2 ? "grid-cols-2" : "grid-cols-2 grid-rows-2"}`}>
      {list.map((it, i) => (
        <MediaThumb key={i} path={it.file_path} type={it.media_type} className="w-full h-full" />
      ))}
    </div>
  );
}

// A real-footage "shot" cut from a competitor video by the local ffmpeg worker.
type Shot = {
  id: number;
  ad_id: number;
  brand_id: number;
  file_path: string;
  thumb_path?: string | null;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  width?: number | null;
  height?: number | null;
  has_text?: boolean | null;
  text_region?: string | null;
  label?: string | null;
  caption?: string | null;
  tags?: string[] | null;
  section?: string | null;
  clean_path?: string | null;
  inpaint_status?: string | null;
  inpaint_error?: string | null;
};

// Grid of shots extracted from one creative. Click a card to preview the clip;
// badges flag whether the shot carries the competitor's burned-in subtitles.
function ShotsGrid({
  projectId, ad, onClose,
}: {
  projectId: string;
  ad: CompetitorAd;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [shots, setShots] = useState<Shot[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<Shot | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/projecthub/projects/${projectId}/shots?adId=${ad.id}`);
      const j = await r.json().catch(() => []);
      setShots(Array.isArray(j) ? j : []);
    } catch { setShots([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ad.id]);

  const remove = async (s: Shot) => {
    setShots((p) => p.filter((x) => x.id !== s.id));
    try {
      await fetch(`/api/projecthub/projects/${projectId}/shots/${s.id}`, { method: "DELETE" });
    } catch { toast({ title: "Delete failed", variant: "destructive" }); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-4xl max-h-[85vh] bg-card border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Film className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">Real footage shots</span>
            <span className="text-xs text-muted-foreground">({shots.length})</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-muted-foreground py-10 text-center">Loading shots…</p>
          ) : shots.length === 0 ? (
            <p className="text-sm text-muted-foreground py-10 text-center">
              No shots yet. Use “Split into shots” — the local ffmpeg worker must be running.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {shots.map((s) => {
                const hasText = s.has_text === true;
                return (
                  <div key={s.id} className="group relative rounded-xl overflow-hidden border border-border bg-black/5">
                    <button onClick={() => setPlaying(s)} className="block w-full aspect-[9/16] bg-black">
                      {s.thumb_path
                        ? <img src={getUploadUrl(s.thumb_path)} alt="" className="w-full h-full object-cover" />
                        : <div className="w-full h-full flex items-center justify-center text-white/40"><Play className="w-6 h-6" /></div>}
                    </button>
                    <span className="absolute top-1.5 left-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-black/70 text-white">
                      {s.duration_sec}s
                    </span>
                    <span
                      title={hasText
                        ? "Has burned-in subtitles — excluded from builds (needs AI inpainting to remove)"
                        : "Clean (no subtitles detected)"}
                      className={`absolute top-1.5 right-1.5 text-[9px] font-black px-1.5 py-0.5 rounded-full ${hasText ? "bg-rose-500 text-white" : "bg-emerald-500 text-white"}`}>
                      {hasText ? "SUBS" : "CLEAN"}
                    </span>
                    <button
                      onClick={() => remove(s)}
                      className="absolute bottom-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-black/70 text-white rounded-md p-1"
                      title="Delete shot">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {playing && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-6" onClick={() => setPlaying(null)}>
          <div className="absolute inset-0 bg-black/80" />
          <video
            src={getUploadUrl(playing.file_path)}
            controls autoPlay loop playsInline
            className="relative max-h-[80vh] max-w-full rounded-xl bg-black"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

// Shared right-side detail panel for a single creative (image or video),
// with player, download, transcript + copy, and delete. Reused by the
// per-competitor view and the flat "All creatives" view.
function CreativeDetailPanel({
  ad, placeholderIndex, brandName, projectId, onClose, onSaveTemplate, onDelete, onTranscribed, onWinnerChange,
}: {
  ad: CompetitorAd;
  placeholderIndex: number;
  brandName?: string;
  projectId: string;
  onClose: () => void;
  onSaveTemplate: (id: number) => void;
  onDelete: (id: number) => void;
  onTranscribed?: (adId: number, text: string) => void;
  onWinnerChange?: (adId: number, isWinner: boolean) => void;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState(ad.body_text || "");
  const [transcribing, setTranscribing] = useState(false);
  const [winner, setWinner] = useState(!!ad.is_winner);
  const [markingWinner, setMarkingWinner] = useState(false);
  // Phase 1 — "same script, new video": rewrite the winning transcript for the
  // user's own product.
  const [product, setProduct] = useState("");
  const [angle, setAngle] = useState("");
  const [generating, setGenerating] = useState(false);
  const [script, setScript] = useState(ad.rewritten_script || "");
  const [scriptCopied, setScriptCopied] = useState(false);
  const generateScript = async () => {
    setGenerating(true);
    try {
      const r = await fetch(
        `/api/projecthub/projects/${projectId}/competitor-library/${ad.brand_id}/ads/${ad.id}/rewrite-script`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product, angle }),
        },
      );
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.script) {
        setScript(j.script);
        toast({ title: "Script generated ✓" });
      } else {
        toast({ title: j.error || "Generation failed", variant: "destructive" });
      }
    } catch { toast({ title: "Generation failed", variant: "destructive" }); }
    finally { setGenerating(false); }
  };
  const copyScript = async () => {
    try {
      await navigator.clipboard.writeText(script);
      setScriptCopied(true);
      setTimeout(() => setScriptCopied(false), 1500);
    } catch { toast({ title: "Copy failed", variant: "destructive" }); }
  };
  // Phase 2 — split competitor video into real-footage shots.
  const [segStatus, setSegStatus] = useState<string>("");
  const [shotCount, setShotCount] = useState(0);
  const [showShots, setShowShots] = useState(false);
  const segPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadSegStatus = async () => {
    try {
      const r = await fetch(`/api/projecthub/projects/${projectId}/competitor-library/${ad.brand_id}/ads/${ad.id}/segment`);
      const j = await r.json().catch(() => ({}));
      setSegStatus(j?.job?.status || "");
      setShotCount(j?.shots || 0);
      if (j?.job?.status === "pending" || j?.job?.status === "processing") {
        if (!segPoll.current) segPoll.current = setInterval(loadSegStatus, 4000);
      } else if (segPoll.current) {
        clearInterval(segPoll.current); segPoll.current = null;
      }
    } catch { /* ignore */ }
  };
  useEffect(() => {
    if (ad.media_type === "video") loadSegStatus();
    return () => { if (segPoll.current) { clearInterval(segPoll.current); segPoll.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ad.id]);
  const splitIntoShots = async () => {
    setSegStatus("pending");
    try {
      const r = await fetch(`/api/projecthub/projects/${projectId}/competitor-library/${ad.brand_id}/ads/${ad.id}/segment`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        toast({ title: j.queued === false ? "Already queued" : "Queued for splitting", description: "The local ffmpeg worker will process it." });
        if (!segPoll.current) segPoll.current = setInterval(loadSegStatus, 4000);
      } else {
        setSegStatus("");
        toast({ title: j.error || "Could not queue", variant: "destructive" });
      }
    } catch { setSegStatus(""); toast({ title: "Could not queue", variant: "destructive" }); }
  };
  // Phase 2 step 2 — recreate a new video from clean shots + our voice.
  const [buildStatus, setBuildStatus] = useState<string>("");
  const [buildVideos, setBuildVideos] = useState<{ id: number; file_path: string; thumb_path?: string | null; duration_sec: number }[]>([]);
  // Show the finished video inline only right after a build done in THIS session;
  // otherwise it lives permanently in the "New Creatives" tab, not pinned here.
  const [showInline, setShowInline] = useState(false);
  const [voice, setVoice] = useState("alloy");
  const [previewVoiceLoading, setPreviewVoiceLoading] = useState(false);
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const previewVoice = async (v: string) => {
    try {
      if (previewAudio.current) { previewAudio.current.pause(); previewAudio.current = null; }
      setPreviewVoiceLoading(true);
      const r = await fetch(`/api/tts-sample?voice=${encodeURIComponent(v)}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast({ title: j.error || "Voice preview failed", variant: "destructive" });
        return;
      }
      const blob = await r.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      previewAudio.current = audio;
      audio.onended = () => { if (previewAudio.current === audio) previewAudio.current = null; };
      await audio.play();
    } catch {
      toast({ title: "Voice preview failed", variant: "destructive" });
    } finally {
      setPreviewVoiceLoading(false);
    }
  };
  useEffect(() => () => { if (previewAudio.current) previewAudio.current.pause(); }, []);
  const buildPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadBuildStatus = async () => {
    try {
      const r = await fetch(`/api/projecthub/projects/${projectId}/competitor-library/${ad.brand_id}/ads/${ad.id}/build-video`);
      const j = await r.json().catch(() => ({}));
      setBuildStatus(j?.job?.status || "");
      setBuildVideos(Array.isArray(j?.videos) ? j.videos : []);
      if (j?.job?.status === "pending" || j?.job?.status === "processing") {
        if (!buildPoll.current) buildPoll.current = setInterval(loadBuildStatus, 5000);
      } else if (buildPoll.current) { clearInterval(buildPoll.current); buildPoll.current = null; }
    } catch { /* ignore */ }
  };
  useEffect(() => {
    if (ad.media_type === "video") loadBuildStatus();
    return () => { if (buildPoll.current) { clearInterval(buildPoll.current); buildPoll.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ad.id]);
  const buildVideo = async () => {
    setBuildStatus("pending");
    setShowInline(true);
    try {
      const r = await fetch(`/api/projecthub/projects/${projectId}/competitor-library/${ad.brand_id}/ads/${ad.id}/build-video`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        toast({
          title: j.queued === false ? "Already building" : "Queued for build",
          description: `${j.scenes || ""} scenes — real clean footage only.`,
        });
        if (!buildPoll.current) buildPoll.current = setInterval(loadBuildStatus, 5000);
      } else {
        setBuildStatus("");
        toast({ title: j.error || "Could not start build", variant: "destructive" });
      }
    } catch { setBuildStatus(""); toast({ title: "Could not start build", variant: "destructive" }); }
  };
  const days = daysRunning(ad);
  const tier = winnerTier({ ...ad, is_winner: winner });
  const toggleWinner = async () => {
    const next = !winner;
    setMarkingWinner(true);
    const res = await setWinnerFlag(projectId, ad.brand_id, ad.id, next);
    setMarkingWinner(false);
    if (res === null) { toast({ title: "Could not update", variant: "destructive" }); return; }
    setWinner(next);
    onWinnerChange?.(ad.id, next);
    toast({ title: next ? "Marked as winner 🔥" : "Winner mark removed" });
  };
  const copyTranscript = async (t: string) => {
    try {
      await navigator.clipboard.writeText(t);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { toast({ title: "Copy failed", variant: "destructive" }); }
  };
  const transcribe = async () => {
    setTranscribing(true);
    try {
      const r = await fetch(`/api/projecthub/projects/${projectId}/competitor-library/${ad.brand_id}/ads/${ad.id}/transcribe`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.body_text) {
        setText(j.body_text);
        onTranscribed?.(ad.id, j.body_text);
        toast({ title: "Transcript ready" });
      } else {
        toast({ title: j.error || "Transcription failed", variant: "destructive" });
      }
    } catch { toast({ title: "Transcription failed", variant: "destructive" }); }
    finally { setTranscribing(false); }
  };
  return (
    <>
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-80 bg-card border-l border-border h-full overflow-y-auto shadow-2xl flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div className="min-w-0">
            <span className="text-sm font-semibold text-foreground">Creative Detail</span>
            {brandName && <p className="text-[11px] text-muted-foreground truncate">{brandName}</p>}
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 border-b border-border space-y-2">
          <Button onClick={() => onSaveTemplate(ad.id)} className="w-full bg-sky-500 hover:bg-sky-600 text-white gap-2">
            <Bookmark className="w-4 h-4" /> Add to my templates
          </Button>
          {ad.file_path && (
            <Button variant="outline" onClick={() => downloadCreative(ad)} className="w-full gap-2">
              <Download className="w-4 h-4" /> Download {ad.media_type === "video" ? "video" : "image"}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={toggleWinner}
            disabled={markingWinner}
            className={`w-full gap-2 ${winner ? "border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100" : ""}`}>
            <Star className={`w-4 h-4 ${winner ? "fill-amber-400 text-amber-500" : ""}`} />
            {winner ? "Winner ✓ — click to unmark" : "Mark as winner"}
          </Button>
        </div>
        <div className="p-4 border-b border-border">
          {ad.file_path ? (
            ad.media_type === "video"
              ? <video src={getUploadUrl(ad.file_path)} controls playsInline preload="metadata" className="w-full rounded-xl bg-black max-h-72" />
              : <img src={getUploadUrl(ad.file_path)} alt={ad.name} className="w-full rounded-xl object-contain max-h-72" />
          ) : (
            <div className="aspect-[4/5] rounded-xl overflow-hidden max-h-48">
              <AdPlaceholder ad={ad} index={placeholderIndex} />
            </div>
          )}
        </div>
        <div className="p-4 space-y-4 flex-1">
          <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-semibold">Creative Content</p>
          {ad.headline && (
            <div>
              <p className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Headline</p>
              <p className="text-sm font-semibold text-foreground">{ad.headline}</p>
            </div>
          )}
          {ad.hook && (
            <div>
              <p className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Hook</p>
              <p className="text-sm text-foreground">{ad.hook}</p>
            </div>
          )}
          {ad.media_type === "video" ? (
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Transcript</p>
                <div className="flex items-center gap-2">
                  {text && (
                    <button onClick={() => copyTranscript(text)}
                      className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground hover:text-primary transition-colors">
                      {copied ? <><Check className="w-3 h-3 text-green-600" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
                    </button>
                  )}
                  <button onClick={transcribe} disabled={transcribing}
                    className="flex items-center gap-1 text-[10px] font-semibold text-primary hover:underline disabled:opacity-60">
                    {transcribing
                      ? <><RefreshCw className="w-3 h-3 animate-spin" /> Extracting…</>
                      : <><FileText className="w-3 h-3" /> {text ? "Re-transcribe" : "Extract text"}</>}
                  </button>
                </div>
              </div>
              {text
                ? <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto pr-1">{text}</p>
                : <p className="text-[11px] text-muted-foreground">No transcript yet. Click “Extract text” to transcribe (works for long videos too).</p>}
            </div>
          ) : text ? (
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Body Text</p>
                <button onClick={() => copyTranscript(text)}
                  className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground hover:text-primary transition-colors">
                  {copied ? <><Check className="w-3 h-3 text-green-600" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
                </button>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto pr-1">{text}</p>
            </div>
          ) : null}
          {text && (
            <div className="pt-2 border-t border-border space-y-2">
              <div className="flex items-center gap-1.5">
                <Repeat className="w-3.5 h-3.5 text-primary" />
                <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-semibold">Rewrite for my product</p>
              </div>
              <p className="text-[10px] text-muted-foreground leading-snug">
                Reuse this winner’s proven structure and hook, rewritten in fresh words for your offer.
              </p>
              <Input
                value={product}
                onChange={(e) => setProduct(e.target.value)}
                placeholder="Your product / offer (e.g. GreenGut probiotic)"
                className="h-8 text-xs"
              />
              <Input
                value={angle}
                onChange={(e) => setAngle(e.target.value)}
                placeholder="Angle (optional, e.g. bloating relief)"
                className="h-8 text-xs"
              />
              <Button onClick={generateScript} disabled={generating} className="w-full gap-2 h-8">
                {generating
                  ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Generating…</>
                  : <><Zap className="w-3.5 h-3.5" /> {script ? "Regenerate script" : "Generate my script"}</>}
              </Button>
              {script && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">My script</p>
                    <button onClick={copyScript}
                      className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground hover:text-primary transition-colors">
                      {scriptCopied ? <><Check className="w-3 h-3 text-green-600" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
                    </button>
                  </div>
                  <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto pr-1 bg-muted/40 rounded-lg p-2">{script}</p>
                </div>
              )}
            </div>
          )}
          {ad.media_type === "video" && (
            <div className="pt-2 border-t border-border space-y-2">
              <div className="flex items-center gap-1.5">
                <Scissors className="w-3.5 h-3.5 text-primary" />
                <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-semibold">Real footage shots</p>
              </div>
              <p className="text-[10px] text-muted-foreground leading-snug">
                Split this video into individual shots (audio removed) to reuse as real B-roll. Runs on the server — may take a minute or two.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  onClick={splitIntoShots}
                  disabled={segStatus === "pending" || segStatus === "processing"}
                  variant="outline"
                  className="flex-1 gap-2 h-8">
                  {segStatus === "pending" || segStatus === "processing"
                    ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> {segStatus === "pending" ? "Queued…" : "Splitting…"}</>
                    : <><Scissors className="w-3.5 h-3.5" /> {shotCount > 0 ? "Re-split" : "Split into shots"}</>}
                </Button>
                {shotCount > 0 && (
                  <Button onClick={() => setShowShots(true)} className="gap-2 h-8">
                    <Film className="w-3.5 h-3.5" /> {shotCount} shots
                  </Button>
                )}
              </div>
              {segStatus === "error" && (
                <p className="text-[10px] text-destructive">Splitting failed — check the worker logs.</p>
              )}
            </div>
          )}
          {ad.media_type === "video" && (
            <div className="pt-2 border-t border-border space-y-2">
              <div className="flex items-center gap-1.5">
                <Film className="w-3.5 h-3.5 text-primary" />
                <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-semibold">Recreate video (real footage)</p>
              </div>
              <p className="text-[10px] text-muted-foreground leading-snug">
                Assembles a new video from your CLEAN shots + a voiceover of your script + your subtitles. Uses the rewritten script if present. Runs on the server (needs an OpenAI key for the voice).
              </p>
              <div className="flex items-center gap-2">
                <select
                  value={voice}
                  onChange={(e) => { setVoice(e.target.value); previewVoice(e.target.value); }}
                  className="h-8 text-xs rounded-md border border-border bg-background px-2 flex-1">
                  {["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map((v) => (
                    <option key={v} value={v}>{`Voice: ${v}`}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => previewVoice(voice)}
                  disabled={previewVoiceLoading}
                  title="Preview this voice"
                  className="h-8 w-8 shrink-0 grid place-items-center rounded-md border border-border bg-background hover:bg-muted disabled:opacity-50">
                  {previewVoiceLoading
                    ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    : <Play className="w-3.5 h-3.5" />}
                </button>
                <Button
                  onClick={buildVideo}
                  disabled={buildStatus === "pending" || buildStatus === "processing"}
                  className="gap-2 h-8">
                  {buildStatus === "pending" || buildStatus === "processing"
                    ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> {buildStatus === "pending" ? "Queued…" : "Building…"}</>
                    : <><Zap className="w-3.5 h-3.5" /> Build video</>}
                </Button>
              </div>
              {buildStatus === "error" && (
                <p className="text-[10px] text-destructive">Build failed — check the worker logs.</p>
              )}
              {showInline && buildStatus !== "pending" && buildStatus !== "processing" && buildVideos[0] && (
                <div className="space-y-1.5 pt-1">
                  <div className="rounded-lg overflow-hidden border border-border bg-black/5">
                    <video src={getUploadUrl(buildVideos[0].file_path)} controls playsInline preload="metadata" className="w-full bg-black max-h-64" />
                    <div className="flex items-center justify-between px-2 py-1.5">
                      <span className="text-[10px] text-muted-foreground">{Math.round(buildVideos[0].duration_sec)}s · new creative</span>
                      <button onClick={() => downloadCreative({ file_path: buildVideos[0].file_path, name: "recreated", media_type: "video" })}
                        className="flex items-center gap-1 text-[10px] font-semibold text-primary hover:underline">
                        <Download className="w-3 h-3" /> Download
                      </button>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-primary" /> Saved to the <b>New Creatives</b> tab.
                  </p>
                </div>
              )}
            </div>
          )}
          <div className="pt-2 border-t border-border space-y-2">
            <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-semibold">Performance signals</p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Format</p>
                <p className="font-medium text-foreground capitalize">{ad.media_type}</p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Status</p>
                <p className={`font-medium ${(ad.ad_active === "true" || ad.is_active === "true") ? "text-green-600" : "text-muted-foreground"}`}>
                  {(ad.ad_active === "true" || ad.is_active === "true") ? "Active" : "Inactive"}
                </p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Running for</p>
                <p className="font-medium text-foreground">{days !== null ? `${days} day${days === 1 ? "" : "s"}` : "—"}</p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Verdict</p>
                <p className="font-medium">
                  {tier === "winner"
                    ? <span className="text-amber-600 inline-flex items-center gap-1"><Flame className="w-3 h-3" /> Winner</span>
                    : tier === "promising"
                      ? <span className="text-sky-600 inline-flex items-center gap-1"><Star className="w-3 h-3" /> Promising</span>
                      : <span className="text-muted-foreground">—</span>}
                </p>
              </div>
              {typeof ad.ad_variants === "number" && ad.ad_variants > 1 && (
                <div>
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Variants</p>
                  <p className="font-medium text-foreground">{ad.ad_variants}</p>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="p-4 border-t border-border">
          <button onClick={() => onDelete(ad.id)}
            className="w-full text-xs text-destructive hover:bg-destructive/5 py-2 rounded-lg transition-colors flex items-center justify-center gap-1.5">
            <Trash2 className="w-3.5 h-3.5" /> Remove creative
          </button>
        </div>
      </div>
    </div>
    {showShots && <ShotsGrid projectId={projectId} ad={ad} onClose={() => setShowShots(false)} />}
    </>
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

              {/* Preview mosaic */}
              <div className="aspect-[4/3] relative overflow-hidden bg-gradient-to-br from-slate-800 to-slate-900">
                <Mosaic items={c.previews && c.previews.length ? c.previews : (c.preview_path ? [{ file_path: c.preview_path, media_type: c.preview_type || "" }] : [])} />
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
  const [winnersOnly, setWinnersOnly] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [adForm, setAdForm] = useState({ name: "", headline: "", hook: "", body_text: "" });
  const [fileLabel, setFileLabel] = useState("");
  const [detailAd, setDetailAd] = useState<CompetitorAd | null>(null);
  const [scraping, setScraping] = useState(false);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);
  const [libUrl, setLibUrl] = useState(competitor.ads_library_url || "");
  const [cfg, setCfg] = useState({
    ads_library_url: competitor.ads_library_url || "",
    frequency: competitor.frequency || "every_7_days",
    is_active: competitor.is_active !== "false",
  });

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${competitor.id}/ads`);
      if (r.ok) setAds(await r.json());
    } finally { setLoading(false); }
  };

  const scrapeNow = async () => {
    if (!libUrl) { setCfgOpen(true); toast({ title: "Add the Ad Library URL first" }); return; }
    setScraping(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${competitor.id}/scrape`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        toast({ title: "Scraping started", description: "New creatives will appear here in ~1 min." });
        setTimeout(load, 60000);
      } else {
        toast({ title: j.error || "Could not start scraping", variant: "destructive" });
      }
    } finally { setScraping(false); }
  };

  const saveCfg = async () => {
    setSavingCfg(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${competitor.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ads_library_url: cfg.ads_library_url,
          frequency: cfg.frequency,
          is_active: cfg.is_active ? "true" : "false",
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setLibUrl(cfg.ads_library_url);
        setCfgOpen(false);
        toast({ title: "Settings saved" });
      } else {
        toast({ title: j.error || "Save failed", variant: "destructive" });
      }
    } finally { setSavingCfg(false); }
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

  const tierRank = (a: CompetitorAd) => { const t = winnerTier(a); return t === "winner" ? 0 : t === "promising" ? 1 : 2; };
  const filtered = ads
    .filter(a => filter === "all" || a.media_type === filter)
    .filter(a => !winnersOnly || winnerTier(a) !== null)
    .filter(a => !search || a.name.toLowerCase().includes(search.toLowerCase()) || a.headline.toLowerCase().includes(search.toLowerCase()) || a.hook.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => tierRank(a) - tierRank(b));

  const winnerCount = ads.filter(a => winnerTier(a) !== null).length;
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
          {libUrl && (
            <a href={libUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors">
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setCfgOpen(true)} className="gap-1.5 text-sm" title="Auto-scrape settings">
            <Settings className="w-4 h-4" /> Auto-scrape
          </Button>
          <Button variant="outline" onClick={scrapeNow} disabled={scraping} className="gap-1.5 text-sm">
            {scraping ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />} Scrape now
          </Button>
          <Button onClick={() => setUploadOpen(true)} className="bg-primary text-white gap-1.5 text-sm">
            <Upload className="w-4 h-4" /> Add Ad
          </Button>
        </div>
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
        <button onClick={() => setWinnersOnly(v => !v)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg font-semibold border transition-colors ${winnersOnly ? "bg-amber-400 border-amber-400 text-amber-950" : "border-border text-muted-foreground hover:text-foreground hover:border-amber-300"}`}>
          <Flame className="w-3.5 h-3.5" /> Winners{winnerCount > 0 ? ` (${winnerCount})` : ""}
        </button>
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

                  {/* Winner + Active badges (stacked) */}
                  <div className="absolute top-2 left-2 flex flex-col items-start gap-1">
                    <WinnerBadge ad={ad} />
                    {(ad.ad_active === "true" || ad.is_active === "true") && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-green-500 text-white shadow-sm">ACTIVE</span>
                    )}
                  </div>

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
                <div className="px-2 py-2 flex items-start justify-between gap-1">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-foreground truncate leading-tight">
                      {ad.headline || ad.name || "Ad"}
                    </p>
                    {ad.hook && (
                      <p className="text-[10px] text-muted-foreground truncate">{ad.hook}</p>
                    )}
                  </div>
                  <button
                    title="Delete creative"
                    onClick={e => { e.stopPropagation(); delAd(ad.id); }}
                    className="flex-shrink-0 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Ad detail side panel */}
      {detailAd && (
        <CreativeDetailPanel
          ad={detailAd}
          placeholderIndex={ads.indexOf(detailAd)}
          brandName={competitor.name}
          projectId={projectId}
          onClose={() => setDetailAd(null)}
          onSaveTemplate={(id) => { saveToTemplates([id]); setDetailAd(null); }}
          onDelete={(id) => { delAd(id); setDetailAd(null); }}
          onTranscribed={(adId, t) => setAds(p => p.map(a => a.id === adId ? { ...a, body_text: t } : a))}
          onWinnerChange={(adId, w) => setAds(p => p.map(a => a.id === adId ? { ...a, is_winner: w } : a))}
        />
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

      {/* Auto-scrape settings */}
      <Dialog open={cfgOpen} onOpenChange={setCfgOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Auto-scrape — {competitor.name}</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Meta Ad Library URL</label>
              <Input value={cfg.ads_library_url} onChange={e => setCfg(p => ({ ...p, ads_library_url: e.target.value }))}
                placeholder="https://www.facebook.com/ads/library/?...view_all_page_id=..." className="text-sm" />
              <p className="text-[11px] text-muted-foreground">Open the Meta Ad Library, filter to this advertiser, and paste the page URL.</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Check frequency</label>
              <select value={cfg.frequency} onChange={e => setCfg(p => ({ ...p, frequency: e.target.value }))}
                className="w-full text-sm border border-border rounded-md px-3 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-primary">
                {[["once", "Manual only"], ["daily", "Daily"], ["every_3_days", "Every 3 days"], ["every_7_days", "Every 7 days"], ["every_14_days", "Every 14 days"]].map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
              <input type="checkbox" checked={cfg.is_active} onChange={e => setCfg(p => ({ ...p, is_active: e.target.checked }))} />
              Enable automatic daily monitoring
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setCfgOpen(false)}>Cancel</Button>
              <Button onClick={saveCfg} disabled={savingCfg} className="bg-primary text-white gap-1.5">
                {savingCfg ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Saving...</> : <>Save</>}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── ALL CREATIVES (flat) VIEW ──
type CreativeWithBrand = CompetitorAd & { brand_name: string };

function AllCreativesView({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [creatives, setCreatives] = useState<CreativeWithBrand[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [media, setMedia] = useState<"all" | "image" | "video">("all");
  const [brand, setBrand] = useState<string>("all");
  const [winnersOnly, setWinnersOnly] = useState(false);
  const [detailAd, setDetailAd] = useState<CreativeWithBrand | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/creatives`);
      if (r.ok) setCreatives(await r.json());
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [projectId]);

  const del = async (ad: CreativeWithBrand) => {
    setCreatives(p => p.filter(a => a.id !== ad.id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${ad.brand_id}/ads/${ad.id}`, { method: "DELETE" });
    toast({ title: "Creative removed" });
  };
  const saveTpl = async (ad: CreativeWithBrand) => {
    const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${ad.brand_id}/ads/save-to-templates`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ad_ids: [ad.id] }),
    });
    if (r.ok) toast({ title: "Saved to templates!" });
  };

  const brands = [...new Set(creatives.map(c => c.brand_name).filter(Boolean))];
  const tierRank = (a: CompetitorAd) => { const t = winnerTier(a); return t === "winner" ? 0 : t === "promising" ? 1 : 2; };
  const winnerCount = creatives.filter(c => winnerTier(c) !== null).length;
  const filtered = creatives
    .filter(c => media === "all" || c.media_type === media)
    .filter(c => brand === "all" || c.brand_name === brand)
    .filter(c => !winnersOnly || winnerTier(c) !== null)
    .filter(c => !search || `${c.name} ${c.headline} ${c.hook} ${c.brand_name}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => tierRank(a) - tierRank(b));

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search creatives..." className="pl-8 h-8 text-sm" />
        </div>
        <select value={brand} onChange={e => setBrand(e.target.value)}
          className="h-8 text-sm border border-border rounded-lg px-2 bg-background focus:outline-none focus:ring-1 focus:ring-primary">
          <option value="all">All competitors</option>
          {brands.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <div className="flex items-center gap-1 border border-border rounded-lg p-0.5 bg-muted/30">
          {(["all", "image", "video"] as const).map(f => (
            <button key={f} onClick={() => setMedia(f)}
              className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${f === media ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {f === "all" ? "All" : f === "image" ? "Images" : "Video"}
            </button>
          ))}
        </div>
        <button onClick={() => setWinnersOnly(v => !v)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg font-semibold border transition-colors ${winnersOnly ? "bg-amber-400 border-amber-400 text-amber-950" : "border-border text-muted-foreground hover:text-foreground hover:border-amber-300"}`}>
          <Flame className="w-3.5 h-3.5" /> Winners{winnerCount > 0 ? ` (${winnerCount})` : ""}
        </button>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="py-20 text-center border-2 border-dashed border-border rounded-2xl">
          <BarChart2 className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-semibold text-foreground mb-1">No creatives yet</p>
          <p className="text-xs text-muted-foreground">Save images/videos with the extension, or add competitors.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
          {filtered.map((ad, idx) => (
            <div key={ad.id} onClick={() => setDetailAd(ad)}
              className="group relative rounded-2xl overflow-hidden bg-card border-2 border-transparent hover:border-border hover:shadow-lg transition-all cursor-pointer">
              <div className="aspect-[4/5] relative overflow-hidden rounded-xl">
                {ad.file_path
                  ? <MediaThumb path={ad.file_path} type={ad.media_type} className="w-full h-full" />
                  : <AdPlaceholder ad={ad} index={idx} />}
                <div className="absolute top-2 left-2 flex flex-col items-start gap-1">
                  <WinnerBadge ad={ad} />
                </div>
                <div className="absolute inset-x-0 bottom-0 opacity-0 group-hover:opacity-100 transition-opacity p-2">
                  <button onClick={e => { e.stopPropagation(); saveTpl(ad); }}
                    className="w-full flex items-center justify-center gap-1.5 bg-sky-500 text-white text-[10px] font-bold py-2 rounded-lg hover:bg-sky-600 transition-colors shadow-lg">
                    <Bookmark className="w-3 h-3" /> Save template
                  </button>
                </div>
              </div>
              <div className="px-2 py-2 flex items-start justify-between gap-1">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground truncate leading-tight">{ad.headline || ad.name || "Creative"}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{ad.brand_name}</p>
                </div>
                <button title="Delete creative" onClick={e => { e.stopPropagation(); del(ad); }}
                  className="flex-shrink-0 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {detailAd && (
        <CreativeDetailPanel
          ad={detailAd}
          placeholderIndex={filtered.indexOf(detailAd)}
          brandName={detailAd.brand_name}
          projectId={projectId}
          onClose={() => setDetailAd(null)}
          onSaveTemplate={() => { saveTpl(detailAd); setDetailAd(null); }}
          onDelete={() => { del(detailAd); setDetailAd(null); }}
          onTranscribed={(adId, t) => setCreatives(p => p.map(a => a.id === adId ? { ...a, body_text: t } : a))}
          onWinnerChange={(adId, w) => setCreatives(p => p.map(a => a.id === adId ? { ...a, is_winner: w } : a))}
        />
      )}
    </div>
  );
}

// ── COMPETITOR LANDINGS VIEW ──
type Landing = {
  id: string;
  name: string;
  url: string;
  page_type: string;
  category: string;
  tags: string[];
  screenshot: string;
  html_url: string;
  editor_url: string;
  created_at: string;
};

function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function CompetitorLandingsView({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const router = useRouter();
  const [landings, setLandings] = useState<Landing[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Add this landing as a swipe step in Clone/Swipe (front-end-funnel), then go there.
  const cloneSwipe = (l: Landing) => {
    if (!l.url) { toast({ title: "This landing has no source URL to swipe", variant: "destructive" }); return; }
    const q = new URLSearchParams({
      swipe_url: l.url,
      swipe_name: l.name || "Template",
      swipe_type: l.page_type || "landing",
    });
    router.push(`/front-end-funnel?${q.toString()}`);
  };

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/landings`);
      if (r.ok) setLandings(await r.json());
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [projectId]);

  const del = async (l: Landing) => {
    setLandings(p => p.filter(x => x.id !== l.id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/landings/${l.id}`, { method: "DELETE" });
    toast({ title: "Landing removed" });
  };

  const filtered = landings.filter(l =>
    !search || `${l.name} ${l.url} ${l.category} ${(l.tags || []).join(" ")}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-bold text-foreground">Competitor Landings</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Landing &amp; funnel pages saved from the browser extension. Monitor them or reuse as templates.
          </p>
        </div>
        <div className="relative min-w-56">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search landings..." className="pl-8 h-9 text-sm" />
        </div>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="py-20 text-center border-2 border-dashed border-border rounded-2xl">
          <LayoutTemplate className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-semibold text-foreground mb-1">No competitor landings yet</p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            Open a competitor page, click the <b>Wasabi Saver</b> extension, choose
            “Project · Competitor Landings” and pick this project.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(l => (
            <div key={l.id}
              className="group relative bg-card border border-border rounded-2xl overflow-hidden hover:border-primary/40 hover:shadow-lg transition-all">
              {/* Preview (click = Clone/Swipe) */}
              <button onClick={() => cloneSwipe(l)} className="block w-full text-left aspect-[16/10] relative overflow-hidden bg-slate-100 cursor-pointer">
                {l.screenshot ? (
                  <img src={l.screenshot} alt={l.name} className="w-full h-full object-cover object-top group-hover:scale-[1.02] transition-transform" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900">
                    <Globe className="w-8 h-8 text-white/20" />
                  </div>
                )}
                <span className="absolute top-2 left-2 text-[9px] font-bold px-2 py-0.5 rounded-full bg-black/55 backdrop-blur-sm text-white uppercase tracking-wide">
                  {l.page_type || "landing"}
                </span>
              </button>
              {/* Delete (hover) */}
              <button onClick={() => del(l)}
                className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/45 backdrop-blur-sm text-white/90 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                title="Remove landing">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              {/* Footer */}
              <div className="p-3">
                <p className="text-sm font-semibold text-foreground truncate">{l.name}</p>
                <p className="text-[11px] text-muted-foreground truncate mb-2 flex items-center gap-1">
                  <Globe className="w-3 h-3" /> {hostOf(l.url)}
                </p>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => cloneSwipe(l)}
                    className="flex-1 flex items-center justify-center gap-1 bg-primary text-white text-[11px] font-semibold py-1.5 rounded-lg hover:opacity-90 transition-opacity">
                    <Repeat className="w-3 h-3" /> Clone / Swipe
                  </button>
                  <a href={l.html_url} target="_blank" rel="noopener noreferrer"
                    className="flex items-center justify-center gap-1 border border-border text-foreground text-[11px] font-semibold py-1.5 px-2.5 rounded-lg hover:bg-muted transition-colors">
                    <Eye className="w-3 h-3" /> View
                  </a>
                  {l.url && (
                    <a href={l.url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center justify-center border border-border text-muted-foreground py-1.5 px-2 rounded-lg hover:bg-muted transition-colors"
                      title="Open original">
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Project-wide library of real-footage shots cut from every competitor video.
// The mixing pool for recreating videos — filter to CLEAN shots (no burned-in
// subtitles) and reuse them under a new script/voice.
function ShotsLibraryView({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [shots, setShots] = useState<Shot[]>([]);
  const [brandNames, setBrandNames] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "clean" | "subs">("all");
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<Shot | null>(null);

  const load = async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [sr, br] = await Promise.all([
        fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/shots`),
        fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library`),
      ]);
      const sj = await sr.json().catch(() => []);
      setShots(Array.isArray(sj) ? sj : []);
      const bj = await br.json().catch(() => []);
      const map: Record<number, string> = {};
      for (const b of Array.isArray(bj) ? bj : []) map[b.id] = b.name;
      setBrandNames(map);
    } catch { if (!quiet) setShots([]); }
    finally { if (!quiet) setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);

  // While AI subtitle removal is running, refresh quietly until it settles.
  const cleaningCount = shots.filter(
    (s) => s.inpaint_status === "pending" || s.inpaint_status === "processing",
  ).length;
  useEffect(() => {
    if (cleaningCount === 0) return;
    const t = setTimeout(() => load(true), 8000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shots]);

  const remove = async (s: Shot) => {
    setShots((p) => p.filter((x) => x.id !== s.id));
    try { await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/shots/${s.id}`, { method: "DELETE" }); }
    catch { toast({ title: "Delete failed", variant: "destructive" }); }
  };

  // Kick AI inpainting for one shot or all subtitled shots. `force` re-cleans
  // shots that already have a cleaned copy (e.g. to retry with a better model).
  const inpaint = async (shotId?: number, force = false) => {
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/shots/inpaint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(shotId ? { shotId, force } : { all: true, force }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast({ title: "Could not start", description: j.error || "Unknown error", variant: "destructive" });
        return;
      }
      if (!j.queued) {
        toast({ title: "Nothing to clean", description: j.message || "" });
        return;
      }
      toast({
        title: `Removing subtitles from ${j.queued} shot${j.queued > 1 ? "s" : ""}`,
        description: "AI is reconstructing the frames — this takes a few minutes per shot.",
      });
      load(true);
    } catch {
      toast({ title: "Could not start", variant: "destructive" });
    }
  };

  const isUsable = (s: Shot) => s.has_text !== true || !!s.clean_path;
  const cleanCount = shots.filter(isUsable).length;
  const toCleanCount = shots.filter((s) => s.has_text === true && !s.clean_path).length;
  const q = query.trim().toLowerCase();
  const filtered = shots
    .filter((s) => (filter === "all" ? true : filter === "clean" ? isUsable(s) : !isUsable(s)))
    .filter((s) => {
      if (!q) return true;
      const hay = [s.label || "", s.caption || "", ...(s.tags || [])].join(" ").toLowerCase();
      return hay.includes(q);
    });

  // Group into narrative folders (hook / body / cta), keeping anything else last.
  const SECTIONS: { key: string; label: string }[] = [
    { key: "hook", label: "Hook" },
    { key: "body", label: "Body" },
    { key: "cta", label: "CTA / Close" },
    { key: "other", label: "Uncategorized" },
  ];
  const normSection = (s: Shot) => {
    const v = (s.section || "").toLowerCase();
    return v === "hook" || v === "body" || v === "cta" ? v : "other";
  };
  const groups = SECTIONS
    .map((g) => ({ ...g, items: filtered.filter((s) => normSection(s) === g.key) }))
    .filter((g) => g.items.length > 0);

  const renderCard = (s: Shot) => {
    const hasText = s.has_text === true;
    const cleaned = hasText && !!s.clean_path;
    const cleaning = hasText && !s.clean_path && (s.inpaint_status === "pending" || s.inpaint_status === "processing");
    const failed = hasText && !s.clean_path && s.inpaint_status === "error";
    return (
      <div key={s.id} className="group rounded-xl overflow-hidden border border-border bg-black/5">
        <div className="relative">
          <button onClick={() => setPlaying(s)} className="block w-full aspect-[9/16] bg-black">
            {s.thumb_path
              ? <img src={getUploadUrl(s.thumb_path)} alt="" className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center text-white/40"><Play className="w-6 h-6" /></div>}
          </button>
          <span className="absolute top-1.5 left-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-black/70 text-white">
            {s.duration_sec}s
          </span>
          <span
            title={cleaned
              ? "Subtitles removed with AI inpainting — usable in builds"
              : cleaning
                ? "AI is removing the subtitles…"
                : hasText
                  ? (failed ? `AI cleanup failed: ${s.inpaint_error || "unknown error"} — click Remove subs to retry` : "Has burned-in subtitles — excluded from builds until cleaned")
                  : "Clean (no subtitles detected)"}
            className={`absolute top-1.5 right-1.5 text-[9px] font-black px-1.5 py-0.5 rounded-full ${
              cleaned ? "bg-emerald-500 text-white"
              : cleaning ? "bg-amber-500 text-white"
              : hasText ? "bg-rose-500 text-white"
              : "bg-emerald-500 text-white"}`}>
            {cleaned ? "CLEANED" : cleaning ? "CLEANING…" : hasText ? "SUBS" : "CLEAN"}
          </span>
          {brandNames[s.brand_id] && (
            <span className="absolute bottom-1.5 left-1.5 max-w-[80%] truncate text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-black/70 text-white">
              {brandNames[s.brand_id]}
            </span>
          )}
          {hasText && !cleaned && !cleaning && (
            <button
              onClick={() => inpaint(s.id)}
              className="absolute inset-x-1.5 bottom-8 opacity-0 group-hover:opacity-100 transition-opacity bg-indigo-600 hover:bg-indigo-500 text-white rounded-md px-1.5 py-1 text-[10px] font-bold flex items-center justify-center gap-1"
              title="Reconstruct the frames behind the subtitles with AI">
              <Sparkles className="w-3 h-3" /> Remove subs
            </button>
          )}
          {cleaned && (
            <button
              onClick={() => inpaint(s.id, true)}
              className="absolute inset-x-1.5 bottom-8 opacity-0 group-hover:opacity-100 transition-opacity bg-black/70 hover:bg-black/80 text-white rounded-md px-1.5 py-1 text-[10px] font-bold flex items-center justify-center gap-1"
              title="Run the AI cleanup again on this shot">
              <RefreshCw className="w-3 h-3" /> Redo cleanup
            </button>
          )}
          <button
            onClick={() => remove(s)}
            className="absolute bottom-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-black/70 text-white rounded-md p-1"
            title="Delete shot">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        {(s.label || (s.tags && s.tags.length > 0)) && (
          <div className="px-1.5 py-1 bg-background">
            {s.label && (
              <p className="text-[10px] font-semibold text-foreground truncate" title={s.caption || s.label}>{s.label}</p>
            )}
            {s.tags && s.tags.length > 0 && (
              <div className="flex flex-wrap gap-0.5 mt-0.5">
                {s.tags.slice(0, 3).map((t) => (
                  <span key={t} className="text-[8px] px-1 py-0.5 rounded bg-muted text-muted-foreground truncate max-w-full">{t}</span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-bold text-foreground">Real footage shots</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Pieces cut from competitor videos (audio removed). Use the <b>CLEAN</b> ones as B-roll to recreate videos.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tags (e.g. trump, phone)…"
              className="h-8 w-52 text-xs rounded-lg border border-border bg-background pl-8 pr-2"
            />
          </div>
          <div className="flex items-center gap-1 border border-border rounded-lg p-0.5 bg-muted/30 w-fit">
            {([["all", `All (${shots.length})`], ["clean", `Usable (${cleanCount})`], ["subs", "With subs"]] as const).map(([v, l]) => (
              <button key={v} onClick={() => setFilter(v)}
                className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${filter === v ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {l}
              </button>
            ))}
          </div>
          {cleaningCount > 0 ? (
            <span className="h-8 inline-flex items-center gap-1.5 text-xs font-semibold px-3 rounded-lg bg-amber-100 text-amber-700">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Cleaning {cleaningCount}…
            </span>
          ) : toCleanCount > 0 ? (
            <button
              onClick={() => inpaint()}
              className="h-8 inline-flex items-center gap-1.5 text-xs font-bold px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white"
              title="Reconstruct the frames behind the subtitles with AI (Replicate) for every subtitled shot">
              <Sparkles className="w-3.5 h-3.5" /> Remove subs with AI ({toCleanCount})
            </button>
          ) : shots.some((s) => s.has_text === true && s.clean_path) ? (
            <button
              onClick={() => inpaint(undefined, true)}
              className="h-8 inline-flex items-center gap-1.5 text-xs font-semibold px-3 rounded-lg border border-indigo-300 text-indigo-600 hover:bg-indigo-50"
              title="Run the AI cleanup again on every subtitled shot (useful after the engine improves)">
              <RefreshCw className="w-3.5 h-3.5" /> Re-clean all
            </button>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading shots…</div>
      ) : filtered.length === 0 ? (
        <div className="py-20 text-center border-2 border-dashed border-border rounded-2xl">
          <Film className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-semibold text-foreground mb-1">No shots yet</p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            Open a competitor video and click <b>Split into shots</b>. It's cut into reusable pieces on the server, then named and tagged automatically.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.key}>
              <div className="flex items-center gap-2 mb-2">
                <h4 className="text-sm font-bold text-foreground">{g.label}</h4>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                  {g.items.length}
                </span>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                {g.items.map(renderCard)}
              </div>
            </div>
          ))}
        </div>
      )}

      {playing && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-6" onClick={() => setPlaying(null)}>
          <div className="absolute inset-0 bg-black/80" />
          <video
            src={getUploadUrl(playing.clean_path || playing.file_path)}
            controls autoPlay loop playsInline
            className="relative max-h-[80vh] max-w-full rounded-xl bg-black"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

type GeneratedVideo = {
  id: number;
  project_id: string;
  brand_id: number;
  ad_id: number;
  file_path: string;
  thumb_path?: string | null;
  duration_sec: number;
  script?: string | null;
  voice?: string | null;
  created_at: string;
};

function GeneratedVideosView({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [videos, setVideos] = useState<GeneratedVideo[]>([]);
  const [brandNames, setBrandNames] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<GeneratedVideo | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [vr, br] = await Promise.all([
        fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/generated-videos`),
        fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library`),
      ]);
      const vj = await vr.json().catch(() => []);
      setVideos(Array.isArray(vj) ? vj : []);
      const bj = await br.json().catch(() => []);
      const map: Record<number, string> = {};
      for (const b of Array.isArray(bj) ? bj : []) map[b.id] = b.name;
      setBrandNames(map);
    } catch { setVideos([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);

  const remove = async (v: GeneratedVideo) => {
    setVideos((p) => p.filter((x) => x.id !== v.id));
    try { await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/generated-videos/${v.id}`, { method: "DELETE" }); }
    catch { toast({ title: "Delete failed", variant: "destructive" }); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-bold text-foreground">New creatives</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Videos you recreated from real footage + AI b-roll. Open a competitor video and use <b>Recreate video</b> to make more.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} className="gap-1.5 h-8">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </Button>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
      ) : videos.length === 0 ? (
        <div className="py-20 text-center border-2 border-dashed border-border rounded-2xl">
          <Sparkles className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-semibold text-foreground mb-1">No recreated videos yet</p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            Open a competitor video, generate your script, then click <b>Build video</b>. Finished videos land here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {videos.map((v) => (
            <div key={v.id} className="group relative rounded-xl overflow-hidden border border-border bg-black/5">
              <button onClick={() => setPlaying(v)} className="block w-full aspect-[9/16] bg-black">
                {v.thumb_path
                  ? <img src={getUploadUrl(v.thumb_path)} alt="" className="w-full h-full object-cover" />
                  : <div className="w-full h-full flex items-center justify-center text-white/40"><Play className="w-7 h-7" /></div>}
              </button>
              <span className="absolute top-1.5 left-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-black/70 text-white">
                {Math.round(v.duration_sec)}s
              </span>
              <span className="absolute top-1.5 right-1.5 text-[9px] font-black px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground">
                NEW
              </span>
              {brandNames[v.brand_id] && (
                <span className="absolute bottom-9 left-1.5 max-w-[80%] truncate text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-black/70 text-white">
                  {brandNames[v.brand_id]}
                </span>
              )}
              <div className="flex items-center justify-between px-2 py-1.5 bg-background">
                <button
                  onClick={() => downloadCreative({ file_path: v.file_path, name: `creative-${v.id}`, media_type: "video" })}
                  className="flex items-center gap-1 text-[10px] font-semibold text-primary hover:underline">
                  <Download className="w-3 h-3" /> Download
                </button>
                <button onClick={() => remove(v)} className="text-muted-foreground hover:text-destructive" title="Delete">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {playing && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-6" onClick={() => setPlaying(null)}>
          <div className="absolute inset-0 bg-black/80" />
          <div className="relative flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
            <video
              src={getUploadUrl(playing.file_path)}
              controls autoPlay loop playsInline
              className="max-h-[78vh] max-w-full rounded-xl bg-black"
            />
            <button
              onClick={() => downloadCreative({ file_path: playing.file_path, name: `creative-${playing.id}`, media_type: "video" })}
              className="flex items-center gap-1.5 text-sm font-semibold text-white bg-primary px-4 py-2 rounded-lg hover:opacity-90">
              <Download className="w-4 h-4" /> Download
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type FootageVideo = {
  id: number;
  brand_id: number;
  file_path: string;
  media_type: string;
  name: string;
  created_at: string;
};

// Upload YOUR OWN videos and split them into shots (same pipeline as competitor
// videos). The resulting shots join the project's shot pool used to recreate
// videos. Large files upload straight to storage via a signed URL.
function MyFootageView({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [videos, setVideos] = useState<FootageVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState("");
  const [seg, setSeg] = useState<Record<number, { status: string; shots: number }>>({});
  const [playing, setPlaying] = useState<FootageVideo | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/my-footage`);
      const j = await r.json().catch(() => ({}));
      const vids: FootageVideo[] = Array.isArray(j?.videos) ? j.videos : [];
      setVideos(vids);
      refreshSeg(vids);
    } catch { setVideos([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); return () => { if (poll.current) clearInterval(poll.current); }; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);

  const refreshSeg = async (vids: FootageVideo[]) => {
    const entries = await Promise.all(vids.map(async (v) => {
      try {
        const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${v.brand_id}/ads/${v.id}/segment`);
        const j = await r.json().catch(() => ({}));
        return [v.id, { status: j?.job?.status || "", shots: j?.shots || 0 }] as const;
      } catch { return [v.id, { status: "", shots: 0 }] as const; }
    }));
    const map: Record<number, { status: string; shots: number }> = {};
    for (const [k, val] of entries) map[k] = val;
    setSeg(map);
    const anyActive = entries.some(([, val]) => val.status === "pending" || val.status === "processing");
    if (anyActive && !poll.current) {
      poll.current = setInterval(() => refreshSeg(vids), 5000);
    } else if (!anyActive && poll.current) {
      clearInterval(poll.current); poll.current = null;
    }
  };

  const onPick = () => fileRef.current?.click();

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    const sb = getSupabaseBrowser();
    if (!sb) { toast({ title: "Upload not available", description: "Supabase not configured.", variant: "destructive" }); return; }
    setUploading(true);
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!/^video\//i.test(file.type)) { toast({ title: `Skipped ${file.name}`, description: "Not a video." }); continue; }
      setProgress(`Uploading ${i + 1}/${files.length}: ${file.name}`);
      try {
        const sr = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/my-footage/sign-upload`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, contentType: file.type || "video/mp4" }),
        });
        const sj = await sr.json().catch(() => ({}));
        if (!sr.ok || !sj.path || !sj.token) throw new Error(sj.error || "sign failed");
        const up = await sb.storage.from("project-files").uploadToSignedUrl(sj.path, sj.token, file);
        if (up.error) throw new Error(up.error.message);
        const rr = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/my-footage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_path: sj.path, name: file.name.replace(/\.[^.]+$/, "") }),
        });
        if (!rr.ok) throw new Error("register failed");
        ok++;
      } catch (err) {
        toast({ title: `Upload failed: ${file.name}`, description: (err as Error).message, variant: "destructive" });
      }
    }
    setUploading(false);
    setProgress("");
    if (ok > 0) toast({ title: `Uploaded ${ok} video${ok === 1 ? "" : "s"}`, description: "Splitting into shots automatically…" });
    load();
  };

  const split = async (v: FootageVideo) => {
    setSeg((p) => ({ ...p, [v.id]: { status: "pending", shots: p[v.id]?.shots || 0 } }));
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${v.brand_id}/ads/${v.id}/segment`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        toast({ title: j.queued === false ? "Already processing" : "Queued for splitting", description: "Shots will appear in the Shots tab." });
        if (!poll.current) poll.current = setInterval(() => refreshSeg(videos), 5000);
      } else {
        setSeg((p) => ({ ...p, [v.id]: { status: "", shots: p[v.id]?.shots || 0 } }));
        toast({ title: j.error || "Could not start", variant: "destructive" });
      }
    } catch { setSeg((p) => ({ ...p, [v.id]: { status: "", shots: p[v.id]?.shots || 0 } })); }
  };

  const remove = async (v: FootageVideo) => {
    setVideos((p) => p.filter((x) => x.id !== v.id));
    try { await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${v.brand_id}/ads/${v.id}`, { method: "DELETE" }); }
    catch { toast({ title: "Delete failed", variant: "destructive" }); }
  };

  return (
    <div className="space-y-4">
      <input ref={fileRef} type="file" accept="video/*" multiple hidden onChange={onFiles} />
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-bold text-foreground">My footage</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Upload your own videos — they're <b>split into shots automatically</b> and join the pool used to <b>recreate videos</b>.
          </p>
        </div>
        <Button onClick={onPick} disabled={uploading} className="gap-2 h-9">
          {uploading ? <><RefreshCw className="w-4 h-4 animate-spin" /> Uploading…</> : <><Upload className="w-4 h-4" /> Upload videos</>}
        </Button>
      </div>
      {progress && <p className="text-xs text-muted-foreground">{progress}</p>}

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
      ) : videos.length === 0 ? (
        <div className="py-20 text-center border-2 border-dashed border-border rounded-2xl">
          <Upload className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-semibold text-foreground mb-1">No footage yet</p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            Click <b>Upload videos</b> to add your own clips. Then <b>Split into shots</b> to make reusable B-roll.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {videos.map((v) => {
            const st = seg[v.id] || { status: "", shots: 0 };
            const busy = st.status === "pending" || st.status === "processing";
            return (
              <div key={v.id} className="group rounded-xl overflow-hidden border border-border bg-black/5">
                <button onClick={() => setPlaying(v)} className="relative block w-full aspect-video bg-black">
                  <video src={getUploadUrl(v.file_path)} preload="metadata" className="w-full h-full object-cover" muted />
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="bg-black/50 rounded-full p-2"><Play className="w-5 h-5 text-white" /></span>
                  </span>
                  {st.shots > 0 && (
                    <span className="absolute top-1.5 right-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500 text-white">
                      {st.shots} shots
                    </span>
                  )}
                </button>
                <div className="p-2 space-y-1.5">
                  <p className="text-xs font-semibold text-foreground truncate" title={v.name}>{v.name}</p>
                  <div className="flex items-center gap-1.5">
                    <Button onClick={() => split(v)} disabled={busy} variant="outline" className="flex-1 gap-1.5 h-7 text-xs">
                      {busy
                        ? <><RefreshCw className="w-3 h-3 animate-spin" /> {st.status === "pending" ? "Queued…" : "Splitting…"}</>
                        : <><Scissors className="w-3 h-3" /> {st.shots > 0 ? "Re-split" : "Split"}</>}
                    </Button>
                    <button onClick={() => remove(v)} className="h-7 w-7 grid place-items-center rounded-md border border-border text-muted-foreground hover:text-destructive" title="Delete">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {playing && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-6" onClick={() => setPlaying(null)}>
          <div className="absolute inset-0 bg-black/80" />
          <video
            src={getUploadUrl(playing.file_path)}
            controls autoPlay playsInline
            className="relative max-h-[80vh] max-w-full rounded-xl bg-black"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

// ── MAIN EXPORT ──
type Tab = "ads" | "landings" | "shots" | "footage" | "generated" | "funnel";

const LIBRARY_TABS = [
  { id: "ads" as Tab, label: "Ads Library", icon: BarChart2 },
  { id: "landings" as Tab, label: "Landings", icon: LayoutTemplate },
  { id: "shots" as Tab, label: "Shots", icon: Film },
  { id: "footage" as Tab, label: "My Footage", icon: Upload },
  { id: "generated" as Tab, label: "New Creatives", icon: Sparkles },
  { id: "funnel" as Tab, label: "Funnel Monitoring", icon: TrendingUp },
] as const;

export function CompetitorLibrarySection({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<Tab>("ads");
  const [selected, setSelected] = useState<CompetitorWithStats | null>(null);
  const [adsView, setAdsView] = useState<"by" | "all">("by");

  // If viewing a competitor detail, stay in ads view regardless
  if (selected) {
    return (
      <div className="space-y-4">
        {/* Tab bar */}
        <div className="flex items-center gap-1 border-b border-border pb-0">
          {LIBRARY_TABS.map(({ id, label, icon: Icon }) => (
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
        {LIBRARY_TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px
              ${tab === id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}>
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {tab === "landings" && <CompetitorLandingsView projectId={projectId} />}

      {tab === "shots" && <ShotsLibraryView projectId={projectId} />}

      {tab === "footage" && <MyFootageView projectId={projectId} />}

      {tab === "generated" && <GeneratedVideosView projectId={projectId} />}

      {tab === "ads" && (
        <div className="space-y-4">
          <div className="flex items-center gap-1 border border-border rounded-lg p-0.5 bg-muted/30 w-fit">
            {([["by", "By competitor"], ["all", "All creatives"]] as const).map(([v, l]) => (
              <button key={v} onClick={() => setAdsView(v)}
                className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${adsView === v ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {l}
              </button>
            ))}
          </div>
          {adsView === "by"
            ? <CompetitorList projectId={projectId} onSelect={setSelected} />
            : <AllCreativesView projectId={projectId} />}
        </div>
      )}
      {tab === "funnel" && <FunnelMonitoringSection projectId={projectId} />}
    </div>
  );
}
