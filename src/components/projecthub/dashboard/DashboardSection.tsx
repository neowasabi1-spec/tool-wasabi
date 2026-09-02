"use client";

/**
 * Project-level Dashboard — first item in the project sidebar.
 * One screen that answers: how many competitors / ads / funnels, which
 * are the best, and how the library has grown over the last 30 days.
 */

import { useEffect, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  LayoutDashboard, Globe2, Flame, Layers, Film, Image as ImageIcon,
  Play, Folder, Palette, Scissors, ArrowRight, Sparkles,
} from "lucide-react";
import { getUploadUrl } from "@/lib/projecthub-storage";

type DashSection = "competitor-library" | "funnel" | "creative";

type DashData = {
  competitors: {
    total: number;
    top: { id: number; name: string; ads: number; winners: number; video: number; image: number }[];
  };
  ads: {
    total: number; video: number; image: number; winners: number;
    timeline: { date: string; ads: number }[];
    top: {
      id: number; brand_id: number; brand: string; name: string;
      media_type: string; file_path: string; is_winner: boolean; variants: number; days: number;
    }[];
  };
  funnels: {
    rows: number; funnels: number; landings: number; pages: number;
    recent: { id: string | number; name: string; steps: number; created_at: string }[];
  };
  creatives: { total: number; video: number; image: number };
  shots: { total: number; cleaned: number };
};

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { day: "2-digit", month: "short" });
}

function videoThumb(path: string) {
  const u = getUploadUrl(path);
  return u.includes("#") ? u : `${u}#t=0.1`;
}

