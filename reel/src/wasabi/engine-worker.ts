/**
 * Background worker for the Claude Cloud reel host.
 *
 * Processes queued jobs:
 *  1. import footage from Supabase into <buyer>/<projectId>/footage
 *  2. for "produce": write Claude task + optionally invoke `claude` CLI
 *  3. when final.mp4 appears, publish to Wasabi
 *
 * Run on the engine server: `pnpm engine:worker`
 */

import dotenv from "dotenv";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudeTaskPrompt,
  listJobs,
  loadJob,
  saveJob,
  type ReelJob,
} from "./engine-jobs.js";
import { importReelFootage, publishReelToWasabi } from "./index.js";
import { setReelMediaBuyer, resolveReelProjectDir } from "./paths.js";

const REEL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: join(REEL_ROOT, ".env"), override: false });

const POLL_MS = Number(process.env.REEL_WORKER_POLL_MS || 5000);
const CLAUDE_BIN = (process.env.REEL_CLAUDE_BIN || "claude").trim();
const AUTO_CLAUDE = process.env.REEL_AUTO_CLAUDE !== "0";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runClaude(job: ReelJob): Promise<void> {
  const prompt = claudeTaskPrompt(job);
  const taskDir = join(
    resolveReelProjectDir(job.projectId, job.mediaBuyer),
    "_engine",
  );
  mkdirSync(taskDir, { recursive: true });
  const promptPath = join(taskDir, `${job.id}.prompt.md`);
  writeFileSync(promptPath, prompt);

  if (!AUTO_CLAUDE) {
    job.status = "waiting_claude";
    job.progress = `Prompt ready at ${promptPath} — run in Claude Cloud (or set REEL_AUTO_CLAUDE=1)`;
    saveJob(job);
    return;
  }

  job.status = "waiting_claude";
  job.progress = `Invoking ${CLAUDE_BIN}…`;
  saveJob(job);

  await new Promise<void>((resolve) => {
    const child = spawn(
      CLAUDE_BIN,
      ["-p", prompt, "--output-format", "text", "--dangerously-skip-permissions"],
      {
        cwd: REEL_ROOT,
        env: { ...process.env, REEL_MEDIA_BUYER: job.mediaBuyer },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, Number(process.env.REEL_CLAUDE_TIMEOUT_MS || 45 * 60 * 1000));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        job.error = `claude exited ${code}: ${stderr.slice(0, 800)}`;
        job.status = "error";
        job.finishedAt = new Date().toISOString();
        saveJob(job);
      }
      resolve();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      job.error = `claude spawn failed: ${err.message}. Install Claude Code on the host or set REEL_AUTO_CLAUDE=0.`;
      job.status = "error";
      job.finishedAt = new Date().toISOString();
      saveJob(job);
      resolve();
    });
  });
}

async function processJob(job: ReelJob): Promise<void> {
  setReelMediaBuyer(job.mediaBuyer);
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.progress = "importing footage";
  job.error = undefined;
  saveJob(job);

  try {
    if (job.kind === "import" || job.kind === "produce") {
      const imported = await importReelFootage({
        projectId: job.projectId,
        brandId: job.brandId,
        includeFullAds: job.includeFullAds !== false,
      });
      job.result = {
        ...(job.result || {}),
        importedShots: imported.shots.length,
        importedFullAds: imported.fullAds.length,
        projectDir: resolveReelProjectDir(job.projectId, job.mediaBuyer),
      };
      job.progress = "footage imported";
      saveJob(job);
    }

    if (job.kind === "import") {
      job.status = "done";
      job.finishedAt = new Date().toISOString();
      job.progress = "done";
      saveJob(job);
      return;
    }

    if (job.kind === "produce") {
      await runClaude(job);
      const latest = loadJob(job.id);
      if (!latest || latest.status === "error") return;

      const reelDir = latest.reelDir!;
      const finalMp4 = join(reelDir, "final.mp4");
      const deadline =
        Date.now() + Number(process.env.REEL_FINAL_WAIT_MS || 50 * 60 * 1000);
      while (Date.now() < deadline) {
        if (existsSync(finalMp4)) break;
        const j = loadJob(job.id);
        if (j?.status === "error") return;
        if (j) {
          j.progress = `waiting for final.mp4 in ${reelDir}`;
          j.status = "waiting_claude";
          saveJob(j);
        }
        await sleep(10_000);
      }

      if (!existsSync(finalMp4)) {
        const j = loadJob(job.id)!;
        j.status = "error";
        j.error = `Timeout: final.mp4 not found in ${reelDir}`;
        j.finishedAt = new Date().toISOString();
        saveJob(j);
        return;
      }

      const j = loadJob(job.id)!;
      j.status = "publishing";
      j.progress = "publishing to Wasabi";
      saveJob(j);
      const pub = await publishReelToWasabi({
        projectId: j.projectId,
        reelDir,
        brandId: j.brandId,
        name: j.name || j.slug,
      });
      j.status = "done";
      j.progress = "done";
      j.finishedAt = new Date().toISOString();
      j.result = { ...(j.result || {}), publish: pub, finalMp4 };
      saveJob(j);
      return;
    }

    if (job.kind === "publish") {
      if (!job.reelDir) throw new Error("reelDir required for publish");
      job.status = "publishing";
      saveJob(job);
      const pub = await publishReelToWasabi({
        projectId: job.projectId,
        reelDir: job.reelDir,
        brandId: job.brandId,
        name: job.name || job.slug,
      });
      job.status = "done";
      job.finishedAt = new Date().toISOString();
      job.result = { publish: pub };
      saveJob(job);
    }
  } catch (e) {
    job.status = "error";
    job.error = e instanceof Error ? e.message : String(e);
    job.finishedAt = new Date().toISOString();
    saveJob(job);
  }
}

async function tick(): Promise<void> {
  const queued = listJobs({ limit: 100 }).filter((j) => j.status === "queued");
  const next = queued.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!next) return;
  console.log(
    `[engine-worker] start ${next.id} ${next.kind} buyer=${next.mediaBuyer} project=${next.projectId}`,
  );
  await processJob(next);
  console.log(`[engine-worker] end ${next.id} status=${loadJob(next.id)?.status}`);
}

async function main() {
  console.log(
    `[engine-worker] polling every ${POLL_MS}ms — REEL_AUTO_CLAUDE=${AUTO_CLAUDE ? "1" : "0"}`,
  );
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error("[engine-worker]", e instanceof Error ? e.message : e);
    }
    await sleep(POLL_MS);
  }
}

main();
