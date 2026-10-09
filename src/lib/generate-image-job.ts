import { supabaseAdmin } from '@/lib/supabase-admin';
import { lastImageGenError, openaiGenerateImageBytes } from '@/lib/openai-image';

const JOB_BUCKET = 'project-files';
const RESULT_BUCKET = 'media';

export const GPT_JOB_MARKER = 'gpt-job';

export type GenerateImageJob = {
  status: 'pending' | 'running' | 'completed' | 'error';
  error?: string;
  prompt: string;
  imageUrls: string[];
  size?: string;
  url?: string;
  createdAt: number;
};

function jobPath(jobId: string): string {
  return `editor-ai-jobs/${jobId}.json`;
}

export function isGptImageJobId(id: string | undefined): boolean {
  return Boolean(id && id.startsWith('gptjob_'));
}

export function newGptImageJobId(): string {
  return `gptjob_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function writeGenerateImageJob(
  jobId: string,
  job: GenerateImageJob,
): Promise<string | null> {
  const { error } = await supabaseAdmin.storage.from(JOB_BUCKET).upload(
    jobPath(jobId),
    Buffer.from(JSON.stringify(job)),
    { contentType: 'application/json', upsert: true },
  );
  return error ? error.message : null;
}

export async function readGenerateImageJob(jobId: string): Promise<GenerateImageJob | null> {
  const { data, error } = await supabaseAdmin.storage.from(JOB_BUCKET).download(jobPath(jobId));
  if (error || !data) return null;
  try {
    return JSON.parse(await data.text()) as GenerateImageJob;
  } catch {
    return null;
  }
}

async function persistResult(jobId: string, buf: Buffer, mime: string): Promise<string | null> {
  const ext = /webp/i.test(mime) ? 'webp' : /jpe?g/i.test(mime) ? 'jpg' : 'png';
  const path = `editor-uploads/${Date.now()}_${jobId}.${ext}`;
  const { error } = await supabaseAdmin.storage.from(RESULT_BUCKET).upload(path, buf, {
    contentType: mime || 'image/png',
    upsert: false,
  });
  if (error) return null;
  const { data } = supabaseAdmin.storage.from(RESULT_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}

export async function runGenerateImageJob(jobId: string): Promise<void> {
  const job = await readGenerateImageJob(jobId);
  if (!job || job.status === 'completed' || job.status === 'error') return;
  if (job.status === 'running' && Date.now() - job.createdAt < 3 * 60_000) return;
  await writeGenerateImageJob(jobId, { ...job, status: 'running' });
  const made = await openaiGenerateImageBytes({
    prompt: job.prompt,
    imageUrls: job.imageUrls,
    size: job.size,
    quality: 'medium',
    timeoutMs: 170_000,
    openaiOnly: true,
  });
  if (!made) {
    await writeGenerateImageJob(jobId, {
      ...job,
      status: 'error',
      error: lastImageGenError() || 'ChatGPT Image 2 failed',
    });
    return;
  }
  const url = await persistResult(jobId, made.buf, made.mime);
  if (!url) {
    await writeGenerateImageJob(jobId, {
      ...job,
      status: 'error',
      error: 'Could not store the generated image',
    });
    return;
  }
  await writeGenerateImageJob(jobId, {
    ...job,
    status: 'completed',
    url,
    imageUrls: [],
  });
}
