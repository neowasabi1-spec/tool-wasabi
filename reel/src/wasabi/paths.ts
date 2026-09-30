import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Multi-buyer / multi-project layout for Wasabi ProjectHub.
 *
 *   <REEL_OUTPUT_BASE>/<mediaBuyer>/<projectId>/
 *     footage/cleaned
 *     footage/full-cleaned
 *     ai-clips/
 *     YYYY-MM-DD/<slug>/   ← reel outputs (final.mp4, …)
 *
 * mediaBuyer comes from `REEL_MEDIA_BUYER` (set by the engine HTTP server
 * per job) or an explicit argument. Legacy flat `<base>/<projectId>` is
 * kept when no buyer is set (local MCP fallback).
 */

let buyerOverride: string | null = null;

export function sanitizeBuyerSlug(raw: string): string {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!s) throw new Error("Invalid mediaBuyer slug");
  return s;
}

/** Set for the current process / job (engine worker). */
export function setReelMediaBuyer(buyer: string | null): void {
  buyerOverride = buyer ? sanitizeBuyerSlug(buyer) : null;
}

export function reelMediaBuyer(): string | null {
  if (buyerOverride) return buyerOverride;
  const env = process.env.REEL_MEDIA_BUYER?.trim();
  return env ? sanitizeBuyerSlug(env) : null;
}

export function reelOutputBase(): string {
  return (
    process.env.REEL_OUTPUT_BASE?.trim() ||
    join(homedir(), "Movies", "reel-ai")
  );
}

export function resolveBuyerDir(mediaBuyer?: string | null): string {
  const buyer = mediaBuyer ? sanitizeBuyerSlug(mediaBuyer) : reelMediaBuyer();
  if (!buyer) return reelOutputBase();
  return join(reelOutputBase(), buyer);
}

export function resolveReelProjectDir(
  projectId: string,
  mediaBuyer?: string | null,
): string {
  if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new Error(`Invalid projectId: ${projectId}`);
  }
  return join(resolveBuyerDir(mediaBuyer), projectId);
}

export function resolveProjectFootageDir(
  projectId: string,
  mediaBuyer?: string | null,
): string {
  return join(resolveReelProjectDir(projectId, mediaBuyer), "footage", "cleaned");
}

/** Full competitor ads after whole-video subtitle removal (`clean_full_path`). */
export function resolveProjectFullCleanedDir(
  projectId: string,
  mediaBuyer?: string | null,
): string {
  return join(
    resolveReelProjectDir(projectId, mediaBuyer),
    "footage",
    "full-cleaned",
  );
}

export function resolveProjectAiClipsDir(
  projectId: string,
  mediaBuyer?: string | null,
): string {
  return join(resolveReelProjectDir(projectId, mediaBuyer), "ai-clips");
}

export function ensureProjectDirs(
  projectId: string,
  mediaBuyer?: string | null,
): {
  root: string;
  footage: string;
  fullCleaned: string;
  aiClips: string;
  mediaBuyer: string | null;
} {
  if (mediaBuyer) setReelMediaBuyer(mediaBuyer);
  const root = resolveReelProjectDir(projectId);
  const footage = resolveProjectFootageDir(projectId);
  const fullCleaned = resolveProjectFullCleanedDir(projectId);
  const aiClips = resolveProjectAiClipsDir(projectId);
  mkdirSync(footage, { recursive: true });
  mkdirSync(fullCleaned, { recursive: true });
  mkdirSync(aiClips, { recursive: true });
  return { root, footage, fullCleaned, aiClips, mediaBuyer: reelMediaBuyer() };
}

/** Dated reel folder: <buyer>/<project>/<YYYY-MM-DD>/<slug>/ */
export function resolveDatedReelDir(
  projectId: string,
  slug: string,
  date = new Date(),
  mediaBuyer?: string | null,
): string {
  if (mediaBuyer) setReelMediaBuyer(mediaBuyer);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const safe =
    slug.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "reel";
  const dir = join(resolveReelProjectDir(projectId), `${y}-${m}-${d}`, safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Job queue root on the Claude Cloud host. */
export function resolveJobsDir(): string {
  const dir = join(reelOutputBase(), "_jobs");
  mkdirSync(dir, { recursive: true });
  return dir;
}
