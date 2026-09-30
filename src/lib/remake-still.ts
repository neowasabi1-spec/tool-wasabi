import { supabaseAdmin } from '@/lib/supabase-admin';
import { lastImageGenError, openaiGenerateImageBytes } from '@/lib/openai-image';

const BUCKET = 'project-files';

export type RemakeJob = {
  status: 'pending' | 'running' | 'done' | 'error';
  error?: string;
  projectId: string;
  brandId: number;
  adId: number;
  prompt: string;
  productImageUrl?: string;
  language?: string;
  mode?: string;
  videoId?: number | null;
};

export function remakeJobPath(projectId: string, jobId: string): string {
  return `${projectId}/generated-jobs/${jobId}.json`;
}

export async function writeRemakeJob(projectId: string, jobId: string, job: RemakeJob): Promise<string | null> {
  const { error } = await supabaseAdmin.storage.from(BUCKET).upload(
    remakeJobPath(projectId, jobId),
    Buffer.from(JSON.stringify(job)),
    { contentType: 'application/json', upsert: true },
  );
  return error ? error.message : null;
}

export async function readRemakeJob(projectId: string, jobId: string): Promise<RemakeJob | null> {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(remakeJobPath(projectId, jobId));
  if (error || !data) return null;
  try {
    return JSON.parse(await data.text()) as RemakeJob;
  } catch {
    return null;
  }
}

async function signedUrl(path: string): Promise<string | null> {
  if (/^https?:\/\//i.test(path)) return path;
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

async function persistBytes(
  projectId: string,
  brandId: number,
  adId: number,
  body: { prompt?: string; language?: string; mode?: string },
  made: { buf: Buffer; mime: string },
): Promise<{ ok: true; videoId: number | null } | { ok: false; error: string }> {
  const mime = made.mime || 'image/png';
  const ext = /webp/i.test(mime) ? 'webp' : /jpe?g/i.test(mime) ? 'jpg' : 'png';
  const key = `${projectId}/generated/${adId}_img_${Date.now()}.${ext}`;
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(key, made.buf, {
    contentType: mime,
    upsert: true,
  });
  if (upErr) return { ok: false, error: upErr.message };

  const language = String(body.language || '').trim().slice(0, 40) || null;
  const prompt = String(body.prompt || body.mode || '').trim().slice(0, 2000);
  const row: Record<string, unknown> = {
    project_id: projectId,
    brand_id: brandId,
    ad_id: adId,
    file_path: key,
    thumb_path: key,
    duration_sec: 0,
    script: prompt || null,
    language,
  };
  let res = await supabaseAdmin.from('generated_videos').insert(row).select('id').maybeSingle();
  if (res.error && /language/i.test(res.error.message)) {
    delete row.language;
    res = await supabaseAdmin.from('generated_videos').insert(row).select('id').maybeSingle();
  }
  if (res.error) return { ok: false, error: res.error.message };
  const id = (res.data as { id?: number } | null)?.id ?? null;
  return { ok: true, videoId: id };
}

export async function createStillFromAd(
  projectId: string,
  brandId: number,
  adId: number,
  body: { prompt?: string; productImageUrl?: string; language?: string; mode?: string },
): Promise<{ ok: true; videoId: number | null } | { ok: false; error: string; status: number }> {
  const prompt = String(body.prompt || '').trim();
  if (prompt.length < 8) return { ok: false, error: 'Missing prompt', status: 400 };
  const { data: ad } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, file_path, media_type')
    .eq('id', adId)
    .eq('brand_id', brandId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (!ad) return { ok: false, error: 'Creative not found', status: 404 };
  const a = ad as { file_path?: string; media_type?: string };
  if (a.media_type === 'video' || !a.file_path) {
    return { ok: false, error: 'This action is for still images', status: 400 };
  }
  const sourceUrl = await signedUrl(a.file_path);
  if (!sourceUrl) return { ok: false, error: 'Could not sign the source image', status: 500 };
  const productUrl = String(body.productImageUrl || '').trim();
  const imageUrls = [sourceUrl, /^https?:\/\//i.test(productUrl) ? productUrl : ''].filter(Boolean);
  const made = await openaiGenerateImageBytes({
    prompt,
    imageUrls,
    size: '1024x1536',
    quality: 'medium',
    timeoutMs: 170_000,
  });
  if (!made) {
    return { ok: false, error: lastImageGenError() || 'ChatGPT Image 2 did not return an image', status: 502 };
  }
  const saved = await persistBytes(projectId, brandId, adId, body, made);
  if (!saved.ok) return { ok: false, error: saved.error, status: 500 };
  return { ok: true, videoId: saved.videoId };
}

export async function runRemakeJob(projectId: string, jobId: string): Promise<void> {
  const job = await readRemakeJob(projectId, jobId);
  if (!job || job.status === 'done' || job.status === 'error' || job.status === 'running') return;
  const runningErr = await writeRemakeJob(projectId, jobId, { ...job, status: 'running' });
  if (runningErr) return;
  try {
    const result = await createStillFromAd(projectId, job.brandId, job.adId, job);
    if (result.ok) {
      await writeRemakeJob(projectId, jobId, { ...job, status: 'done', videoId: result.videoId, error: '' });
    } else {
      await writeRemakeJob(projectId, jobId, { ...job, status: 'error', error: result.error });
    }
  } catch (e) {
    await writeRemakeJob(projectId, jobId, {
      ...job,
      status: 'error',
      error: (e as Error).message || 'ChatGPT Image 2 failed',
    });
  }
}
