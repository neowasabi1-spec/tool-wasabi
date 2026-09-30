#!/usr/bin/env node
import dotenv from "dotenv";
import { spawn } from "node:child_process";
import { access, readdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import {
  importReelFootage,
  generateAiClip,
  publishReelToWasabi,
  reelOutputBase,
  resolveReelProjectDir,
  type ClipModel,
} from "../src/wasabi/index.js";

const REEL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: join(REEL_ROOT, ".env"), override: false });

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function runPnpm(
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn("pnpm", args, {
      cwd: REEL_ROOT,
      env: { ...process.env, ...extraEnv },
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
    child.on("error", (err) => {
      stderr += err.message;
      res({ code: 1, stdout, stderr });
    });
  });
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}

async function buildReelStatus(reelDir: string) {
  const abs = resolve(reelDir);
  const assets = join(abs, "assets");
  const keyframesDir = join(assets, "keyframes");

  const checks: Record<string, boolean | string | number> = {
    reelDir: abs,
    scriptJson: await pathExists(join(abs, "script.json")),
    voiceover: await pathExists(join(assets, "voiceover.mp3")),
    compositionProps: await pathExists(join(abs, "composition-props.json")),
    finalMp4: await pathExists(join(abs, "final.mp4")),
    sceneMap: await pathExists(join(abs, "scene-map.md")),
    keyframesHtml: await pathExists(join(abs, "keyframes.html")),
  };

  let sceneClips = 0;
  let keyframePending = 0;
  let keyframeApproved = 0;
  try {
    const files = await readdir(assets);
    sceneClips = files.filter((f) => /^scene-\d+\.mp4$/i.test(f)).length;
  } catch {
    /* no assets yet */
  }
  try {
    const kf = await readdir(keyframesDir);
    const pngs = kf.filter((f) => /^scene-\d+\.png$/i.test(f));
    for (const png of pngs) {
      const approved = await pathExists(join(keyframesDir, `${png}.approved`));
      if (approved) keyframeApproved++;
      else keyframePending++;
    }
  } catch {
    /* no keyframes dir */
  }

  checks.sceneVideoClips = sceneClips;
  checks.keyframesApproved = keyframeApproved;
  checks.keyframesPending = keyframePending;

  return checks;
}

const mcp = new McpServer({
  name: "wasabi-reel",
  version: "1.0.0",
});

mcp.registerTool(
  "reel_validate_script",
  {
    description: "Validate a script.json against ReelScriptSchema (Zod).",
    inputSchema: {
      scriptPath: z.string().describe("Path to script.json"),
    },
  },
  async ({ scriptPath }) => {
    const { code, stdout, stderr } = await runPnpm([
      "exec",
      "tsx",
      "scripts/validate-script.ts",
      resolve(scriptPath),
    ]);
    const out = [stdout, stderr].filter(Boolean).join("\n").trim();
    return textResult(out || (code === 0 ? "OK" : "Validation failed"), code !== 0);
  },
);

mcp.registerTool(
  "reel_import_cleaned_shots",
  {
    description:
      "Import usable competitor_shots + full cleaned ads (clean_full_path) into REEL_OUTPUT_BASE/<projectId>/footage (cleaned + full-cleaned) and write footage/manifest.json.",
    inputSchema: {
      projectId: z.string(),
      brandId: z.number().optional(),
      adId: z.number().optional(),
      cleanedOnly: z.boolean().optional(),
      includeFullAds: z.boolean().optional(),
      limit: z.number().optional(),
    },
  },
  async (opts) => {
    const result = await importReelFootage({
      projectId: opts.projectId,
      brandId: opts.brandId,
      adId: opts.adId,
      cleanedOnly: opts.cleanedOnly ?? true,
      includeFullAds: opts.includeFullAds ?? true,
      limit: opts.limit,
    });
    return textResult(
      JSON.stringify(
        {
          footageDir: result.footageDir,
          fullDir: result.fullDir,
          manifestPath: result.manifestPath,
          importedShotsCount: result.shots.length,
          importedFullAdsCount: result.fullAds.length,
          shots: result.shots.map((s) => ({
            id: s.id,
            localPath: s.localPath,
            storageKey: s.storageKey,
          })),
          fullAds: result.fullAds.map((a) => ({
            id: a.id,
            localPath: a.localPath,
            storageKey: a.clean_full_path,
          })),
        },
        null,
        2,
      ),
    );
  },
);

mcp.registerTool(
  "reel_generate_clip",
  {
    description: "Generate an AI b-roll clip via fal (Seedance / Kling) into project ai-clips/.",
    inputSchema: {
      projectId: z.string(),
      prompt: z.string(),
      model: z.enum(["seedance-2-t2v", "seedance-2", "kling-21"]).optional(),
      imageUrl: z.string().optional(),
      durationSec: z.number().optional(),
      slug: z.string().optional(),
    },
  },
  async (opts) => {
    const result = await generateAiClip({
      projectId: opts.projectId,
      prompt: opts.prompt,
      model: opts.model as ClipModel | undefined,
      imageUrl: opts.imageUrl,
      durationSec: opts.durationSec,
      slug: opts.slug,
    });
    return textResult(JSON.stringify(result, null, 2));
  },
);

