import sharp from 'sharp';

/** Difference hash a 64 bit: somiglianza visiva deterministica, senza modelli. */
export async function dhash(buf: Buffer): Promise<string> {
  const px = await sharp(buf).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? '1' : '0';
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}

export function hamming(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

/** Fotogramma rappresentativo: per ora solo immagini (i video usano la descrizione). */
export async function isImage(buf: Buffer): Promise<boolean> {
  try { await sharp(buf).metadata(); return true; } catch { return false; }
}
