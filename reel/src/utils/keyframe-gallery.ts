/**
 * Genera `keyframes.html` — gallery HTML statico per review visiva dei keyframe.
 *
 * Layout: griglia 9:16 responsive (1 colonna mobile, 2-3 desktop). Per ogni scena:
 *   - Thumbnail del keyframe PNG (path relativo a outputDir)
 *   - Numero scena + voiceoverSegment troncato
 *   - Stato approvazione (✅ approved / 🟡 pending) basato sul marker .approved
 *   - Prompt usato + reference URL (clickable)
 *   - Comandi CLI copy-friendly per approve/regen
 *
 * No JavaScript necessario. Self-contained HTML.
 *
 * Lo stato di approvazione viene LETTO dal marker file `.approved` (source of
 * truth = filesystem, non JSON). L'HTML è statico: per aggiornare lo stato
 * va rigenerato via `pnpm storyboard` o uno script dedicato.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isKeyframeApproved } from "./approval-gate.js";
import type { ReelScript } from "../schemas/script.js";

interface GalleryScene {
  num: number;
  keyframePath: string; // relativo a outputDir (es. "assets/keyframes/scene-1.png")
  keyframeFullPath: string; // assoluto, per controllare il marker
  voiceoverSegment: string;
  visualPrompt: string;
  referenceUrl?: string;
  videoEngine: string;
  approved: boolean;
}

export async function buildKeyframesGallery(
  outputDir: string,
  script: ReelScript
): Promise<string> {
  const scenes: GalleryScene[] = [];

  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    if (!scene.keyframe) continue;

    const sceneNum = i + 1;
    const keyframeFullPath = join(outputDir, scene.keyframe);
    const approved = await isKeyframeApproved(keyframeFullPath);

    scenes.push({
      num: sceneNum,
      keyframePath: scene.keyframe,
      keyframeFullPath,
      voiceoverSegment: scene.voiceoverSegment?.trim() ?? scene.text.trim(),
      visualPrompt: scene.visualPrompt,
      referenceUrl: scene.keyframeReferenceUrl,
      videoEngine: scene.videoEngine ?? scene.provider ?? "seedance",
      approved,
    });
  }

  const approvedCount = scenes.filter((s) => s.approved).length;
  const totalCount = scenes.length;

  const html = renderHtml(script.hook, scenes, approvedCount, totalCount, outputDir);
  const htmlPath = join(outputDir, "keyframes.html");
  await writeFile(htmlPath, html, "utf8");
  return htmlPath;
}

function renderHtml(
  reelHook: string,
  scenes: GalleryScene[],
  approvedCount: number,
  totalCount: number,
  outputDir: string
): string {
  const reelName = outputDir.split("/").pop() ?? "reel";
  const allApproved = approvedCount === totalCount && totalCount > 0;

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<title>Keyframes — ${escapeHtml(reelName)}</title>
<style>
  :root {
    --bg: #0f0f0f;
    --card: #1a1a1a;
    --border: #2a2a2a;
    --text: #e0e0e0;
    --muted: #888;
    --approved: #6ee7b7;
    --pending: #fbbf24;
    --accent: #60a5fa;
    --code-bg: #0a0a0a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    line-height: 1.5;
  }
  h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
  .reel-hook { color: var(--muted); margin: 0 0 1.5rem; font-style: italic; }
  .status-banner {
    background: var(--card);
    padding: 1rem 1.25rem;
    border-radius: 8px;
    border: 1px solid var(--border);
    margin-bottom: 1.5rem;
    font-size: 0.95rem;
  }
  .status-banner.all-approved { border-color: var(--approved); color: var(--approved); }
  .status-banner.pending { border-color: var(--pending); }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
  }
  .scene-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
  }
  .scene-card.approved { border-color: var(--approved); }
  .scene-card.pending { border-color: var(--pending); }
  .scene-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 0.5rem;
  }
  .scene-num { font-size: 1rem; font-weight: 600; color: var(--accent); }
  .scene-status { font-size: 0.85rem; font-weight: 600; }
  .scene-status.approved { color: var(--approved); }
  .scene-status.pending { color: var(--pending); }
  .scene-card img {
    width: 100%;
    aspect-ratio: 9/16;
    object-fit: cover;
    border-radius: 6px;
    background: #000;
    display: block;
    margin-bottom: 0.5rem;
  }
  .scene-vo {
    font-style: italic;
    color: var(--muted);
    font-size: 0.85rem;
    margin-bottom: 0.5rem;
    max-height: 3.5em;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .scene-meta {
    font-size: 0.75rem;
    color: var(--muted);
    margin-bottom: 0.4rem;
  }
  details {
    margin-top: 0.5rem;
    font-size: 0.85rem;
  }
  details summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 0.78rem;
    user-select: none;
  }
  details summary:hover { color: var(--text); }
  details pre {
    background: var(--code-bg);
    padding: 0.6rem;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 0.75rem;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0.4rem 0 0;
  }
  .cmd-box {
    background: var(--code-bg);
    padding: 0.6rem;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.72rem;
    margin-top: 0.5rem;
    overflow-x: auto;
    white-space: nowrap;
  }
  a { color: var(--accent); }
  .footer-note {
    margin-top: 2rem;
    color: var(--muted);
    font-size: 0.85rem;
    text-align: center;
  }
</style>
</head>
<body>

<h1>Keyframes — ${escapeHtml(reelName)}</h1>
${reelHook ? `<p class="reel-hook">"${escapeHtml(reelHook)}"</p>` : ""}

<div class="status-banner ${allApproved ? "all-approved" : "pending"}">
  ${
    allApproved
      ? `✅ <strong>${approvedCount}/${totalCount}</strong> keyframe approvati — puoi procedere con <code>pnpm reel ... --video-only</code>`
      : `🟡 <strong>${approvedCount}/${totalCount}</strong> approvati, <strong>${totalCount - approvedCount}</strong> in attesa. Approva ciascuno con <code>touch &lt;keyframe&gt;.approved</code> oppure rigenera con <code>pnpm storyboard ... --force-regen=N</code>.`
  }
</div>

<div class="grid">
${scenes
  .map(
    (s) => `  <div class="scene-card ${s.approved ? "approved" : "pending"}">
    <div class="scene-header">
      <span class="scene-num">Scena ${s.num}</span>
      <span class="scene-status ${s.approved ? "approved" : "pending"}">${s.approved ? "✅ APPROVED" : "🟡 PENDING"}</span>
    </div>
    <img src="${escapeAttr(s.keyframePath)}" alt="Keyframe scena ${s.num}">
    ${s.voiceoverSegment ? `<div class="scene-vo">"${escapeHtml(truncate(s.voiceoverSegment, 140))}"</div>` : ""}
    <div class="scene-meta">Engine: <strong>${escapeHtml(s.videoEngine)}</strong>${s.referenceUrl ? ` · <a href="${escapeAttr(s.referenceUrl)}" target="_blank">reference</a>` : ""}</div>
    <details>
      <summary>Prompt</summary>
      <pre>${escapeHtml(s.visualPrompt)}</pre>
    </details>
    ${
      s.approved
        ? `<div class="cmd-box"># Disapprova: rm ${escapeHtml(s.keyframePath)}.approved</div>`
        : `<div class="cmd-box"># Approva: touch ${escapeHtml(s.keyframePath)}.approved</div>`
    }
    <div class="cmd-box"># Rigenera: pnpm storyboard &lt;script&gt; --from ${escapeHtml(outputDir.split("/").slice(-3).join("/"))} --force-regen=${s.num}</div>
  </div>`
  )
  .join("\n")}
</div>

<p class="footer-note">Generated by reel-engine Stage 1.7 Storyboard · Gemini 3 Pro Image · Rigenera questa pagina con <code>pnpm storyboard</code></p>

</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/&/g, "&amp;");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
