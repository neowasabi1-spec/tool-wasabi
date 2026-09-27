import crypto from 'node:crypto';
import { db } from './db';

const BUCKET = 'project-files';

export async function putMedia(path: string, body: Buffer, contentType: string) {
  const { error } = await db().storage.from(BUCKET).upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`Upload ${path}: ${error.message}`);
  return path;
}

export async function getMedia(path: string): Promise<Buffer> {
  const { data, error } = await db().storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`Download ${path}: ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}

export async function signedUrl(path: string, seconds = 3600): Promise<string> {
  const { data, error } = await db().storage.from(BUCKET).createSignedUrl(path, seconds);
  if (error || !data) throw new Error(`Signed URL ${path}: ${error?.message}`);
  return data.signedUrl;
}

export async function signedUrls(paths: string[], seconds = 3600): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const { data } = await db().storage.from(BUCKET).createSignedUrls(paths, seconds);
  const out: Record<string, string> = {};
  for (const d of data ?? []) if (d.path && d.signedUrl) out[d.path] = d.signedUrl;
  return out;
}

export const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

export function extFor(contentType: string): string {
  if (contentType.includes('mp4')) return 'mp4';
  if (contentType.includes('quicktime')) return 'mov';
  if (contentType.includes('webm')) return 'webm';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  return 'jpg';
}
