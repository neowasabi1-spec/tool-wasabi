/**
 * Disk-backed job queue for the Claude Cloud reel engine host.
 * Layout: <REEL_OUTPUT_BASE>/_jobs/<jobId>.json
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  resolveDatedReelDir,
  resolveJobsDir,
  resolveReelProjectDir,
  sanitizeBuyerSlug,
  setReelMediaBuyer,
} from "./paths.js";

export type ReelJobKind = "import" | "produce" | "publish";

export type ReelJobStatus =
  | "queued"
  | "running"
  | "waiting_claude"
  | "publishing"
  | "done"
  | "error";

export type ReelJob = {
  id: string;
  kind: ReelJobKind;
  status: ReelJobStatus;
  mediaBuyer: string;
  projectId: string;
  brandId?: number;
  /** Human brief / angle for Claude director */
  brief?: string;
  /** Optional slug for dated reel folder */
  slug?: string;
  includeFullAds?: boolean;
  reelDir?: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  progress?: string;
  result?: Record<string, unknown>;
};

function jobPath(id: string): string {
  return join(resolveJobsDir(), `${id}.json`);
}

export function saveJob(job: ReelJob): ReelJob {
  job.updatedAt = new Date().toISOString();
  writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
  return job;
}

export function loadJob(id: string): ReelJob | null {
  const p = jobPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as ReelJob;
}

export function listJobs(opts?: {
  projectId?: string;
  mediaBuyer?: string;
  limit?: number;
}): ReelJob[] {
  const dir = resolveJobsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
  const out: ReelJob[] = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as ReelJob;
      if (opts?.projectId && j.projectId !== opts.projectId) continue;
      if (opts?.mediaBuyer && j.mediaBuyer !== sanitizeBuyerSlug(opts.mediaBuyer))
        continue;
      out.push(j);
      if (out.length >= (opts?.limit ?? 50)) break;
    } catch {
      /* skip bad */
    }
  }
  return out;
}

export function createJob(input: {
  kind: ReelJobKind;
  mediaBuyer: string;
  projectId: string;
  brandId?: number;
  brief?: string;
  slug?: string;
  includeFullAds?: boolean;
  reelDir?: string;
  name?: string;
}): ReelJob {
  const mediaBuyer = sanitizeBuyerSlug(input.mediaBuyer);
  setReelMediaBuyer(mediaBuyer);
  const slug =
    input.slug ||
    `reel-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
  const reelDir =
    input.reelDir ||
    (input.kind === "produce"
      ? resolveDatedReelDir(input.projectId, slug, new Date(), mediaBuyer)
      : undefined);

  const job: ReelJob = {
    id: randomUUID(),
    kind: input.kind,
    status: "queued",
    mediaBuyer,
    projectId: input.projectId,
    brandId: input.brandId,
    brief: input.brief,
    slug,
    includeFullAds: input.includeFullAds !== false,
    reelDir,
    name: input.name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: "queued",
  };
  return saveJob(job);
}


/** Prompt dropped next to the job for Claude Cloud / Claude Code. */
export function claudeTaskPrompt(job: ReelJob): string {
  const reelDir = job.reelDir || resolveReelProjectDir(job.projectId, job.mediaBuyer);
  return [
    `You are the Wasabi Reel Engine on the shared Claude Cloud host.`,
    `Media buyer folder: ${job.mediaBuyer}`,
    `Project ID: ${job.projectId}`,
    `Job ID: ${job.id}`,
    `Working reelDir: ${reelDir}`,
    ``,
    `Footage was imported under:`,
    `  ${resolveReelProjectDir(job.projectId, job.mediaBuyer)}/footage/`,
    ``,
    job.brief
      ? `Creative brief from the mediabuyer (Wasabi UI):\n${job.brief}\n`
      : `No brief — invent a strong short-form angle from the imported competitor footage.`,
    ``,
    `Follow the reel-director skill gates (treatment → script.json → voice → storyboard → approve keyframes → video → render).`,
    `Use MCP wasabi-reel tools on THIS machine only (already configured).`,
    `When final.mp4 exists in reelDir, call reel_publish_to_wasabi with projectId=${job.projectId} and that reelDir.`,
    `Then write status done by updating the job file or running: pnpm engine:mark-done ${job.id}`,
  ].join("\n");
}
