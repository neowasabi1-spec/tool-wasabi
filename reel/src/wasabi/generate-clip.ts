import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { ensureProjectDirs } from "./paths";

/**
 * Optional AI b-roll for when the CLEANED shot pool isn't enough.
 * Uses the same fal endpoints as tool-wasabi generate-image (Seedance / Kling).
 */

export type ClipModel = "seedance-2-t2v" | "seedance-2" | "kling-21";

const ENDPOINTS: Record<
  ClipModel,
  { endpoint: string; kind: "t2v" | "i2v" }
> = {
  "seedance-2-t2v": {
    endpoint: "bytedance/seedance-2.0/text-to-video",
    kind: "t2v",
  },
  "seedance-2": {
    endpoint: "bytedance/seedance-2.0/image-to-video",
    kind: "i2v",
  },
  "kling-21": {
    endpoint: "fal-ai/kling-video/v2.1/standard/image-to-video",
    kind: "i2v",
  },
};

function falKey(): string {
  const k = process.env.FAL_KEY || process.env.FAL_AI_API_KEY || "";
  if (!k) throw new Error("FAL_KEY not set");
  return k;
}

async function falSubmit(
  endpoint: string,
  input: Record<string, unknown>,
  apiKey: string,
): Promise<{ request_id: string; status_url: string; response_url: string }> {
  const res = await fetch(`https://queue.fal.run/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${apiKey}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`fal submit ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  return res.json();
}

async function falPoll(
  statusUrl: string,
  responseUrl: string,
  apiKey: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<unknown> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await fetch(statusUrl, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!st.ok) {
      throw new Error(`fal status ${st.status}: ${(await st.text()).slice(0, 300)}`);
    }
    const body = (await st.json()) as { status: string; error?: string };
    if (body.status === "COMPLETED") {
      const r = await fetch(responseUrl, {
        headers: { Authorization: `Key ${apiKey}` },
      });
      if (!r.ok) {
        throw new Error(`fal result ${r.status}: ${(await r.text()).slice(0, 300)}`);
      }
      return r.json();
    }
    if (body.status === "ERROR" || body.status === "FAILED") {
      throw new Error(`fal job failed: ${body.error || body.status}`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error("fal job timed out");
}

function videoUrlFromResult(result: unknown): string {
  const r = result as { video?: { url?: string }; video_url?: string };
  const url = r.video?.url || r.video_url;
  if (!url) throw new Error("fal result missing video url");
  return url;
}

export async function generateAiClip(opts: {
  projectId: string;
  prompt: string;
  model?: ClipModel;
  imageUrl?: string;
  durationSec?: number;
  slug?: string;
}): Promise<{ localPath: string; remoteUrl: string; model: ClipModel }> {
  const model = opts.model || (opts.imageUrl ? "seedance-2" : "seedance-2-t2v");
  const conf = ENDPOINTS[model];
  if (conf.kind === "i2v" && !opts.imageUrl) {
    throw new Error(`Model ${model} requires imageUrl`);
  }

  const { aiClips } = ensureProjectDirs(opts.projectId);
  const apiKey = falKey();
  const duration =
    opts.durationSec && opts.durationSec >= 8 ? "10" : "5";

  const input: Record<string, unknown> =
    conf.kind === "t2v"
      ? {
          prompt: opts.prompt,
          duration,
          resolution: "720p",
          aspect_ratio: "9:16",
          generate_audio: false,
        }
      : {
          prompt: opts.prompt,
          image_url: opts.imageUrl,
          duration: model === "kling-21" ? duration : duration,
          ...(model === "seedance-2"
            ? { resolution: "720p", generate_audio: false }
            : {}),
        };

  const submitted = await falSubmit(conf.endpoint, input, apiKey);
  const result = await falPoll(submitted.status_url, submitted.response_url, apiKey);
  const remoteUrl = videoUrlFromResult(result);

  const slug =
    (opts.slug || "clip")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-|-$/g, "") || "clip";
  const localPath = join(aiClips, `${Date.now()}-${slug}.mp4`);

  const dl = await fetch(remoteUrl);
  if (!dl.ok || !dl.body) throw new Error(`download clip failed: ${dl.status}`);
  await pipeline(
    Readable.fromWeb(dl.body as import("stream/web").ReadableStream),
    createWriteStream(localPath),
  );

  return { localPath, remoteUrl, model };
}
