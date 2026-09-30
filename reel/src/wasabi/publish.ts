import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const BUCKET = "project-files";

export type PublishReelInput = {
  projectId: string;
  reelDir: string;
  brandId?: number;
  name?: string;
  script?: string;
  voice?: string;
  language?: string;
};

export type PublishReelResult = {
  id: number;
  file_path: string;
  thumb_path: string | null;
  duration_sec: number;
  urlHint: string;
};

function getSupabase(): SupabaseClient {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";
  if (!url || !key) {
    throw new Error(
      "Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function runCmd(
  bin: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn(bin, args, { shell: false });
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

export async function probeDurationSec(file: string): Promise<number> {
  const { code, stdout } = await runCmd("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  if (code !== 0) return 0;
  const n = parseFloat(stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

async function grabThumb(videoPath: string, dest: string, atSec = 1): Promise<void> {
  await runCmd("ffmpeg", [
    "-y",
    "-ss",
    String(atSec),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    dest,
  ]);
}

async function readScriptMeta(reelDir: string): Promise<{
  script?: string;
  voice?: string;
  language?: string;
}> {
  const scriptPath = join(reelDir, "script.json");
  if (!(await pathExists(scriptPath))) return {};
  try {
    const raw = JSON.parse(await readFile(scriptPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const voice =
      typeof raw.voiceId === "string"
        ? raw.voiceId
        : typeof raw.voice === "string"
          ? raw.voice
          : undefined;
    const language =
      typeof raw.language === "string" ? raw.language : undefined;
    const script =
      typeof raw.voiceoverText === "string"
        ? raw.voiceoverText
        : Array.isArray(raw.voiceoverSegments)
          ? (raw.voiceoverSegments as { text?: string }[])
              .map((s) => s.text || "")
              .filter(Boolean)
              .join("\n")
          : undefined;
    return { script, voice, language };
  } catch {
    return {};
  }
}

async function resolveFinalMp4(reelDir: string): Promise<string> {
  const abs = resolve(reelDir);
  const direct = join(abs, "final.mp4");
  if (await pathExists(direct)) return direct;
  throw new Error(`final.mp4 not found under ${abs}`);
}

async function resolveOptionalThumb(
  reelDir: string,
  videoPath: string,
): Promise<string | null> {
  const abs = resolve(reelDir);
  for (const candidate of [
    join(abs, "thumb.jpg"),
    join(abs, "assets", "thumb.jpg"),
  ]) {
    if (await pathExists(candidate)) return candidate;
  }
  const tmp = join(abs, ".publish-thumb.jpg");
  try {
    await grabThumb(videoPath, tmp);
    if (await pathExists(tmp)) return tmp;
  } catch {
    /* optional */
  }
  return null;
}

function urlHintForPath(filePath: string): string {
  return `/api/projecthub/file-proxy?path=${encodeURIComponent(filePath)}`;
}

export type PublishVideoBuffersInput = {
  projectId: string;
  video: Buffer;
  thumb?: Buffer | null;
  brandId?: number;
  adId?: number;
  script?: string | null;
  voice?: string | null;
  language?: string | null;
  durationSec?: number;
  fileBasename?: string;
};

export async function publishVideoBuffersToWasabi(
  sb: SupabaseClient,
  opts: PublishVideoBuffersInput,
): Promise<PublishReelResult> {
  const stamp = Date.now();
  const base = opts.fileBasename?.replace(/[^\w.-]+/g, "_") || `reel-${stamp}`;
  const clipKey = `${opts.projectId}/generated-videos/${base}.mp4`;
  const thumbKey = `${opts.projectId}/generated-videos/${base}.jpg`;

  const { error: upErr } = await sb.storage.from(BUCKET).upload(clipKey, opts.video, {
    contentType: "video/mp4",
    upsert: false,
  });
  if (upErr) {
    throw new Error(`storage upload video: ${upErr.message}`);
  }

  let storedThumb: string | null = null;
  if (opts.thumb && opts.thumb.length > 0) {
    const { error: thErr } = await sb.storage
      .from(BUCKET)
      .upload(thumbKey, opts.thumb, { contentType: "image/jpeg", upsert: false });
    if (!thErr) storedThumb = thumbKey;
  }

  const duration =
    opts.durationSec != null && opts.durationSec > 0
      ? opts.durationSec
      : 0;

  const gvRow: Record<string, unknown> = {
    project_id: opts.projectId,
    brand_id: opts.brandId ?? 0,
    ad_id: opts.adId ?? 0,
    file_path: clipKey,
    thumb_path: storedThumb,
    duration_sec: +duration.toFixed(2),
    script: opts.script ?? null,
    voice: opts.voice ?? null,
    language: opts.language ?? null,
  };

  let gvRes = await sb
    .from("generated_videos")
    .insert(gvRow)
    .select("id")
    .maybeSingle();
  if (gvRes.error && /language/i.test(gvRes.error.message)) {
    delete gvRow.language;
    gvRes = await sb
      .from("generated_videos")
      .insert(gvRow)
      .select("id")
      .maybeSingle();
  }
  if (gvRes.error || !gvRes.data?.id) {
    throw new Error(
      `generated_videos insert: ${gvRes.error?.message || "no id"}`,
    );
  }

  return {
    id: gvRes.data.id as number,
    file_path: clipKey,
    thumb_path: storedThumb,
    duration_sec: +duration.toFixed(2),
    urlHint: urlHintForPath(clipKey),
  };
}

export async function publishReelToWasabi(
  opts: PublishReelInput,
): Promise<PublishReelResult> {
  const sb = getSupabase();
  const reelDir = resolve(opts.reelDir);
  const videoPath = await resolveFinalMp4(reelDir);
  const meta = await readScriptMeta(reelDir);
  const durationSec = await probeDurationSec(videoPath);
  const thumbPath = await resolveOptionalThumb(reelDir, videoPath);

  const video = await readFile(videoPath);
  const thumb =
    thumbPath && (await pathExists(thumbPath))
      ? await readFile(thumbPath)
      : null;

  const stamp = Date.now();
  const slug =
    opts.name?.trim().replace(/[^\w.-]+/g, "-").slice(0, 48) || `reel-${stamp}`;

  return publishVideoBuffersToWasabi(sb, {
    projectId: opts.projectId,
    video,
    thumb,
    brandId: opts.brandId,
    script: opts.script ?? meta.script ?? null,
    voice: opts.voice ?? meta.voice ?? "elevenlabs",
    language: opts.language ?? meta.language ?? null,
    durationSec,
    fileBasename: slug,
  });
}
