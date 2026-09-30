/**
 * Genera `selection.html` — galleria visiva UNICA per il gate R2 (tabella scene)
 * del refresh creativo. Una card per shot: frame + verdetto color-coded + tempo +
 * flag (talking-head/testo/logo/before-after) + confidenza + voiceover.
 *
 * È l'analogo di keyframes.html per il GATE 4: l'umano apre QUESTA pagina, vede
 * tutto insieme (non selection.md + frame sciolti), e decide i verdetti.
 *
 * I frame sono referenziati per path relativo a `frames/` (la pagina vive nella
 * project dir, accanto a frames/), come fa keyframe-gallery con i keyframe.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Deconstruction, ReproductionVerdict } from "../schemas/refresh.js";

const VERDICT_COLOR: Record<ReproductionVerdict, string> = {
  "ai-recreate": "#6ee7b7", // verde
  "static-png": "#c4b5fd", // viola
  card: "#fbbf24", // arancio
  splice: "#9ca3af", // grigio
};

export async function buildSelectionGallery(
  projectDir: string,
  d: Deconstruction
): Promise<string> {
  const counts: Record<string, number> = { "ai-recreate": 0, "static-png": 0, card: 0, splice: 0 };
  for (const s of d.shots) counts[s.verdict]++;

  const cards = d.shots
    .map((s) => {
      const color = VERDICT_COLOR[s.verdict];
      const lowConf = s.confidence < 0.6;
      const flags: string[] = [];
      if (s.isTalkingHead) flags.push("🗣️ parla");
      if (s.hasReadableText) flags.push("🔤 testo");
      if (s.hasLogoOrUI) flags.push("™ logo/UI");
      if (s.isProductWithText) flags.push("📦 prodotto+scritte");
      if (s.isBeforeAfter) flags.push("⏪ before/after");
      const flagsHtml = flags.length
        ? `<div class="flags">${flags.map((f) => `<span class="chip">${escapeHtml(f)}</span>`).join("")}</div>`
        : "";
      return `  <div class="card${lowConf ? " lowconf" : ""}" style="--vc:${color}">
    <div class="thumb"><img src="${escapeAttr(s.framePath)}" alt="shot ${s.index}" loading="lazy"><span class="vbadge">${s.verdict}</span></div>
    <div class="head"><span class="num">#${s.index}</span><span class="time">${s.startSec.toFixed(1)}–${s.endSec.toFixed(1)}s · ${s.durationSec.toFixed(1)}s</span><span class="conf${lowConf ? " warn" : ""}">${lowConf ? "⚠️ " : ""}${s.confidence.toFixed(2)}</span></div>
    <div class="subj">${escapeHtml(s.subject || "—")}${s.setting ? ` · <span class="muted">${escapeHtml(s.setting)}</span>` : ""}</div>
    ${s.onScreenText ? `<div class="ost">a schermo: «${escapeHtml(s.onScreenText)}»</div>` : ""}
    ${flagsHtml}
    ${s.vo ? `<div class="vo">"${escapeHtml(truncate(s.vo, 120))}"</div>` : ""}
  </div>`;
    })
    .join("\n");

  const legend = (["ai-recreate", "static-png", "card", "splice"] as ReproductionVerdict[])
    .map((v) => `<span class="leg"><span class="dot" style="background:${VERDICT_COLOR[v]}"></span>${v} <b>${counts[v]}</b></span>`)
    .join("");

  const name = projectDir.split("/").pop() ?? "refresh";
  const html = `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8">
<title>Tabella scene — ${escapeHtml(name)}</title>
<style>
  :root{--bg:#0f0f0f;--card:#1a1a1a;--border:#2a2a2a;--text:#e6e6e6;--muted:#8a8a8a;}
  *{box-sizing:border-box}
  body{margin:0;padding:1.5rem;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  h1{margin:0 0 .25rem;font-size:1.3rem}
  .sub{color:var(--muted);font-size:.85rem;margin:0 0 1rem}
  .legend{display:flex;gap:1rem;flex-wrap:wrap;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:.6rem .9rem;margin-bottom:1rem;font-size:.85rem}
  .leg{display:inline-flex;align-items:center;gap:.4rem}
  .dot{width:11px;height:11px;border-radius:3px;display:inline-block}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:.8rem}
  .card{background:var(--card);border:1px solid var(--border);border-left:4px solid var(--vc);border-radius:8px;padding:.6rem;display:flex;flex-direction:column;gap:.35rem}
  .card.lowconf{outline:1px dashed #f87171}
  .thumb{position:relative}
  .thumb img{width:100%;aspect-ratio:9/16;object-fit:cover;border-radius:6px;background:#000;display:block}
  .vbadge{position:absolute;left:6px;bottom:6px;background:var(--vc);color:#111;font-weight:700;font-size:.72rem;padding:.1rem .4rem;border-radius:4px;text-transform:uppercase;letter-spacing:.02em}
  .head{display:flex;justify-content:space-between;align-items:baseline;gap:.4rem;font-size:.78rem}
  .num{font-weight:700;color:#60a5fa}
  .time{color:var(--muted);flex:1}
  .conf{color:var(--muted)} .conf.warn{color:#f87171;font-weight:600}
  .subj{font-size:.82rem;line-height:1.3} .muted{color:var(--muted)}
  .ost{font-size:.74rem;color:#fbbf24}
  .flags{display:flex;flex-wrap:wrap;gap:.25rem}
  .chip{font-size:.68rem;background:#262626;border:1px solid var(--border);border-radius:10px;padding:.05rem .45rem;color:#cfcfcf}
  .vo{font-style:italic;color:var(--muted);font-size:.76rem;border-top:1px solid var(--border);padding-top:.3rem}
</style></head><body>
<h1>Tabella scene — refresh creativo</h1>
<p class="sub">${escapeHtml(d.meta.source.split("/").pop() ?? "")} · ${d.meta.durationSec.toFixed(1)}s · ${d.meta.width}x${d.meta.height} · ${d.shots.length} shot · soglia ${d.meta.shotThreshold}<br>
Verdetti <b>proposti</b>: approva o ribalta. Bordo tratteggiato rosso = confidenza &lt; 0.60 (rivedi a mano).</p>
<div class="legend">${legend}</div>
<div class="grid">
${cards}
</div>
</body></html>`;

  const htmlPath = join(projectDir, "selection.html");
  await writeFile(htmlPath, html, "utf8");
  return htmlPath;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}
