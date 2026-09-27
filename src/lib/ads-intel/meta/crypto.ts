import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

function keyBytes(): Buffer {
  const raw =
    process.env.META_TOKEN_ENCRYPTION_KEY ||
    process.env.DASHBOARD_API_SECRET ||
    process.env.APP_SECRET ||
    'dev-only-insecure-meta-key';
  return createHash('sha256').update(raw).digest();
}

/** AES-256-GCM; returns base64(iv|tag|ciphertext) */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
