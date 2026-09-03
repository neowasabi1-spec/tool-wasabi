import { useState, useRef, useEffect, useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import {
  Plus, Trash2, Upload, Play, Search, ArrowLeft, ExternalLink,
  BarChart2, Calendar, Globe, X, RefreshCw, Image as ImageIcon,
  Video, Bookmark, CheckSquare, Square, TrendingUp, Download, Copy, Check,
  Settings, Zap, FileText, Eye, LayoutTemplate, Repeat, Star, Flame,
  Scissors, Film, Sparkles, DollarSign, Eraser, Folder, Activity, Users, Gauge, Loader2,
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { getUploadUrl } from "@/lib/projecthub-storage";
import { getSupabaseBrowser } from "@/lib/supabase-browser";
import { BUILD_LANGUAGES, LANGUAGE_OTHER } from "@/lib/video-languages";
import { hostOfUrl, LANDING_SECTION_LABEL, type LandingSection } from "@/lib/landing-media";
import { fillLandingLibrary, landingFillError } from "@/lib/landing-media-client";

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
  /** Creatives the daily scrape added since this competitor was last opened. */
  new_count?: number;
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
  /** Added by the daily scrape since this competitor was last opened. */
  is_new?: boolean;
  // Phase 1 winner signals (from Meta Ad Library via Apify) + manual override.
  ad_started_at?: string | null;
  ad_active?: string;
  ad_variants?: number;
  is_winner?: boolean;
  // Spend, as Meta publishes it (exact only for political / social-issue ads;
  // empty for the commercial ads this tool targets, where we fall back to an
  // estimate from longevity × live variants).
  spend?: string | null;
  impressions?: string | null;
  reach?: number | null;
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

// Creatives arriving from the daily scrape are flagged until the competitor is
// opened, so a new batch is noticeable without reading dates.
function NewBadge({ count, className = "" }: { count?: number; className?: string }) {
  const label = count && count > 1 ? `${count} NEW` : "NEW";
  return (
    <span
      title={count && count > 1 ? `${count} creatives added since your last visit` : "Added since your last visit"}
      className={`inline-flex items-center gap-1 text-[9px] font-black px-1.5 py-0.5 rounded-full shadow-sm bg-emerald-500 text-white ${className}`}>
      <Sparkles className="w-2.5 h-2.5" /> {label}
    </span>
  );
}

// Force a poster frame for muted <video> thumbnails. Chrome does NOT paint the
// first frame with preload="metadata" until the element seeks, so a freshly
// loaded (uncached) thumbnail shows a grey box. The media fragment #t=0.1 makes
// the browser seek to 0.1s and paint that frame — a real thumbnail, not grey.
function videoThumbSrc(path: string): string {
  const u = getUploadUrl(path);
  return u.includes("#") ? u : `${u}#t=0.1`;
}

// We ESTIMATE ad spend from the only spend-adjacent figure Meta discloses for
// commercial ads: the EU-mandated reach (DSA). Real spend is published only for
// political ads, so like every ad-spy tool we model it:
//   spend ≈ (impressions / 1000) × CPM,  impressions ≈ reach × frequency
// CPM is driven mainly by the VERTICAL (restricted, high-competition niches pay
// far more) and scaled by geo. Baselines below are real DR benchmarks for the
// verticals this tool targets — tune here.
const EST_FREQUENCY = 1.5; // avg times each reached person sees the ad

// $/1000-impressions at the US / tier-1 baseline, by vertical.
const CPM_BY_VERTICAL: Record<string, number> = {
  nutra: 100, // supplements / weight-loss / health — ~$80–120
  finance: 90, // crypto / trading / bizopp
  skincare: 70, // beauty / anti-age
  gadget: 55, // gadgets / ecom devices — ~$50–60 floor
  other: 45, // generic ecom
};

// Geo multiplier normalized to the US (tier-1 = 1.0). DR advertisers mostly run
// tier-1, so unknown/"ALL" assumes near-tier-1.
const GEO_FACTOR_DEFAULT = 0.9;
const GEO_FACTOR: Record<string, number> = {
  US: 1, CH: 1, CA: 0.95, AU: 0.95, GB: 0.9, UK: 0.9, DE: 0.9, NO: 0.9, IE: 0.85, JP: 0.85,
  AT: 0.85, NL: 0.85, SE: 0.85, DK: 0.85, BE: 0.8, FI: 0.8, FR: 0.8, KR: 0.75, SG: 0.75, AE: 0.75, IL: 0.75,
  IT: 0.7, ES: 0.7, PT: 0.6, GR: 0.55,
  PL: 0.5, CZ: 0.5, RO: 0.45, HU: 0.45, BG: 0.45,
  BR: 0.4, MX: 0.4, ZA: 0.4, TR: 0.35, AR: 0.3, IN: 0.25, ID: 0.25, PH: 0.25,
};

const NUTRA_RE = /\b(supplement|capsule|gummies|gummy|weight|fat|burn|metabol|blood\s?sugar|glucose|prostate|testosteron|collagen|probiotic|gut|detox|keto|slim|pounds|lbs|diet|inflammat|joint|tinnitus|libido|menopause|bloat|liver|kidney|vitamin|herbal|remedy|nerve)\b/i;
const FINANCE_RE = /\b(crypto|bitcoin|forex|trading|invest|profit|passive income|make money|bizopp|wealth|stocks?)\b/i;
const SKINCARE_RE = /\b(skin|wrinkle|anti[-\s]?age|serum|collagen cream|cream|moisturi|acne|pores|dark spot|glow)\b/i;
const GADGET_RE = /\b(device|gadget|portable|rechargeable|waterproof|charger|led|filter|straw|pump|camera|cooler|heater|mosquito|cleaner|light|kit|tool|mini)\b/i;

// Infer the vertical from the ad copy (we have no vertical field yet).
function detectVertical(ad: { headline?: string; hook?: string; body_text?: string; name?: string }): string {
  const t = `${ad.name || ""} ${ad.headline || ""} ${ad.hook || ""} ${ad.body_text || ""}`;
  if (NUTRA_RE.test(t)) return "nutra";
  if (FINANCE_RE.test(t)) return "finance";
  if (SKINCARE_RE.test(t)) return "skincare";
  if (GADGET_RE.test(t)) return "gadget";
  return "other";
}

// Effective CPM for an ad = vertical baseline × geo factor.
function cpmFor(ad: Parameters<typeof detectVertical>[0], country?: string): number {
  const base = CPM_BY_VERTICAL[detectVertical(ad)] ?? CPM_BY_VERTICAL.other;
  const geo = country ? (GEO_FACTOR[country.toUpperCase()] ?? GEO_FACTOR_DEFAULT) : GEO_FACTOR_DEFAULT;
  return Math.round(base * geo);
}

// Read the market from a Meta Ad Library URL's `country=` param (ISO-2, e.g.
// US/DE/GB). "ALL" or missing → "" (falls back to the default geo factor).
function countryFromAdLibraryUrl(url?: string | null): string {
  if (!url) return "";
  try {
    const c = (new URL(url).searchParams.get("country") || "").toUpperCase();
    return c && c !== "ALL" ? c : "";
  } catch {
    return "";
  }
}

// Estimated spend from EU reach at a given CPM, formatted like "≈$1.8K".
// Returns "" if reach is unusable. Always shown with an "est." marker so it
// never reads as a disclosed figure.
function estSpendFromReach(reach: number, cpm: number): string {
  if (!Number.isFinite(reach) || reach <= 0) return "";
  const impressions = reach * EST_FREQUENCY;
  const dollars = (impressions / 1000) * cpm;
  return `≈$${fmtCompact(Math.round(dollars))}`;
}

// US (and any non-EU) ads have NO disclosed reach — the DSA reach only exists
// for EU-served ads — so for them we fall back to a longevity model, the same
// proxy ad-spy tools use: cumulative spend ≈ days_live × daily_budget × f(variants).
// Variants are dampened (sqrt) so a big collation count doesn't explode the
// figure. Deliberately conservative; tune DAILY_SPEND_BASE.
const DAILY_SPEND_BASE = 50; // $/day baseline to keep one active DR ad live
function estSpendFromLongevity(days: number | null, variants: number): string {
  if (!days || days <= 0) return "";
  const vf = Math.sqrt(Math.max(1, variants));
  const dollars = days * DAILY_SPEND_BASE * vf;
  return `≈$${fmtCompact(Math.round(dollars))}`;
}

// Compact number formatting: 47_000_000 -> "47M", 12_300 -> "12.3K".
function fmtCompact(n: number): string {
  if (!isFinite(n)) return String(n);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(n);
}

// Compact data strip shown directly on each creative card so the key ad
// signals (longevity, live variants, reach/impressions, disclosed spend) are
// visible at a glance — no need to open the detail panel. Only renders the
// metrics we actually have for this ad.
function CardMetrics({ ad, country }: { ad: CompetitorAd; country?: string }) {
  const d = daysRunning(ad);
  const active = ad.ad_active === "true" || ad.is_active === "true";
  const variants = ad.ad_variants && ad.ad_variants > 1 ? ad.ad_variants : null;
  const spend = (ad.spend || "").trim();
  const reach = typeof ad.reach === "number" && ad.reach > 0 ? ad.reach : null;
  const impressions = (ad.impressions || "").trim();

  const estCpm = cpmFor(ad, country);
  let estSpend = "";
  let estTitle = "";
  if (reach) {
    estSpend = estSpendFromReach(reach, estCpm);
    estTitle = `Estimated spend — from EU reach ${reach.toLocaleString()} at ~$${estCpm} CPM (${detectVertical(ad)}${country ? ` · ${country}` : ""}). Not disclosed.`;
  } else if (d !== null) {
    estSpend = estSpendFromLongevity(d, variants || 1);
    estTitle = `Estimated spend — ${d}d live${variants ? ` × ${variants} variants` : ""} at ~$${DAILY_SPEND_BASE}/day baseline. Rough proxy, not disclosed.`;
  }

  // FIXED-SLOT metrics header, 2 rows so the spend value has room to show in
  // full (a single row truncated it to "USD $..."). Both rows always render at
  // a constant height, so every card stays the same height and the grid stays
  // aligned; each slot only fills in when the data exists.
  return (
    <div className="bg-muted/50 border-b border-border text-[10px] font-bold text-foreground">
      {/* Row 1 — live status · days running · active variants */}
      <div className="flex items-center gap-2 h-6 px-2 whitespace-nowrap overflow-hidden">
        <span className="inline-flex items-center gap-1 w-11 shrink-0 text-green-700">
          {active && (<><span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />LIVE</>)}
        </span>
        <span title={d !== null ? `Running ${d} day${d === 1 ? "" : "s"}` : undefined}
          className="inline-flex items-center gap-0.5 w-11 shrink-0 text-amber-700">
          {d !== null && (<><Calendar className="w-3 h-3" />{d}d</>)}
        </span>
        <span title={variants ? `${variants} active variants` : undefined}
          className="inline-flex items-center gap-0.5 shrink-0 text-slate-600">
          {variants && (<><Repeat className="w-3 h-3" />×{variants}</>)}
        </span>
      </div>
      {/* Row 2 — Meta-disclosed spend when available, else an estimate from EU
          reach (marked "est."), else impressions, else empty. Full width. */}
      <div className="flex items-center h-6 px-2 border-t border-border/60 whitespace-nowrap overflow-hidden">
        {spend ? (
          <span title={`Meta-disclosed spend ${spend}`}
            className="inline-flex items-center gap-1 min-w-0 text-emerald-700">
            <DollarSign className="w-3 h-3 shrink-0" /><span className="truncate">{spend}</span>
          </span>
        ) : estSpend ? (
          <span title={estTitle}
            className="inline-flex items-center gap-1 min-w-0 text-emerald-700/80">
            <DollarSign className="w-3 h-3 shrink-0" /><span className="truncate">{estSpend}</span>
            <span className="text-[9px] font-semibold text-muted-foreground/70">est.</span>
          </span>
        ) : impressions ? (
          <span title={`Impressions ${impressions}`}
            className="inline-flex items-center gap-1 min-w-0 text-sky-700">
            <Eye className="w-3 h-3 shrink-0" /><span className="truncate">{impressions}</span>
          </span>
        ) : (
          <span className="text-muted-foreground/60">—</span>
        )}
      </div>
    </div>
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
  { bg: "from-slate-500 to-slate-700", text: "text-white" },
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
    return <div className={`bg-slate-100 flex items-center justify-center ${className}`}><Globe className="w-6 h-6 text-slate-400" /></div>;
  }
  if (type === "video") {
    return (
      <div className={`relative bg-slate-100 ${className}`}>
        <video src={videoThumbSrc(path)} muted playsInline preload="metadata" className="w-full h-full object-cover" />
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-8 h-8 rounded-full bg-slate-900/45 flex items-center justify-center"><Play className="w-3.5 h-3.5 text-white" /></div>
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
                  <div key={s.id} className="group relative rounded-xl overflow-hidden border border-border bg-slate-50">
                    <button onClick={() => setPlaying(s)} className="block w-full aspect-[9/16] bg-slate-100">
                      {s.thumb_path
                        ? <img src={getUploadUrl(s.thumb_path)} alt="" className="w-full h-full object-cover" />
                        : <div className="w-full h-full flex items-center justify-center text-slate-400"><Play className="w-6 h-6" /></div>}
                    </button>
                    <span className="absolute top-1.5 left-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-slate-900/70 text-white">
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
                      className="absolute bottom-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-900/70 text-white rounded-md p-1"
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
  // Whole-video subtitle removal — clean the FULL video (captions gone, audio
  // kept) with the same engine the shots use. Result lands in clean_full_path.
  const [cleanStatus, setCleanStatus] = useState<string>("");
  const [cleanPath, setCleanPath] = useState<string>("");
  const [cleanErr, setCleanErr] = useState<string>("");
  const cleanPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadCleanStatus = async () => {
    try {
      const r = await fetch(`/api/projecthub/projects/${projectId}/competitor-library/${ad.brand_id}/ads/${ad.id}/clean-video`);
      const j = await r.json().catch(() => ({}));
      setCleanStatus(j?.status || "");
      setCleanPath(j?.cleanPath || "");
      setCleanErr(String(j?.error || ""));
      if (j?.status === "pending" || j?.status === "processing") {
        if (!cleanPoll.current) cleanPoll.current = setInterval(loadCleanStatus, 5000);
      } else if (cleanPoll.current) { clearInterval(cleanPoll.current); cleanPoll.current = null; }
    } catch { /* ignore */ }
  };
  useEffect(() => {
    if (ad.media_type === "video") loadCleanStatus();
    return () => { if (cleanPoll.current) { clearInterval(cleanPoll.current); cleanPoll.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ad.id]);
  const removeSubtitles = async () => {
    setCleanStatus("pending"); setCleanErr("");
    try {
      const r = await fetch(`/api/projecthub/projects/${projectId}/competitor-library/${ad.brand_id}/ads/${ad.id}/clean-video`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        toast({ title: "Removing subtitles…", description: "Runs on the server — may take a minute or two." });
        if (!cleanPoll.current) cleanPoll.current = setInterval(loadCleanStatus, 5000);
      } else {
        setCleanStatus("");
        toast({ title: j.error || "Could not start", variant: "destructive" });
      }
    } catch { setCleanStatus(""); toast({ title: "Could not start", variant: "destructive" }); }
  };
  // Phase 2 step 2 — recreate a new video from clean shots + our voice.
  const [buildStatus, setBuildStatus] = useState<string>("");
  const [buildError, setBuildError] = useState<string>("");
  const [buildVideos, setBuildVideos] = useState<{ id: number; file_path: string; thumb_path?: string | null; duration_sec: number }[]>([]);
  // Show the finished video inline only right after a build done in THIS session;
  // otherwise it lives permanently in the "New Creatives" tab, not pinned here.
  const [showInline, setShowInline] = useState(false);
  const [voice, setVoice] = useState("alloy");
  // Localize the original video into another language: translated voiceover +
  // subtitles over the same footage. Empty = keep the transcript's language.
  const [buildLang, setBuildLang] = useState("");
  const [buildLangOther, setBuildLangOther] = useState("");
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
      // Show why it failed instead of pointing at logs nobody can read.
      setBuildError(String(j?.job?.error || "").replace(/\s+/g, " ").slice(0, 180));
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
    setBuildError("");
    setShowInline(true);
    const language = buildLang === LANGUAGE_OTHER ? buildLangOther.trim() : buildLang;
    try {
      const r = await fetch(`/api/projecthub/projects/${projectId}/competitor-library/${ad.brand_id}/ads/${ad.id}/build-video`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "localize", voice, language }),
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
  // A background function that dies without writing an outcome leaves the row
  // spinning forever, so there has to be a way out of it.
  const cancelBuild = async () => {
    try {
      const r = await fetch(`/api/projecthub/projects/${projectId}/competitor-library/${ad.brand_id}/ads/${ad.id}/build-video`, { method: "DELETE" });
      if (!r.ok) throw new Error();
      if (buildPoll.current) { clearInterval(buildPoll.current); buildPoll.current = null; }
      setBuildStatus("");
      toast({ title: "Build stopped" });
    } catch { toast({ title: "Could not stop the build", variant: "destructive" }); }
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-3xl bg-card border border-border rounded-2xl max-h-[90vh] overflow-y-auto shadow-2xl flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between sticky top-0 bg-card z-10">
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
              ? <video src={getUploadUrl(ad.file_path)} controls playsInline preload="metadata" className="w-full rounded-xl bg-slate-100 max-h-72" />
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
                <Eraser className="w-3.5 h-3.5 text-primary" />
                <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-semibold">Remove subtitles (whole video)</p>
              </div>
              <p className="text-[10px] text-muted-foreground leading-snug">
                Erases burned-in captions from the <b>entire</b> video while keeping the original audio, using the same AI cleaning the shots use. Needs a Replicate key.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  onClick={removeSubtitles}
                  disabled={cleanStatus === "pending" || cleanStatus === "processing"}
                  variant="outline"
                  className="flex-1 gap-2 h-8">
                  {cleanStatus === "pending" || cleanStatus === "processing"
                    ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> {cleanStatus === "pending" ? "Queued…" : "Cleaning…"}</>
                    : <><Eraser className="w-3.5 h-3.5" /> {cleanPath ? "Clean again" : "Remove subtitles"}</>}
                </Button>
                {cleanPath && (
                  <a
                    href={`${getUploadUrl(cleanPath)}${getUploadUrl(cleanPath).includes("?") ? "&" : "?"}download=1`}
                    className="inline-flex items-center gap-2 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90">
                    <Download className="w-3.5 h-3.5" /> Download
                  </a>
                )}
              </div>
              {cleanPath && cleanStatus === "done" && (
                <video
                  src={getUploadUrl(cleanPath)}
                  controls
                  playsInline
                  className="w-full rounded-lg border border-border bg-black max-h-72"
                />
              )}
              {cleanPath && cleanStatus === "done" && cleanErr && (
                <p className="text-[10px] text-amber-600">{cleanErr}</p>
              )}
              {cleanStatus === "done" && !cleanPath && (
                <p className="text-[10px] text-amber-600">
                  {cleanErr || "The captions couldn’t be removed cleanly on this video."}
                </p>
              )}
              {cleanStatus === "error" && (
                <p className="text-[10px] text-destructive">{cleanErr || "Cleaning failed — check the Replicate key / logs."}</p>
              )}
            </div>
          )}
          {ad.media_type === "video" && (
            <div className="pt-2 border-t border-border space-y-2">
              <div className="flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-primary" />
                <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-semibold">Localize video (voiceover + subtitles)</p>
              </div>
              <p className="text-[10px] text-muted-foreground leading-snug">
                Keeps the <b>original footage</b> and swaps in a translated voiceover + subtitles in the chosen language, from this creative’s transcript. To compose a brand-new video from your own copy, use the <b>Shots</b> tab. (Extract the transcript first; needs an OpenAI key for the voice.)
              </p>
              <div className="flex items-center gap-2">
                <select
                  value={buildLang}
                  onChange={(e) => setBuildLang(e.target.value)}
                  className="h-8 text-xs rounded-md border border-border bg-background px-2 flex-1"
                  title="Voiceover + subtitle language">
                  <option value="">Language: same as original</option>
                  {BUILD_LANGUAGES.map((l) => (
                    <option key={l} value={l}>{`Language: ${l}`}</option>
                  ))}
                  <option value={LANGUAGE_OTHER}>Language: other…</option>
                </select>
                {buildLang === LANGUAGE_OTHER && (
                  <Input
                    value={buildLangOther}
                    onChange={(e) => setBuildLangOther(e.target.value)}
                    placeholder="e.g. Japanese"
                    className="h-8 text-xs flex-1"
                  />
                )}
              </div>
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
                    ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> {buildStatus === "pending" ? "Queued…" : "Localizing…"}</>
                    : <><Zap className="w-3.5 h-3.5" /> Localize</>}
                </Button>
                {(buildStatus === "pending" || buildStatus === "processing") && (
                  <button
                    type="button"
                    onClick={cancelBuild}
                    title="Stop this build"
                    className="h-8 w-8 shrink-0 grid place-items-center rounded-md border border-border bg-background text-destructive hover:bg-destructive/10">
                    <Square className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {buildStatus === "error" && (
                <p className="text-[10px] text-destructive break-words">
                  {buildError ? `Build failed: ${buildError}` : "Build failed."}
                </p>
              )}
              {buildStatus === "canceled" && (
                <p className="text-[10px] text-muted-foreground">Build stopped.</p>
              )}
              {showInline && buildStatus !== "pending" && buildStatus !== "processing" && buildVideos[0] && (
                <div className="space-y-1.5 pt-1">
                  <div className="rounded-lg overflow-hidden border border-border bg-slate-50">
                    <video src={getUploadUrl(buildVideos[0].file_path)} controls playsInline preload="metadata" className="w-full bg-slate-100 max-h-64" />
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
          {(() => {
            const days = daysRunning(ad);
            const variants = Math.max(1, ad.ad_variants || 1);
            const active = ad.ad_active === "true" || ad.is_active === "true";
            const exactSpend = (ad.spend || "").trim();
            return (
              <div className="pt-2 border-t border-border space-y-2">
                <div className="flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-primary" />
                  <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-semibold">Traction</p>
                </div>
                {exactSpend && (
                  <>
                    <div className="flex items-center justify-between rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 px-3 py-2">
                      <span className="text-sm font-bold inline-flex items-center gap-1">
                        <DollarSign className="w-3.5 h-3.5" />{exactSpend}
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-wider opacity-80">Meta spend</span>
                    </div>
                    {(ad.impressions || ad.reach) && (
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        {ad.impressions && (
                          <div>
                            <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Impressions</p>
                            <p className="font-medium text-foreground">{ad.impressions}</p>
                          </div>
                        )}
                        {ad.reach ? (
                          <div>
                            <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Reach (EU)</p>
                            <p className="font-medium text-foreground">{ad.reach.toLocaleString()}</p>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </>
                )}
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg border border-border bg-muted/30 px-2 py-1.5 text-center">
                    <p className="text-sm font-bold text-foreground">{days !== null ? days : "—"}</p>
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">days live</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 px-2 py-1.5 text-center">
                    <p className={`text-sm font-bold ${active ? "text-green-600" : "text-muted-foreground"}`}>{active ? "Active" : "Inactive"}</p>
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">status</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 px-2 py-1.5 text-center">
                    <p className="text-sm font-bold text-foreground">{variants}</p>
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">variants</p>
                  </div>
                </div>
                {!exactSpend && (
                  <p className="text-[10px] text-muted-foreground leading-snug">
                    Meta’s Ad Library only discloses spend for political / social-issue ads, so there’s no dollar figure for this one. These are the real signals it does give: how long the ad has run, whether it’s still live, and how many variants are active.
                  </p>
                )}
              </div>
            );
          })()}
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
              className={`group relative bg-card border rounded-2xl overflow-hidden hover:shadow-lg transition-all cursor-pointer
                ${c.new_count ? "border-emerald-500/60 hover:border-emerald-500" : "border-border hover:border-primary/40"}`}>

              {/* Preview mosaic */}
              <div className="aspect-[4/3] relative overflow-hidden bg-slate-100">
                <Mosaic items={c.previews && c.previews.length ? c.previews : (c.preview_path ? [{ file_path: c.preview_path, media_type: c.preview_type || "" }] : [])} />
                {/* New creatives from the daily scrape — bottom row keeps clear of
                    the monitoring dot and the hover actions above. */}
                {!!c.new_count && <NewBadge count={c.new_count} className="absolute bottom-2 left-2.5" />}
                {/* Monitoring dot */}
                <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 bg-slate-900/45 backdrop-blur-sm rounded-full px-2 py-0.5">
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
                      className="p-1.5 rounded-lg bg-slate-900/45 backdrop-blur-sm text-white/90 hover:text-white transition-colors">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                  <button onClick={e => del(e, c.id)}
                    className="p-1.5 rounded-lg bg-slate-900/45 backdrop-blur-sm text-white/90 hover:text-red-400 transition-colors">
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
  const [newOnly, setNewOnly] = useState(false);
  // Kept across reloads so the badges stay put for the whole visit, even though
  // the brand is stamped as seen as soon as they are shown.
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
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
      if (!r.ok) return;
      const list: CompetitorAd[] = await r.json();
      setAds(list);
      const arrived = list.filter(a => a.is_new).map(a => a.id);
      if (arrived.length) {
        setNewIds(p => new Set([...p, ...arrived]));
        // Seen from now on, so the next visit starts clean.
        fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${competitor.id}/seen`, { method: "POST" })
          .catch(() => {});
      }
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

  // Bulk-download every selected creative (sequential, small gap — firing all
  // the anchor clicks at once makes the browser drop most of them).
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const downloadSelected = async (ids: number[]) => {
    const list = ads.filter(a => ids.includes(a.id) && a.file_path);
    if (!list.length) { toast({ title: "Nothing downloadable in the selection" }); return; }
    setBulkDownloading(true);
    try {
      for (const ad of list) {
        downloadCreative(ad);
        await new Promise(r => setTimeout(r, 350));
      }
      toast({ title: `Downloading ${list.length} creative${list.length > 1 ? "s" : ""}…` });
    } finally { setBulkDownloading(false); }
  };

  const deleteSelected = async (ids: number[]) => {
    if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} creative${ids.length > 1 ? "s" : ""} from this competitor?`)) return;
    setAds(p => p.filter(a => !ids.includes(a.id)));
    setSelected(new Set());
    await Promise.allSettled(ids.map(id =>
      fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${competitor.id}/ads/${id}`, { method: "DELETE" })
    ));
    toast({ title: `${ids.length} creative${ids.length > 1 ? "s" : ""} removed` });
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

  const isNew = (a: CompetitorAd) => newIds.has(a.id);
  const tierRank = (a: CompetitorAd) => { const t = winnerTier(a); return t === "winner" ? 0 : t === "promising" ? 1 : 2; };
  const filtered = ads
    .filter(a => filter === "all" || a.media_type === filter)
    .filter(a => !winnersOnly || winnerTier(a) !== null)
    .filter(a => !newOnly || isNew(a))
    .filter(a => !search || a.name.toLowerCase().includes(search.toLowerCase()) || a.headline.toLowerCase().includes(search.toLowerCase()) || a.hook.toLowerCase().includes(search.toLowerCase()))
    // Fresh creatives first, then by winner tier.
    .sort((a, b) => (isNew(b) ? 1 : 0) - (isNew(a) ? 1 : 0) || tierRank(a) - tierRank(b));

  const winnerCount = ads.filter(a => winnerTier(a) !== null).length;
  const newCount = ads.filter(isNew).length;
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
        {newCount > 0 && (
          <button onClick={() => setNewOnly(v => !v)}
            title="Creatives added since your last visit"
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg font-semibold border transition-colors ${newOnly ? "bg-emerald-500 border-emerald-500 text-white" : "border-emerald-400/60 text-emerald-600 hover:bg-emerald-50"}`}>
            <Sparkles className="w-3.5 h-3.5" /> New ({newCount})
          </button>
        )}
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
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => downloadSelected(Array.from(selected))}
                disabled={bulkDownloading} className="gap-1.5 h-8 text-xs px-4">
                {bulkDownloading
                  ? <><RefreshCw className="w-3 h-3 animate-spin" /> Downloading…</>
                  : <><Download className="w-3.5 h-3.5" /> Download ({selected.size})</>}
              </Button>
              <Button size="sm" variant="outline" onClick={() => deleteSelected(Array.from(selected))}
                className="gap-1.5 h-8 text-xs px-4 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700">
                <Trash2 className="w-3.5 h-3.5" /> Delete ({selected.size})
              </Button>
              <Button size="sm" onClick={() => saveToTemplates(Array.from(selected))} disabled={saving}
                variant="ghost" className="gap-1.5 h-8 text-xs px-3 text-muted-foreground">
                {saving
                  ? <><RefreshCw className="w-3 h-3 animate-spin" /> Saving...</>
                  : <><Bookmark className="w-3.5 h-3.5" /> Templates</>}
              </Button>
            </div>
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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {filtered.map((ad, idx) => {
            const isSelected = selected.has(ad.id);
            const hasFile = !!ad.file_path;
            return (
              <div key={ad.id}
                className={`group relative rounded-2xl overflow-hidden bg-card border-2 transition-all duration-200 cursor-pointer
                  ${isSelected
                    ? "border-primary shadow-[0_0_0_3px_rgba(34,197,94,0.2)]"
                    : isNew(ad)
                      ? "border-emerald-500/70 hover:shadow-lg"
                      : "border-transparent hover:border-border hover:shadow-lg"}`}
                onClick={() => setDetailAd(ad)}>

                {/* Metrics bar — key ad signals on top, clear */}
                <CardMetrics ad={ad} country={countryFromAdLibraryUrl(competitor.ads_library_url)} />

                {/* Creative — fixed aspect, uniform cards */}
                <div className="aspect-[4/5] relative overflow-hidden rounded-xl bg-slate-100">
                  {hasFile ? (
                    ad.media_type === "video" ? (
                      <div className="w-full h-full relative bg-slate-100">
                        <video src={videoThumbSrc(ad.file_path)} muted playsInline preload="metadata"
                          className="w-full h-full object-cover" />
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <div className="w-11 h-11 rounded-full bg-slate-900/45 flex items-center justify-center">
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

                  {/* New + Winner + Active badges (stacked) */}
                  <div className="absolute top-2 left-2 flex flex-col items-start gap-1">
                    {isNew(ad) && <NewBadge />}
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
  const [newOnly, setNewOnly] = useState(false);
  const [detailAd, setDetailAd] = useState<CreativeWithBrand | null>(null);
  // brand_id -> market (from each competitor's Ad Library country=), used to
  // pick the right CPM when estimating spend.
  const [countryByBrand, setCountryByBrand] = useState<Map<number, string>>(new Map());

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/creatives`);
      if (r.ok) setCreatives(await r.json());
      const rc = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library`);
      if (rc.ok) {
        const comps: CompetitorWithStats[] = await rc.json();
        const m = new Map<number, string>();
        for (const c of comps) m.set(c.id, countryFromAdLibraryUrl(c.ads_library_url));
        setCountryByBrand(m);
      }
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
  const newCount = creatives.filter(c => c.is_new).length;
  const filtered = creatives
    .filter(c => media === "all" || c.media_type === media)
    .filter(c => brand === "all" || c.brand_name === brand)
    .filter(c => !winnersOnly || winnerTier(c) !== null)
    .filter(c => !newOnly || c.is_new)
    .filter(c => !search || `${c.name} ${c.headline} ${c.hook} ${c.brand_name}`.toLowerCase().includes(search.toLowerCase()))
    // Fresh creatives first, then by winner tier.
    .sort((a, b) => (b.is_new ? 1 : 0) - (a.is_new ? 1 : 0) || tierRank(a) - tierRank(b));

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
        {newCount > 0 && (
          <button onClick={() => setNewOnly(v => !v)}
            title="Creatives added since your last visit"
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg font-semibold border transition-colors ${newOnly ? "bg-emerald-500 border-emerald-500 text-white" : "border-emerald-400/60 text-emerald-600 hover:bg-emerald-50"}`}>
            <Sparkles className="w-3.5 h-3.5" /> New ({newCount})
          </button>
        )}
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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {filtered.map((ad, idx) => (
            <div key={ad.id} onClick={() => setDetailAd(ad)}
              className={`group relative rounded-2xl overflow-hidden bg-card border-2 hover:shadow-lg transition-all cursor-pointer
                ${ad.is_new ? "border-emerald-500/70" : "border-transparent hover:border-border"}`}>
              <CardMetrics ad={ad} country={countryByBrand.get(ad.brand_id)} />
              <div className="aspect-[4/5] relative overflow-hidden rounded-xl">
                {ad.file_path
                  ? <MediaThumb path={ad.file_path} type={ad.media_type} className="w-full h-full" />
                  : <AdPlaceholder ad={ad} index={idx} />}
                <div className="absolute top-2 left-2 flex flex-col items-start gap-1">
                  {ad.is_new && <NewBadge />}
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
  screenshot_desktop?: string;
  screenshot_mobile?: string;
  html_url: string;
  editor_url: string;
  created_at: string;
};

function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

// Live thumbnail rendered from the SAVED HTML (page_html mirror). Used when a
// landing has no stored screenshot (e.g. rows recovered after the archive
// wipe): the saved page itself — full CSS, images, layout — becomes the
// preview. Fetch is lazy (IntersectionObserver) so a big grid stays cheap.
function HtmlThumb({ htmlUrl, className = "" }: { htmlUrl: string; className?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [scale, setScale] = useState(0.22);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !htmlUrl) return;
    const obs = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      obs.disconnect();
      setScale((el.clientWidth || 280) / 1280);
      fetch(htmlUrl)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
        .then((t) => { if (t && t.length > 100) setHtml(t); else setFailed(true); })
        .catch(() => setFailed(true));
    }, { rootMargin: "400px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [htmlUrl]);

  return (
    <div ref={ref} className={`relative overflow-hidden bg-white ${className}`}>
      {html ? (
        <iframe
          srcDoc={html}
          sandbox=""
          scrolling="no"
          tabIndex={-1}
          title="Landing preview"
          className="absolute top-0 left-0 border-0 pointer-events-none select-none"
          style={{ width: "1280px", height: "1800px", transform: `scale(${scale})`, transformOrigin: "top left" }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-slate-100">
          {failed
            ? <Globe className="w-10 h-10 text-slate-400" />
            : <RefreshCw className="w-6 h-6 text-slate-300 animate-spin" />}
        </div>
      )}
    </div>
  );
}

function CompetitorLandingsView({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const router = useRouter();
  const [landings, setLandings] = useState<Landing[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<Landing | null>(null);
  const [openFolder, setOpenFolder] = useState<string | null>(null);

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

  // Load EVERY step of an open funnel into Clone/Swipe as an ordered page list,
  // so the whole funnel can be swiped/cloned in one go.
  const cloneSwipeFolder = (items: Landing[]) => {
    const steps = items
      .filter((l) => !!l.url)
      .map((l) => ({ url: l.url, name: l.name || "Step", type: l.page_type || "landing" }));
    if (!steps.length) { toast({ title: "No steps with a source URL to swipe", variant: "destructive" }); return; }
    const q = new URLSearchParams({ swipe_steps: JSON.stringify(steps) });
    router.push(`/front-end-funnel?${q.toString()}`);
  };

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/landings`);
      if (r.ok) setLandings(await r.json());
      void fillLandingLibrary(projectId);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [projectId]);

  const del = async (l: Landing) => {
    setPreview(p => (p?.id === l.id ? null : p));
    setLandings(p => p.filter(x => x.id !== l.id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/landings/${l.id}`, { method: "DELETE" });
    toast({ title: "Landing removed" });
  };

  // Pull the saved HTML and hand it to the browser as a .html download, so the
  // page can be opened/edited offline without relying on the original link.
  const downloadHtml = async (l: Landing) => {
    try {
      const r = await fetch(l.html_url);
      if (!r.ok) throw new Error(String(r.status));
      const html = await r.text();
      const blob = new Blob([html], { type: "text/html" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(l.name || hostOf(l.url) || "landing").replace(/[^\w.-]+/g, "-").slice(0, 80)}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch {
      toast({ title: "Could not download the HTML", variant: "destructive" });
    }
  };

  const filtered = landings.filter(l =>
    !search || `${l.name} ${l.url} ${l.category} ${(l.tags || []).join(" ")}`.toLowerCase().includes(search.toLowerCase()));

  // All pages of one funnel share category = domain — group them into a single
  // folder so the whole funnel reads as ONE entry (not N loose cards).
  const stepNum = (name: string) => { const m = /step\s*(\d+)/i.exec(name || ""); return m ? parseInt(m[1], 10) : 9999; };
  const folderKey = (l: Landing) => (l.category && l.category.trim()) || hostOf(l.url) || "Other";
  const folderMap = new Map<string, Landing[]>();
  for (const l of filtered) {
    const k = folderKey(l);
    if (!folderMap.has(k)) folderMap.set(k, []);
    folderMap.get(k)!.push(l);
  }
  const folders = Array.from(folderMap.entries())
    .map(([name, items]) => ({
      name,
      items: items.slice().sort((a, b) => stepNum(a.name) - stepNum(b.name) || a.created_at.localeCompare(b.created_at)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const openItems = openFolder ? (folders.find(f => f.name === openFolder)?.items || []) : [];

  // A single landing/step card — masonry style: domain header on top, then the
  // FULL-length screenshot (capped, with a soft fade), like a swipe-file board.
  const card = (l: Landing) => {
    const host = hostOf(l.url);
    return (
      <div key={l.id}
        onClick={() => setPreview(l)}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPreview(l); } }}
        className="group relative bg-card border border-border rounded-2xl overflow-hidden hover:border-primary/40 hover:shadow-lg transition-all cursor-pointer">
        {/* Domain header */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/60">
          {host ? (
            <img src={`https://www.google.com/s2/favicons?domain=${host}&sz=32`} alt="" className="w-4 h-4 rounded-sm flex-shrink-0"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
          ) : <Globe className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
          <span className="text-[11px] font-medium text-muted-foreground truncate flex-1">{host || l.name}</span>
          <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground uppercase tracking-wide flex-shrink-0">
            {l.page_type || "landing"}
          </span>
        </div>
        {/* Fixed-height screenshot — uniform cards */}
        <div className="relative w-full aspect-[3/4] overflow-hidden bg-slate-100">
          {l.screenshot ? (
            <img src={l.screenshot} alt={l.name} className="w-full h-full object-cover object-top group-hover:scale-[1.02] transition-transform" />
          ) : l.html_url ? (
            <HtmlThumb htmlUrl={l.html_url} className="w-full h-full" />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-slate-100">
              <Globe className="w-10 h-10 text-slate-400" />
            </div>
          )}
          <span className="absolute bottom-2 right-2 flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-900/60 backdrop-blur-sm text-white opacity-0 group-hover:opacity-100 transition-opacity">
            <Eye className="w-3 h-3" /> Preview
          </span>
          <button onClick={(e) => { e.stopPropagation(); del(l); }}
            className="absolute top-2 right-2 p-1.5 rounded-lg bg-slate-900/45 backdrop-blur-sm text-white/90 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
            title="Remove landing">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="px-3 py-2.5">
          <p className="text-sm font-semibold text-foreground truncate">{l.name}</p>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-bold text-foreground">Competitor Landings</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Landing &amp; funnel pages saved from the browser extension. Each funnel is one folder — open it to see every step.
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
      ) : openFolder ? (
        <div className="space-y-3">
          <button onClick={() => setOpenFolder(null)}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground hover:text-primary transition-colors">
            <ArrowLeft className="w-4 h-4" /> All funnels
          </button>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-base font-bold text-foreground truncate">{openFolder}</p>
            <span className="text-[11px] text-muted-foreground">{openItems.length} step{openItems.length === 1 ? "" : "s"}</span>
            <button onClick={() => cloneSwipeFolder(openItems)}
              className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
              <Repeat className="w-3.5 h-3.5" /> Swipe all steps
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {openItems.map(card)}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {folders.map(f => {
            const cover = f.items[0];
            const host = hostOf(cover?.url || "");
            return (
              <div key={f.name}
                onClick={() => setOpenFolder(f.name)}
                role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenFolder(f.name); } }}
                className="group relative bg-card border border-border rounded-2xl overflow-hidden hover:border-primary/40 hover:shadow-lg transition-all cursor-pointer">
                {/* Domain header */}
                <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/60">
                  {host ? (
                    <img src={`https://www.google.com/s2/favicons?domain=${host}&sz=32`} alt="" className="w-4 h-4 rounded-sm flex-shrink-0"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                  ) : <Globe className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                  <span className="text-[11px] font-medium text-muted-foreground truncate flex-1">{host || f.name}</span>
                  <span className="flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full bg-primary/10 text-primary uppercase tracking-wide flex-shrink-0">
                    <Folder className="w-3 h-3" /> {f.items.length}
                  </span>
                </div>
                {/* Fixed-height cover screenshot — uniform cards */}
                <div className="relative w-full aspect-[3/4] overflow-hidden bg-slate-100">
                  {cover?.screenshot ? (
                    <img src={cover.screenshot} alt={f.name} className="w-full h-full object-cover object-top group-hover:scale-[1.02] transition-transform" />
                  ) : cover?.html_url ? (
                    <HtmlThumb htmlUrl={cover.html_url} className="w-full h-full" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-slate-100">
                      <Globe className="w-10 h-10 text-slate-400" />
                    </div>
                  )}
                  <span className="absolute bottom-2 right-2 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-primary/85 backdrop-blur-sm text-primary-foreground">
                    {f.items.length} step{f.items.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="px-3 py-2.5">
                  <p className="text-sm font-semibold text-foreground truncate">{f.name}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setPreview(null)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 p-4 border-b border-border">
              <div className="min-w-0">
                <p className="text-sm font-bold text-foreground truncate">{preview.name}</p>
                <p className="text-[11px] text-muted-foreground truncate flex items-center gap-1">
                  <Globe className="w-3 h-3" /> {hostOf(preview.url)}
                </p>
              </div>
              <button onClick={() => setPreview(null)} className="text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 overflow-y-auto flex-1 bg-muted/30">
              {(preview.screenshot_desktop || preview.screenshot_mobile) ? (
                <div className="flex flex-wrap gap-4 justify-center items-start">
                  {preview.screenshot_desktop && (
                    <figure className="flex-1 min-w-[260px] max-w-full">
                      <figcaption className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 text-center">Desktop</figcaption>
                      <img src={preview.screenshot_desktop} alt="Desktop screenshot"
                        className="w-full rounded-lg border border-border bg-white" />
                    </figure>
                  )}
                  {preview.screenshot_mobile && (
                    <figure className="w-40 shrink-0">
                      <figcaption className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 text-center">Mobile</figcaption>
                      <img src={preview.screenshot_mobile} alt="Mobile screenshot"
                        className="w-full rounded-lg border border-border bg-white" />
                    </figure>
                  )}
                </div>
              ) : preview.screenshot ? (
                <img src={preview.screenshot} alt={preview.name}
                  className="w-full rounded-lg border border-border bg-white" />
              ) : preview.html_url ? (
                // No screenshots stored — render the saved page itself (full
                // HTML/CSS/JS from the page_html mirror) as a live preview.
                <iframe src={preview.html_url} title={preview.name}
                  sandbox="allow-scripts allow-same-origin"
                  className="w-full h-[65vh] rounded-lg border border-border bg-white" />
              ) : (
                <div className="py-16 text-center text-sm text-muted-foreground">No screenshots saved for this page.</div>
              )}
            </div>

            <div className="flex items-center gap-2 p-4 border-t border-border flex-wrap">
              <button onClick={() => downloadHtml(preview)}
                className="flex items-center gap-1.5 bg-primary text-white text-xs font-semibold py-2 px-3 rounded-lg hover:opacity-90 transition-opacity">
                <Download className="w-3.5 h-3.5" /> Download HTML
              </button>
              <button onClick={() => cloneSwipe(preview)}
                className="flex items-center gap-1.5 border border-border text-foreground text-xs font-semibold py-2 px-3 rounded-lg hover:bg-muted transition-colors">
                <Repeat className="w-3.5 h-3.5" /> Clone / Swipe
              </button>
              <a href={preview.html_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 border border-border text-foreground text-xs font-semibold py-2 px-3 rounded-lg hover:bg-muted transition-colors">
                <Eye className="w-3.5 h-3.5" /> View HTML
              </a>
              {preview.url && (
                <a href={preview.url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 border border-border text-muted-foreground text-xs font-semibold py-2 px-3 rounded-lg hover:bg-muted transition-colors ml-auto">
                  <ExternalLink className="w-3.5 h-3.5" /> Original
                </a>
              )}
            </div>
          </div>
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
  const [brands, setBrands] = useState<{ id: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "clean" | "subs">("all");
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<Shot | null>(null);
  // Compose a brand-new video from these shots + your own copy.
  const [showCreate, setShowCreate] = useState(false);

  const load = async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [sr, br] = await Promise.all([
        fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/shots`, { cache: "no-store" }),
        fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library`, { cache: "no-store" }),
      ]);
      const sj = await sr.json().catch(() => []);
      setShots(Array.isArray(sj) ? sj : []);
      const bj = await br.json().catch(() => []);
      const list = (Array.isArray(bj) ? bj : []).map((b: { id: number; name: string }) => ({ id: b.id, name: b.name }));
      setBrands(list);
      const map: Record<number, string> = {};
      for (const b of list) map[b.id] = b.name;
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
      <div key={s.id} className="group rounded-xl overflow-hidden border border-border bg-slate-50">
        <div className="relative">
          <button onClick={() => setPlaying(s)} className="block w-full aspect-[9/16] bg-slate-100">
            {s.thumb_path
              ? <img src={getUploadUrl(s.thumb_path)} alt="" className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center text-slate-400"><Play className="w-6 h-6" /></div>}
          </button>
          <span className="absolute top-1.5 left-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-slate-900/70 text-white">
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
            <span className="absolute bottom-1.5 left-1.5 max-w-[80%] truncate text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-900/70 text-white">
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
              className="absolute inset-x-1.5 bottom-8 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-900/70 hover:bg-slate-900/80 text-white rounded-md px-1.5 py-1 text-[10px] font-bold flex items-center justify-center gap-1"
              title="Run the AI cleanup again on this shot">
              <RefreshCw className="w-3 h-3" /> Redo cleanup
            </button>
          )}
          <button
            onClick={() => remove(s)}
            className="absolute bottom-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-900/70 text-white rounded-md p-1"
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
            Pieces cut from competitor videos (audio removed). Use the <b>CLEAN</b> ones as B-roll to <b>compose a new video from your copy</b>.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            onClick={() => setShowCreate(true)}
            disabled={cleanCount === 0}
            title={cleanCount === 0 ? "Split or clean some shots first" : "Compose a new video from these shots + your copy"}
            className="gap-1.5 h-8">
            <Sparkles className="w-3.5 h-3.5" /> Create video from copy
          </Button>
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

      {showCreate && (
        <CustomVideoModal
          projectId={projectId}
          brands={brands}
          onClose={() => setShowCreate(false)}
          onQueued={() => { setShowCreate(false); load(true); }}
        />
      )}

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
            key={playing.id}
            src={getUploadUrl(playing.clean_path || playing.file_path)}
            onError={(e) => {
              // Only fall back to the ORIGINAL (subtitled) clip if the cleaned
              // copy is genuinely broken — and only once. The previous version
              // compared an absolute src against a relative URL, so it always
              // "differed" and swapped to the original on the very first hiccup,
              // making every cleaned shot look like it still had subtitles.
              const el = e.currentTarget;
              const orig = getUploadUrl(playing.file_path);
              if (playing.clean_path && !el.dataset.fellBack && !el.src.endsWith(orig)) {
                el.dataset.fellBack = "1";
                el.src = orig;
              }
            }}
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

/**
 * Brand-level "create a custom video": pick a product, paste your own copy,
 * choose a language + voice, and build a new video from that product's real
 * shot pool. Not tied to any single competitor creative (ad_id = 0).
 */
function CustomVideoModal({
  projectId, brands, onClose, onQueued,
}: {
  projectId: string;
  brands: { id: number; name: string }[];
  onClose: () => void;
  onQueued: () => void;
}) {
  const { toast } = useToast();
  const [brandId, setBrandId] = useState<number | "">(brands[0]?.id ?? "");
  const [copy, setCopy] = useState("");
  const [lang, setLang] = useState("");
  const [langOther, setLangOther] = useState("");
  const [voice, setVoice] = useState("alloy");
  const [status, setStatus] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  // Stop watching after this many 5s polls (~16 min) so the button never gets
  // stuck on "Building…" forever if a background job dies without reporting back.
  const pollCount = useRef(0);
  const POLL_MAX = 200;

  const stopWatching = () => {
    if (poll.current) { clearInterval(poll.current); poll.current = null; }
    setStatus("");
  };

  useEffect(() => () => {
    if (previewAudio.current) previewAudio.current.pause();
    if (poll.current) clearInterval(poll.current);
  }, []);

  const previewVoice = async (v: string) => {
    try {
      if (previewAudio.current) { previewAudio.current.pause(); previewAudio.current = null; }
      setPreviewLoading(true);
      const r = await fetch(`/api/tts-sample?voice=${encodeURIComponent(v)}`);
      if (!r.ok) { toast({ title: "Voice preview failed", variant: "destructive" }); return; }
      const audio = new Audio(URL.createObjectURL(await r.blob()));
      previewAudio.current = audio;
      audio.onended = () => { if (previewAudio.current === audio) previewAudio.current = null; };
      await audio.play();
    } catch { toast({ title: "Voice preview failed", variant: "destructive" }); }
    finally { setPreviewLoading(false); }
  };

  const pollStatus = (bid: number) => {
    if (poll.current) clearInterval(poll.current);
    pollCount.current = 0;
    poll.current = setInterval(async () => {
      pollCount.current += 1;
      if (pollCount.current > POLL_MAX) {
        stopWatching();
        toast({ title: "Still building in the background", description: "Taking longer than usual — it’ll appear in New Creatives when done." });
        onQueued();
        return;
      }
      try {
        const r = await fetch(`/api/projecthub/projects/${projectId}/competitor-library/${bid}/build-video`, { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        const s = j?.job?.status || "";
        setStatus(s);
        if (s === "done") {
          if (poll.current) { clearInterval(poll.current); poll.current = null; }
          toast({ title: "Custom video ready 🎬", description: "Saved to New Creatives." });
          onQueued();
        } else if (s === "error" || s === "canceled") {
          if (poll.current) { clearInterval(poll.current); poll.current = null; }
          toast({ title: "Build failed", description: String(j?.job?.error || "").slice(0, 160), variant: "destructive" });
        }
      } catch { /* keep polling */ }
    }, 5000);
  };

  const build = async () => {
    if (!brandId) { toast({ title: "Pick a folder to save under first", variant: "destructive" }); return; }
    if (copy.trim().length < 30) { toast({ title: "Paste a bit more copy (min ~30 chars)", variant: "destructive" }); return; }
    setStatus("pending");
    const language = lang === LANGUAGE_OTHER ? langOther.trim() : lang;
    // The start request itself can take a while (it splits the copy into scenes)
    // — bound it so the button can't sit on "Queued…" forever if it hangs.
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), 130000);
    try {
      const r = await fetch(`/api/projecthub/projects/${projectId}/competitor-library/${brandId}/build-video`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice, language, script: copy.trim() }),
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        toast({ title: "Queued for build", description: `${j.scenes || ""} scenes — real clean footage only.` });
        pollStatus(Number(brandId));
      } else {
        setStatus("");
        toast({ title: j.error || "Could not start build", variant: "destructive" });
      }
    } catch (e) {
      setStatus("");
      const aborted = (e as Error).name === "AbortError";
      toast({ title: aborted ? "Start timed out — try again" : "Could not start build", variant: "destructive" });
    } finally {
      clearTimeout(abortTimer);
    }
  };

  const building = status === "pending" || status === "processing";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-card border border-border rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">Create custom video</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-[11px] text-muted-foreground leading-snug">
            Paste your copy and the builder auto-picks clips from <b>all your clean shots</b>, matched line-by-line to the script, then voices and subtitles them. Great for new angles or shipping the same footage to another geo/language.
          </p>
          <div>
            <p className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Save under (folder)</p>
            <select
              value={brandId}
              onChange={(e) => setBrandId(e.target.value ? Number(e.target.value) : "")}
              className="w-full h-9 text-sm rounded-md border border-border bg-background px-2">
              {brands.length === 0 && <option value="">No products yet</option>}
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <p className="text-[9px] text-muted-foreground mt-1 leading-snug">
              This only files the result — footage is <b>not</b> limited to it. Clips are chosen from every clean shot in the project and matched to the script.
            </p>
          </div>
          <div>
            <p className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Your copy</p>
            <textarea
              value={copy}
              onChange={(e) => setCopy(e.target.value)}
              placeholder="Paste the script you want spoken. It’ll be split into beats, voiced and subtitled automatically."
              rows={6}
              className="w-full text-xs rounded-md border border-border bg-background p-2 leading-relaxed resize-y"
            />
          </div>
          <div className="flex items-center gap-2">
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              className="h-9 text-xs rounded-md border border-border bg-background px-2 flex-1">
              <option value="">Language: as written</option>
              {BUILD_LANGUAGES.map((l) => <option key={l} value={l}>{`Language: ${l}`}</option>)}
              <option value={LANGUAGE_OTHER}>Language: other…</option>
            </select>
            {lang === LANGUAGE_OTHER && (
              <Input value={langOther} onChange={(e) => setLangOther(e.target.value)} placeholder="e.g. Japanese" className="h-9 text-xs flex-1" />
            )}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={voice}
              onChange={(e) => { setVoice(e.target.value); previewVoice(e.target.value); }}
              className="h-9 text-xs rounded-md border border-border bg-background px-2 flex-1">
              {["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map((v) => (
                <option key={v} value={v}>{`Voice: ${v}`}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => previewVoice(voice)}
              disabled={previewLoading}
              title="Preview this voice"
              className="h-9 w-9 shrink-0 grid place-items-center rounded-md border border-border bg-background hover:bg-muted disabled:opacity-50">
              {previewLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
        <div className="p-4 border-t border-border">
          <Button onClick={build} disabled={building} className="w-full gap-2">
            {building
              ? <><RefreshCw className="w-4 h-4 animate-spin" /> {status === "pending" ? "Queued…" : "Building…"}</>
              : <><Zap className="w-4 h-4" /> Build video</>}
          </Button>
          {building && (
            <div className="mt-2 text-center space-y-1">
              <p className="text-[10px] text-muted-foreground">
                Runs on the server — you can keep working; it’ll appear in New Creatives when done.
              </p>
              <button
                type="button"
                onClick={() => { stopWatching(); toast({ title: "Stopped watching", description: "The build may still finish on the server and show up in New Creatives." }); }}
                className="text-[10px] text-muted-foreground underline hover:text-foreground">
                Stop watching
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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
            <div key={v.id} className="group relative rounded-xl overflow-hidden border border-border bg-slate-50">
              <button onClick={() => setPlaying(v)} className="block w-full aspect-[9/16] bg-slate-100">
                {v.thumb_path
                  ? <img src={getUploadUrl(v.thumb_path)} alt="" className="w-full h-full object-cover" />
                  : <div className="w-full h-full flex items-center justify-center text-slate-400"><Play className="w-7 h-7" /></div>}
              </button>
              <span className="absolute top-1.5 left-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-slate-900/70 text-white">
                {Math.round(v.duration_sec)}s
              </span>
              <span className="absolute top-1.5 right-1.5 text-[9px] font-black px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground">
                NEW
              </span>
              {brandNames[v.brand_id] && (
                <span className="absolute bottom-9 left-1.5 max-w-[80%] truncate text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-900/70 text-white">
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
              <div key={v.id} className="group rounded-xl overflow-hidden border border-border bg-slate-50">
                <button onClick={() => setPlaying(v)} className="relative block w-full aspect-video bg-slate-100">
                  <video src={videoThumbSrc(v.file_path)} preload="metadata" className="w-full h-full object-cover" muted />
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="bg-slate-900/50 rounded-full p-2"><Play className="w-5 h-5 text-white" /></span>
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

// ──────────────────────────────────────────────────────────────────────────
// SECTOR OVERVIEW — aggregated market-intelligence dashboard across every
// tracked competitor in the project. Spend/reach are ESTIMATES (Meta does not
// disclose them for commercial ads) and are always marked "est.".
// ──────────────────────────────────────────────────────────────────────────

// Numeric spend estimate (mirrors CardMetrics' string logic) for aggregation.
function estSpendNumber(ad: CompetitorAd, country?: string): number {
  const reach = typeof ad.reach === "number" && ad.reach > 0 ? ad.reach : null;
  const cpm = cpmFor(ad, country);
  if (reach) return (reach * EST_FREQUENCY / 1000) * cpm;
  const d = daysRunning(ad);
  const variants = ad.ad_variants && ad.ad_variants > 1 ? ad.ad_variants : 1;
  if (d && d > 0) return d * DAILY_SPEND_BASE * Math.sqrt(Math.max(1, variants));
  return 0;
}

function isActiveAd(ad: CompetitorAd): boolean {
  return ad.ad_active === "true" || ad.is_active === "true";
}

// Monday-based ISO week key (YYYY-MM-DD of that Monday).
function weekKey(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const day = (d.getDay() + 6) % 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
}

function KpiCard({ children }: { children: ReactNode }) {
  return <div className="bg-card border border-border rounded-2xl p-4 flex flex-col">{children}</div>;
}

function SectorOverview({ projectId, onOpenBrand }: { projectId: string; onOpenBrand?: (b: CompetitorWithStats) => void }) {
  const { toast } = useToast();
  const [brands, setBrands] = useState<CompetitorWithStats[]>([]);
  const [creatives, setCreatives] = useState<CreativeWithBrand[]>([]);
  const [landings, setLandings] = useState<Landing[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailAd, setDetailAd] = useState<CreativeWithBrand | null>(null);

  const delAd = async (ad: CompetitorAd) => {
    setCreatives(p => p.filter(a => a.id !== ad.id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${ad.brand_id}/ads/${ad.id}`, { method: "DELETE" });
    toast({ title: "Creative removed" });
  };
  const saveTpl = async (ad: CompetitorAd) => {
    const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/${ad.brand_id}/ads/save-to-templates`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ad_ids: [ad.id] }),
    });
    if (r.ok) toast({ title: "Saved to templates!" });
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const [rb, rc, rl] = await Promise.all([
          fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library`),
          fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/competitor-library/creatives`),
          fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/landings`),
        ]);
        if (!alive) return;
        if (rb.ok) setBrands(await rb.json());
        if (rc.ok) setCreatives(await rc.json());
        if (rl.ok) setLandings(await rl.json());
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [projectId]);

  const countryByBrand = useMemo(() => {
    const m = new Map<number, string>();
    for (const b of brands) m.set(b.id, countryFromAdLibraryUrl(b.ads_library_url));
    return m;
  }, [brands]);

  const stats = useMemo(() => {
    let totalSpend = 0, totalReach = 0, active = 0, images = 0, videos = 0;
    for (const ad of creatives) {
      totalSpend += estSpendNumber(ad, countryByBrand.get(ad.brand_id) || "");
      if (typeof ad.reach === "number" && ad.reach > 0) totalReach += ad.reach;
      if (isActiveAd(ad)) active++;
      if (ad.media_type === "video") videos++; else images++;
    }
    return { totalSpend, totalReach, active, images, videos, total: creatives.length };
  }, [creatives, countryByBrand]);

  const weekly = useMemo(() => {
    const map = new Map<string, number>();
    for (const ad of creatives) {
      const k = weekKey(ad.ad_started_at || ad.created_at);
      if (!k) continue;
      map.set(k, (map.get(k) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(-26)
      .map(([week, count]) => ({ label: week.slice(5), count }));
  }, [creatives]);

  const avgPerDay = weekly.length ? (weekly.reduce((s, w) => s + w.count, 0) / (weekly.length * 7)) : 0;

  const countries = useMemo(() => {
    const map = new Map<string, number>();
    for (const ad of creatives) {
      const c = countryByBrand.get(ad.brand_id) || "—";
      map.set(c, (map.get(c) || 0) + 1);
    }
    const total = creatives.length || 1;
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([code, n]) => ({ code: code || "—", n, pct: Math.round((n / total) * 100) }));
  }, [creatives, countryByBrand]);

  const brandSpend = useMemo(() => {
    const map = new Map<number, { id: number; name: string; spend: number; ads: number }>();
    for (const ad of creatives) {
      const cur = map.get(ad.brand_id) || { id: ad.brand_id, name: ad.brand_name || `Brand ${ad.brand_id}`, spend: 0, ads: 0 };
      cur.spend += estSpendNumber(ad, countryByBrand.get(ad.brand_id) || "");
      cur.ads += 1;
      map.set(ad.brand_id, cur);
    }
    return [...map.values()].sort((a, b) => b.spend - a.spend).slice(0, 8);
  }, [creatives, countryByBrand]);

  const topAds = useMemo(() =>
    [...creatives]
      .map(ad => ({ ad, spend: estSpendNumber(ad, countryByBrand.get(ad.brand_id) || "") }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 12),
    [creatives, countryByBrand]);

  const latest = useMemo(() =>
    [...creatives]
      .sort((a, b) => new Date(b.ad_started_at || b.created_at).getTime() - new Date(a.ad_started_at || a.created_at).getTime())
      .slice(0, 5),
    [creatives]);

  const topLandings = useMemo(() => {
    const map = new Map<string, { host: string; count: number; screenshot?: string; url: string }>();
    for (const l of landings) {
      const host = hostOf(l.url) || l.name;
      const cur = map.get(host) || { host, count: 0, screenshot: l.screenshot, url: l.url };
      cur.count += 1;
      if (!cur.screenshot && l.screenshot) cur.screenshot = l.screenshot;
      map.set(host, cur);
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 6);
  }, [landings]);

  const donut = [
    { name: "Image", value: stats.images, color: "#3b82f6" },
    { name: "Video", value: stats.videos, color: "#a855f7" },
  ];
  const money = (n: number) => `$${fmtCompact(Math.round(n))}`;

  if (loading) {
    return <div className="py-20 text-center text-sm text-muted-foreground">Loading market intelligence…</div>;
  }

  if (brands.length === 0) {
    return (
      <div className="py-20 text-center border-2 border-dashed border-border rounded-2xl">
        <Gauge className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
        <p className="text-sm font-semibold text-foreground mb-1">No competitors tracked yet</p>
        <p className="text-xs text-muted-foreground max-w-md mx-auto">
          Add competitors in the <b>Ads Library</b> tab. Once their ads are scraped, this overview
          shows sector-wide spend, reach and the top-performing ads.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-bold text-foreground">Sector Overview</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Aggregated across {brands.length} tracked competitor{brands.length === 1 ? "" : "s"}.
            Spend &amp; reach are modelled estimates (<span className="font-semibold">est.</span>), not disclosed figures.
          </p>
        </div>
      </div>

      {/* ── KPI ROW ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* Ads + image/video donut */}
        <KpiCard>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Ads tracked</p>
          <div className="flex items-center gap-3 mt-1">
            <div className="relative w-24 h-24 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={donut} dataKey="value" innerRadius={30} outerRadius={44} paddingAngle={2} stroke="none">
                    {donut.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-lg font-black text-foreground leading-none">{stats.total}</span>
                <span className="text-[9px] text-muted-foreground">ads</span>
              </div>
            </div>
            <div className="space-y-1 text-xs">
              <p className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /><b>{stats.active}</b> active</p>
              <p className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /><b>{stats.images}</b> image</p>
              <p className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-purple-500" /><b>{stats.videos}</b> video</p>
            </div>
          </div>
        </KpiCard>

        {/* Total est. spend + latest moves */}
        <KpiCard>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
            <DollarSign className="w-3.5 h-3.5" /> Total AdSpend <span className="text-[9px] font-semibold text-muted-foreground/70">est.</span>
          </p>
          <p className="text-2xl font-black text-foreground mt-1">{money(stats.totalSpend)}</p>
          <p className="text-[10px] text-muted-foreground mb-1.5">Latest moves</p>
          <div className="space-y-1 overflow-hidden">
            {latest.slice(0, 3).map(a => (
              <p key={a.id} className="text-[11px] text-muted-foreground truncate flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                <b className="text-foreground">{a.brand_name}</b> · {a.headline || a.name || "new ad"}
              </p>
            ))}
            {latest.length === 0 && <p className="text-[11px] text-muted-foreground">—</p>}
          </div>
        </KpiCard>

        {/* Total est. reach + country distribution */}
        <KpiCard>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
            <Eye className="w-3.5 h-3.5" /> Total Reach <span className="text-[9px] font-semibold text-muted-foreground/70">est.</span>
          </p>
          <p className="text-2xl font-black text-foreground mt-1">{fmtCompact(stats.totalReach)}</p>
          <p className="text-[10px] text-muted-foreground mb-1.5">Country distribution</p>
          <div className="space-y-1">
            {countries.map(c => (
              <div key={c.code} className="flex items-center gap-2 text-[11px]">
                <span className="w-7 font-semibold text-foreground">{c.code}</span>
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-primary" style={{ width: `${c.pct}%` }} />
                </div>
                <span className="w-8 text-right text-muted-foreground">{c.pct}%</span>
              </div>
            ))}
          </div>
        </KpiCard>

        {/* Brands / most active */}
        <KpiCard>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
            <Users className="w-3.5 h-3.5" /> Competitors
          </p>
          <p className="text-2xl font-black text-foreground mt-1">{brands.length}</p>
          <p className="text-[10px] text-muted-foreground mb-1.5">Top spenders <span className="text-muted-foreground/70">est.</span></p>
          <div className="space-y-1">
            {brandSpend.slice(0, 4).map(b => (
              <button key={b.id}
                onClick={() => { const full = brands.find(x => x.id === b.id); if (full && onOpenBrand) onOpenBrand(full); }}
                className="w-full flex items-center gap-2 text-[11px] hover:text-primary transition-colors">
                <span className="flex-1 text-left truncate font-medium text-foreground">{b.name}</span>
                <span className="text-muted-foreground">{money(b.spend)}</span>
              </button>
            ))}
          </div>
        </KpiCard>
      </div>

      {/* ── CHARTS ROW ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-card border border-border rounded-2xl p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-bold text-foreground flex items-center gap-1.5"><Activity className="w-4 h-4 text-primary" /> New ads over time</p>
            <p className="text-xs text-muted-foreground">Ø {avgPerDay.toFixed(2)} / day</p>
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={weekly} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="newAds" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22c55e" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={16} />
                <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Area type="monotone" dataKey="count" stroke="#16a34a" strokeWidth={2} fill="url(#newAds)" name="New ads" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-card border border-border rounded-2xl p-4">
          <p className="text-sm font-bold text-foreground flex items-center gap-1.5 mb-2"><BarChart2 className="w-4 h-4 text-primary" /> Ads by competitor</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={brandSpend} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={90} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="ads" fill="#22c55e" radius={[0, 4, 4, 0]} name="ads" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* ── TOP LANDING PAGES ── */}
      {topLandings.length > 0 && (
        <div className="bg-card border border-border rounded-2xl p-4">
          <p className="text-sm font-bold text-foreground flex items-center gap-1.5 mb-3"><LayoutTemplate className="w-4 h-4 text-primary" /> Top landing pages</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {topLandings.map(l => (
              <div key={l.host} className="flex items-center gap-3 border border-border rounded-xl p-2">
                <div className="w-14 h-14 rounded-lg overflow-hidden bg-slate-100 shrink-0">
                  {l.screenshot
                    ? <img src={l.screenshot} alt={l.host} className="w-full h-full object-cover object-top" />
                    : <div className="w-full h-full flex items-center justify-center"><Globe className="w-5 h-5 text-slate-400" /></div>}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground truncate flex items-center gap-1">
                    <img src={`https://www.google.com/s2/favicons?domain=${l.host}&sz=32`} alt="" className="w-3.5 h-3.5 rounded-sm"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                    {l.host}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{l.count} page{l.count === 1 ? "" : "s"} saved</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── TOP ADS BOARD ── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Flame className="w-4 h-4 text-orange-500" />
          <h4 className="text-base font-bold text-foreground">Top Ads</h4>
          <span className="text-[11px] text-muted-foreground">ranked by estimated spend</span>
        </div>
        {topAds.length === 0 ? (
          <div className="py-12 text-center border-2 border-dashed border-border rounded-2xl text-sm text-muted-foreground">
            No ads scraped yet.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {topAds.map(({ ad, spend }, i) => {
              const reach = typeof ad.reach === "number" && ad.reach > 0 ? ad.reach : null;
              return (
                <div key={ad.id}
                  onClick={() => setDetailAd(ad)}
                  role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDetailAd(ad); } }}
                  className="group relative flex flex-col bg-card border border-border rounded-2xl overflow-hidden hover:border-primary/40 hover:shadow-lg transition-all cursor-pointer">
                  {/* rank + est metrics header */}
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60">
                    <span className="flex items-center justify-center w-5 h-5 rounded-full bg-foreground text-background text-[10px] font-black shrink-0">{i + 1}</span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600">
                      <DollarSign className="w-3 h-3" />{money(spend)} <span className="text-[8px] font-semibold text-muted-foreground/70">est.</span>
                    </span>
                    {reach != null && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-600">
                        <Eye className="w-3 h-3" />{fmtCompact(reach)}
                      </span>
                    )}
                  </div>
                  {/* brand line */}
                  <div className="flex items-center gap-1.5 px-3 pt-2 text-[11px] text-muted-foreground">
                    <Globe className="w-3 h-3 shrink-0" />
                    <span className="font-semibold text-foreground truncate">{ad.brand_name}</span>
                    {isActiveAd(ad) && <span className="ml-auto text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-green-500 text-white shrink-0">ACTIVE</span>}
                  </div>
                  {/* copy — fixed height so every card lines up */}
                  <p className="px-3 pt-1 pb-2 text-xs text-foreground/90 line-clamp-2 min-h-[2.5rem]">
                    {ad.hook || ad.headline || ad.body_text || ""}
                  </p>
                  {/* creative — fixed aspect, uniform */}
                  <div className="relative aspect-[4/5] overflow-hidden bg-slate-100 mt-auto">
                    {ad.file_path ? (
                      ad.media_type === "video" ? (
                        <>
                          <video src={videoThumbSrc(ad.file_path)} muted playsInline preload="metadata" className="w-full h-full object-cover" />
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="w-10 h-10 rounded-full bg-slate-900/45 flex items-center justify-center"><Play className="w-4 h-4 text-white" /></div>
                          </div>
                        </>
                      ) : (
                        <img src={getUploadUrl(ad.file_path)} alt={ad.name} className="w-full h-full object-cover" />
                      )
                    ) : (
                      <AdPlaceholder ad={ad} index={i} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {detailAd && (
        <CreativeDetailPanel
          ad={detailAd}
          placeholderIndex={topAds.findIndex(t => t.ad.id === detailAd.id)}
          brandName={detailAd.brand_name}
          projectId={projectId}
          onClose={() => setDetailAd(null)}
          onSaveTemplate={() => { saveTpl(detailAd); }}
          onDelete={() => { delAd(detailAd); setDetailAd(null); }}
          onTranscribed={(adId, t) => setCreatives(p => p.map(a => a.id === adId ? { ...a, body_text: t } : a))}
          onWinnerChange={(adId, w) => setCreatives(p => p.map(a => a.id === adId ? { ...a, is_winner: w } : a))}
        />
      )}
    </div>
  );
}

// ── IMAGE LANDINGS — media ripped from saved competitor landings ──
type LandingMedia = {
  id: number | string;
  kind: "image" | "gif" | "video";
  section?: LandingSection;
  sourceUrl: string;
  storedUrl: string;
  name: string;
};

function ImageLandingsView({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [items, setItems] = useState<LandingMedia[]>([]);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [emptyReason, setEmptyReason] = useState("");

  const load = async (force = false) => {
    setLoading(true);
    setEmptyReason("");
    try {
      if (force) {
        setExtracting(true);
        const filled = await fillLandingLibrary(projectId);
        setItems(filled.items as LandingMedia[]);
        if (!filled.items.length) setEmptyReason(landingFillError(filled) || "");
        return;
      }
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/landing-media`);
      const listed = r.ok ? await r.json() : [];
      if (Array.isArray(listed) && listed.length) {
        setItems(listed);
        return;
      }
      setExtracting(true);
      const filled = await fillLandingLibrary(projectId);
      setItems(filled.items as LandingMedia[]);
      if (!filled.items.length) setEmptyReason(landingFillError(filled) || "");
    } catch (e) {
      setEmptyReason((e as Error).message || "Download failed");
    } finally {
      setExtracting(false);
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [projectId]);

  const extract = async () => {
    setExtracting(true);
    try {
      const filled = await fillLandingLibrary(projectId, { force: true });
      setItems(filled.items as LandingMedia[]);
      if (filled.items.length) {
        toast({
          title: filled.saved
            ? `Downloaded ${filled.saved} file${filled.saved === 1 ? "" : "s"} from competitor landings`
            : "Landing photos are already in the library",
        });
      } else {
        const reason = landingFillError(filled) || "No photos downloaded";
        setEmptyReason(reason);
        toast({ title: reason, variant: "destructive" });
      }
    } catch (e) {
      toast({ title: (e as Error).message || "Extract failed", variant: "destructive" });
    } finally {
      setExtracting(false);
    }
  };

  const del = async (m: LandingMedia) => {
    setItems((p) => p.filter((x) => x.id !== m.id));
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/landing-media/${m.id}`, { method: "DELETE" });
  };

  const images = items.filter((m) => m.kind === "image" || m.kind === "gif");
  const videos = items.filter((m) => m.kind === "video");
  const byHost = (rows: LandingMedia[]) => {
    const map = new Map<string, LandingMedia[]>();
    for (const m of rows) {
      const host = hostOfUrl(m.sourceUrl) || "other";
      if (!map.has(host)) map.set(host, []);
      map.get(host)!.push(m);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-bold text-foreground">Image landings</h3>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Photos from each saved offer landing, grouped by site.
            Affiliate swipe keeps each page&apos;s own photos — other products are not mixed in.
          </p>
        </div>
        {items.length > 0 && (
          <Button onClick={extract} disabled={extracting} variant="outline" className="gap-2">
            {extracting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {extracting ? "Updating…" : "Re-scan"}
          </Button>
        )}
      </div>

      {(loading || extracting) && items.length === 0 ? (
        <p className="text-sm text-muted-foreground py-12 text-center">
          {extracting ? "Downloading photos from saved landings…" : "Loading photos from saved landings…"}
        </p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16 text-center">
          <ImageIcon className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-semibold text-foreground mb-1">No landing media yet</p>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            {emptyReason || "Save competitor landings to this project — photos, GIFs and videos are stored here by themselves."}
          </p>
          <Button onClick={extract} disabled={extracting} variant="outline" className="mt-4 gap-2">
            {extracting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {extracting ? "Downloading…" : "Retry download"}
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {images.length > 0 && (
            <div className="space-y-5">
              {byHost(images).map(([host, rows]) => (
                <div key={host}>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                    {host} · {rows.length} photo{rows.length === 1 ? "" : "s"}
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                    {rows.map((m) => (
                      <div key={m.id} className="group relative rounded-xl border border-border overflow-hidden bg-muted/30">
                        <img src={m.storedUrl} alt={m.name} className="w-full h-36 object-cover" />
                        <span className="absolute top-2 left-2 text-[10px] font-bold uppercase bg-black/70 text-white px-1.5 py-0.5 rounded">
                          {m.kind === "gif" ? "GIF · " : ""}
                          {LANDING_SECTION_LABEL[m.section || "other"]}
                        </span>
                        <button
                          type="button"
                          onClick={() => del(m)}
                          className="absolute top-2 right-2 p-1 rounded-md bg-white/90 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-red-600"
                          title="Remove"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {videos.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Videos ({videos.length})
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                {videos.map((m) => (
                  <div key={m.id} className="group relative rounded-xl border border-border overflow-hidden bg-black">
                    <video src={m.storedUrl} controls className="w-full h-44 object-contain bg-black" />
                    <span className="absolute top-2 left-2 text-[10px] font-bold uppercase bg-black/70 text-white px-1.5 py-0.5 rounded">
                      {LANDING_SECTION_LABEL[m.section || "video"]}
                    </span>
                    <button
                      type="button"
                      onClick={() => del(m)}
                      className="absolute top-2 right-2 p-1 rounded-md bg-white/90 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-red-600"
                      title="Remove"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── MAIN EXPORT ──
type Tab = "overview" | "ads" | "landings" | "landingImages" | "shots";

const LIBRARY_TABS = [
  { id: "overview" as Tab, label: "Overview", icon: Gauge },
  { id: "ads" as Tab, label: "Ads Library", icon: BarChart2 },
  { id: "landings" as Tab, label: "Landings", icon: LayoutTemplate },
  { id: "landingImages" as Tab, label: "Image landings", icon: ImageIcon },
  { id: "shots" as Tab, label: "Shots", icon: Film },
] as const;

export function CompetitorLibrarySection({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [selected, setSelected] = useState<CompetitorWithStats | null>(null);
  const [adsView, setAdsView] = useState<"by" | "all">("by");
  useEffect(() => { void fillLandingLibrary(projectId); }, [projectId]);

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

      {tab === "overview" && (
        <SectorOverview projectId={projectId} onOpenBrand={(b) => { setTab("ads"); setSelected(b); }} />
      )}

      {tab === "landings" && <CompetitorLandingsView projectId={projectId} />}

      {tab === "landingImages" && <ImageLandingsView projectId={projectId} />}

      {tab === "shots" && <ShotsLibraryView projectId={projectId} />}

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
    </div>
  );
}