mcp.registerTool(
  "reel_audio_only",
  {
    description: "Run pnpm reel --audio-only (voiceover only). Optional projectId scopes REEL_OUTPUT_BASE.",
    inputSchema: {
      scriptPath: z.string(),
      projectId: z.string().optional(),
      from: z.string().optional(),
    },
  },
  async ({ scriptPath, projectId, from }) => {
    const args = ["reel", resolve(scriptPath), "--audio-only"];
    if (from) args.push("--from", resolve(from));
    const extraEnv: Record<string, string> = {};
    if (projectId) {
      extraEnv.REEL_OUTPUT_BASE = resolveReelProjectDir(projectId);
    }
    const { code, stdout, stderr } = await runPnpm(args, extraEnv);
    return textResult([stdout, stderr].filter(Boolean).join("\n"), code !== 0);
  },
);

mcp.registerTool(
  "reel_storyboard",
  {
    description: "Generate keyframes: pnpm storyboard <script> --from <reel-dir>.",
    inputSchema: {
      scriptPath: z.string(),
      from: z.string(),
    },
  },
  async ({ scriptPath, from }) => {
    const { code, stdout, stderr } = await runPnpm([
      "storyboard",
      resolve(scriptPath),
      "--from",
      resolve(from),
    ]);
    return textResult([stdout, stderr].filter(Boolean).join("\n"), code !== 0);
  },
);

mcp.registerTool(
  "reel_approve_keyframe",
  {
    description: "Mark a keyframe approved (touch scene-N.png.approved).",
    inputSchema: {
      reelDir: z.string(),
      scene: z.number().int().positive(),
    },
  },
  async ({ reelDir, scene }) => {
    const marker = join(
      resolve(reelDir),
      "assets",
      "keyframes",
      `scene-${scene}.png.approved`,
    );
    await writeFile(marker, "", "utf-8");
    return textResult(`Approved: ${marker}`);
  },
);

mcp.registerTool(
  "reel_video_only",
  {
    description:
      "Irreversible video generation: pnpm reel --video-only --from <dir>. Requires confirm: true.",
    inputSchema: {
      scriptPath: z.string(),
      from: z.string(),
      confirm: z.literal(true),
    },
  },
  async ({ scriptPath, from }) => {
    const { code, stdout, stderr } = await runPnpm([
      "reel",
      resolve(scriptPath),
      "--video-only",
      "--from",
      resolve(from),
    ]);
    return textResult([stdout, stderr].filter(Boolean).join("\n"), code !== 0);
  },
);

mcp.registerTool(
  "reel_render",
  {
    description: "Remotion render: pnpm render <reel-dir>.",
    inputSchema: {
      reelDir: z.string(),
    },
  },
  async ({ reelDir }) => {
    const { code, stdout, stderr } = await runPnpm(["render", resolve(reelDir)]);
    return textResult([stdout, stderr].filter(Boolean).join("\n"), code !== 0);
  },
);

mcp.registerTool(
  "reel_scene_map",
  {
    description: "Generate scene-map.md: pnpm scene-map <reel-dir>.",
    inputSchema: {
      reelDir: z.string(),
    },
  },
  async ({ reelDir }) => {
    const { code, stdout, stderr } = await runPnpm(["scene-map", resolve(reelDir)]);
    return textResult([stdout, stderr].filter(Boolean).join("\n"), code !== 0);
  },
);

mcp.registerTool(
  "reel_status",
  {
    description: "Summarize artefacts present in a reel output directory.",
    inputSchema: {
      reelDir: z.string(),
    },
  },
  async ({ reelDir }) => {
    const status = await buildReelStatus(reelDir);
    return textResult(JSON.stringify(status, null, 2));
  },
);

mcp.registerTool(
  "reel_publish_to_wasabi",
  {
    description:
      "Upload final.mp4 from a local reel output dir to Wasabi ProjectHub (generated_videos + project-files storage).",
    inputSchema: {
      projectId: z.string(),
      reelDir: z.string(),
      brandId: z.number().optional(),
      name: z.string().optional(),
      script: z.string().optional(),
      voice: z.string().optional(),
      language: z.string().optional(),
    },
  },
  async (opts) => {
    try {
      const result = await publishReelToWasabi({
        projectId: opts.projectId,
        reelDir: opts.reelDir,
        brandId: opts.brandId,
        name: opts.name,
        script: opts.script,
        voice: opts.voice,
        language: opts.language,
      });
      return textResult(JSON.stringify(result, null, 2));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return textResult(msg, true);
    }
  },
);

mcp.registerTool(
  "reel_list_projects_dir",
  {
    description: "List project folders under REEL_OUTPUT_BASE (Wasabi multi-project layout).",
    inputSchema: {},
  },
  async () => {
    const base = reelOutputBase();
    let entries: string[] = [];
    try {
      entries = await readdir(base);
    } catch {
      return textResult(JSON.stringify({ base, projects: [] }, null, 2));
    }
    const projects: Array<{ id: string; footage: boolean; aiClips: boolean }> = [];
    for (const id of entries) {
      if (id.startsWith(".")) continue;
      const root = join(base, id);
      projects.push({
        id,
        footage: await pathExists(join(root, "footage", "cleaned")),
        aiClips: await pathExists(join(root, "ai-clips")),
      });
    }
    return textResult(JSON.stringify({ base, projects }, null, 2));
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
