import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  publishReelToWasabi as publishReelFromDisk,
  publishVideoBuffersToWasabi,
  probeDurationSec,
  type PublishReelInput,
  type PublishReelResult,
} from '../../../reel/src/wasabi/publish';

export { probeDurationSec };

export type { PublishReelInput, PublishReelResult };

/** Local reel output dir → Supabase `generated_videos` (same as MCP). */
export const publishReelToWasabi = publishReelFromDisk;

/** Publish an uploaded mp4 (FormData / API) into ProjectHub generated_videos. */
export async function publishReelUploadToWasabi(opts: {
  projectId: string;
  video: Buffer;
  thumb?: Buffer | null;
  brandId?: number;
  name?: string;
  script?: string | null;
  voice?: string | null;
  language?: string | null;
  durationSec?: number;
}): Promise<PublishReelResult> {
  const stamp = Date.now();
  const slug =
    opts.name?.trim().replace(/[^\w.-]+/g, '-').slice(0, 48) || `reel-${stamp}`;

  return publishVideoBuffersToWasabi(supabaseAdmin, {
    projectId: opts.projectId,
    video: opts.video,
    thumb: opts.thumb,
    brandId: opts.brandId,
    script: opts.script,
    voice: opts.voice ?? 'elevenlabs',
    language: opts.language,
    durationSec: opts.durationSec,
    fileBasename: slug,
  });
}