export function DashboardSection({
  projectId,
  projectName,
  onNavigate,
}: {
  projectId: string;
  projectName: string;
  onNavigate?: (section: DashSection) => void;
}) {
  const [data, setData] = useState<DashData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/projecthub/projects/${projectId}/dashboard`);
        if (r.ok && alive) setData(await r.json());
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [projectId]);

  if (loading) {
    return <div className="py-20 text-center text-sm text-muted-foreground">Loading dashboard…</div>;
  }

  if (!data) {
    return (
      <div className="py-20 text-center border-2 border-dashed border-border rounded-2xl">
        <LayoutDashboard className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
        <p className="text-sm font-semibold text-foreground">Could not load the dashboard</p>
        <p className="text-xs text-muted-foreground mt-1">Refresh the page and try again.</p>
      </div>
    );
  }

  const empty = data.competitors.total === 0 && data.ads.total === 0 && data.funnels.rows === 0 && data.creatives.total === 0;
  const mix = [
    { name: "Video", value: data.ads.video, color: "#a855f7" },
    { name: "Image", value: data.ads.image, color: "#3b82f6" },
  ];
  const adsLast30 = data.ads.timeline.reduce((s, d) => s + d.ads, 0);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1 flex items-center gap-2">
          <LayoutDashboard className="w-5 h-5 text-primary" /> Dashboard
        </h2>
        <p className="text-sm text-muted-foreground">
          Overview of {projectName || "this project"} — competitors, ads, funnels and creatives.
        </p>
      </div>

      {empty ? (
        <div className="py-16 text-center border-2 border-dashed border-border rounded-2xl">
          <Sparkles className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-semibold text-foreground mb-1">Nothing to show yet</p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            Add competitors, scrape ads or save a funnel — this dashboard fills in automatically.
          </p>
        </div>
      ) : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <Kpi
              label="Competitors" value={data.competitors.total} icon={Globe2}
              onClick={() => onNavigate?.("competitor-library")}
            />
            <Kpi
              label="Ads" value={data.ads.total}
              hint={`${data.ads.video} video · ${data.ads.image} image`}
              icon={Film}
              onClick={() => onNavigate?.("competitor-library")}
            />
            <Kpi
              label="Winners" value={data.ads.winners} icon={Flame} accent
              onClick={() => onNavigate?.("competitor-library")}
            />
            <Kpi
              label="Funnels" value={data.funnels.funnels}
              hint={`${data.funnels.pages} pages`}
              icon={Layers}
              onClick={() => onNavigate?.("funnel")}
            />
            <Kpi
              label="Landings" value={data.funnels.landings} icon={Folder}
              onClick={() => onNavigate?.("competitor-library")}
            />
            <Kpi
              label="My creatives" value={data.creatives.total}
              hint={data.shots.total ? `${data.shots.total} shots` : undefined}
              icon={Palette}
              onClick={() => onNavigate?.("creative")}
            />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-card border border-border rounded-2xl p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-bold text-foreground">Ads collected — last 30 days</p>
                <p className="text-xs text-muted-foreground">{adsLast30} new</p>
              </div>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.ads.timeline} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    <defs>
                      <linearGradient id="dashAds" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#7c3aed" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#7c3aed" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={20} />
                    <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Area type="monotone" dataKey="ads" stroke="#7c3aed" strokeWidth={2} fill="url(#dashAds)" name="Ads" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-card border border-border rounded-2xl p-4">
              <p className="text-sm font-bold text-foreground mb-2">Ad mix</p>
              <div className="h-52 relative">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={mix} dataKey="value" innerRadius={48} outerRadius={72} paddingAngle={3} stroke="none">
                      {mix.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-2xl font-black text-foreground leading-none">{data.ads.total}</span>
                  <span className="text-[10px] text-muted-foreground">ads</span>
                </div>
              </div>
              <div className="flex justify-center gap-4 text-xs -mt-2">
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-purple-500" /> {data.ads.video} video</span>
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /> {data.ads.image} image</span>
              </div>
            </div>
          </div>

          {/* Best competitors + best ads */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-card border border-border rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-bold text-foreground flex items-center gap-1.5">
                  <Globe2 className="w-4 h-4 text-primary" /> Top competitors
                </p>
                <button onClick={() => onNavigate?.("competitor-library")}
                  className="text-[11px] text-primary hover:underline flex items-center gap-0.5">
                  Open library <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              {data.competitors.top.length === 0 ? (
                <p className="text-xs text-muted-foreground italic py-6 text-center">No competitors yet.</p>
              ) : (
                <>
                  <div className="h-44 mb-3">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.competitors.top} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                        <XAxis type="number" hide />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={100} />
                        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                        <Bar dataKey="ads" fill="#7c3aed" radius={[0, 4, 4, 0]} name="Ads" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="space-y-1.5">
                    {data.competitors.top.slice(0, 5).map((b, i) => (
                      <div key={b.id} className="flex items-center gap-2 text-xs">
                        <span className="w-4 text-muted-foreground font-semibold">{i + 1}</span>
                        <span className="flex-1 truncate font-medium text-foreground">{b.name}</span>
                        <span className="text-muted-foreground">{b.ads} ads</span>
                        {b.winners > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-full">
                            <Flame className="w-2.5 h-2.5" /> {b.winners}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="bg-card border border-border rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-bold text-foreground flex items-center gap-1.5">
                  <Flame className="w-4 h-4 text-amber-500" /> Best ads
                </p>
                <button onClick={() => onNavigate?.("competitor-library")}
                  className="text-[11px] text-primary hover:underline flex items-center gap-0.5">
                  All ads <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              {data.ads.top.length === 0 ? (
                <p className="text-xs text-muted-foreground italic py-6 text-center">No ads scraped yet.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {data.ads.top.map(ad => (
                    <button key={ad.id} onClick={() => onNavigate?.("competitor-library")}
                      className="group text-left rounded-xl border border-border overflow-hidden hover:border-primary/40 hover:shadow-sm transition-all bg-muted/20">
                      <div className="aspect-[4/5] bg-muted relative overflow-hidden">
                        {ad.file_path && ad.media_type === "image" ? (
                          <img src={getUploadUrl(ad.file_path)} alt="" className="w-full h-full object-cover" />
                        ) : ad.file_path && ad.media_type === "video" ? (
                          <>
                            <video src={videoThumb(ad.file_path)} muted playsInline preload="metadata"
                              className="w-full h-full object-cover" />
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                              <Play className="w-5 h-5 text-white fill-white drop-shadow" />
                            </div>
                          </>
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            {ad.media_type === "video" ? <Film className="w-6 h-6 text-muted-foreground/40" /> : <ImageIcon className="w-6 h-6 text-muted-foreground/40" />}
                          </div>
                        )}
                        {ad.is_winner && (
                          <span className="absolute top-1.5 left-1.5 text-[9px] font-black px-1.5 py-0.5 rounded-full bg-amber-400 text-amber-950">
                            WINNER
                          </span>
                        )}
                      </div>
                      <div className="p-1.5">
                        <p className="text-[10px] font-semibold text-foreground truncate">{ad.name}</p>
                        <p className="text-[9px] text-muted-foreground truncate">
                          {ad.brand}{ad.days ? ` · ${ad.days}d` : ""}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Funnels + library leftovers */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-card border border-border rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-bold text-foreground flex items-center gap-1.5">
                  <Layers className="w-4 h-4 text-primary" /> Recent funnels & pages
                </p>
                <button onClick={() => onNavigate?.("funnel")}
                  className="text-[11px] text-primary hover:underline flex items-center gap-0.5">
                  Open funnel <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              {data.funnels.recent.length === 0 ? (
                <p className="text-xs text-muted-foreground italic py-6 text-center">No funnels or landings saved yet.</p>
              ) : (
                <div className="divide-y divide-border">
                  {data.funnels.recent.map(f => (
                    <div key={String(f.id)} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <Layers className="w-4 h-4 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-foreground truncate">{f.name || "Untitled"}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {f.steps} step{f.steps === 1 ? "" : "s"} · {fmtDate(f.created_at)}
                        </p>
                      </div>
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${f.steps > 1 ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-600"}`}>
                        {f.steps > 1 ? "FUNNEL" : "PAGE"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-card border border-border rounded-2xl p-4">
              <p className="text-sm font-bold text-foreground mb-3">Library snapshot</p>
              <div className="grid grid-cols-2 gap-3">
                <Snap icon={Palette} label="Saved creatives" value={data.creatives.total}
                  hint={`${data.creatives.image} img · ${data.creatives.video} video`}
                  onClick={() => onNavigate?.("creative")} />
                <Snap icon={Scissors} label="Shots" value={data.shots.total}
                  hint={data.shots.cleaned ? `${data.shots.cleaned} cleaned` : "from videos"}
                  onClick={() => onNavigate?.("competitor-library")} />
                <Snap icon={Folder} label="Landing pages" value={data.funnels.landings}
                  onClick={() => onNavigate?.("competitor-library")} />
                <Snap icon={Layers} label="Multi-step funnels" value={data.funnels.funnels}
                  onClick={() => onNavigate?.("funnel")} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({
  label, value, hint, icon: Icon, accent, onClick,
}: {
  label: string; value: number; hint?: string; icon: typeof Globe2; accent?: boolean; onClick?: () => void;
}) {
  return (
    <button onClick={onClick}
      className={`text-left rounded-2xl border p-3.5 transition-all ${
        accent ? "border-amber-200 bg-amber-50/60 hover:border-amber-300" : "border-border bg-card hover:border-primary/40"
      }`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        <Icon className={`w-3 h-3 ${accent ? "text-amber-600" : "text-primary"}`} /> {label}
      </p>
      <p className={`text-2xl font-black mt-1 leading-none ${accent ? "text-amber-700" : "text-foreground"}`}>{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground mt-1 truncate">{hint}</p>}
    </button>
  );
}

function Snap({
  icon: Icon, label, value, hint, onClick,
}: {
  icon: typeof Palette; label: string; value: number; hint?: string; onClick?: () => void;
}) {
  return (
    <button onClick={onClick}
      className="text-left rounded-xl border border-border bg-muted/30 hover:bg-muted/60 p-3 transition-colors">
      <Icon className="w-4 h-4 text-primary mb-1.5" />
      <p className="text-lg font-black text-foreground leading-none">{value}</p>
      <p className="text-[11px] font-medium text-foreground mt-1">{label}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </button>
  );
}
