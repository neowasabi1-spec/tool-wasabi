/**
 * Keyframe cache invalidation via SHA-1 hash of (visualPrompt + referenceUrl).
 *
 * Stage 1.7 Storyboard genera 1 keyframe per scena con Gemini 3 Pro Image.
 * Per evitare di rigenerare costantemente (costo ~$0.06-0.10 per immagine),
 * la pipeline calcola un hash combinato di:
 *   - visualPrompt della scena (che è anche il prompt del keyframe)
 *   - keyframeReferenceUrl (opzionale, può essere Pinterest pin URL)
 *
 * L'hash viene salvato in un file companion `<keyframe>.hash` accanto al PNG.
 * Al run successivo, se l'hash combacia → skip. Se cambia → rigenera + reset
 * `keyframeApproved` (perché il keyframe nuovo va riapprovato dal gate).
 *
 * Vedi [[feedback-memory-into-tools]]: niente cache "ricordati di rigenerare",
 * il tool gestisce invalidation automaticamente.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";

/**
 * Hash a 16 caratteri di (prompt + ref), abbastanza per cache invalidation
 * pratica senza essere visivamente pesante. SHA-1 troncato.
 */
export function keyframeHash(visualPrompt: string, referenceUrl?: string): string {
  const hash = createHash("sha1");
  hash.update(visualPrompt.trim());
  hash.update("|");
  hash.update((referenceUrl ?? "").trim());
  return hash.digest("hex").slice(0, 16);
}

/**
 * Ritorna true se il keyframe PNG esiste E il suo file .hash contiene
 * l'expectedHash. False se uno dei due manca o l'hash è diverso.
 */
export async function isKeyframeFresh(keyframePath: string, expectedHash: string): Promise<boolean> {
  try {
    const pngStat = await stat(keyframePath);
    if (!pngStat.isFile() || pngStat.size === 0) return false;
    const stored = await readFile(`${keyframePath}.hash`, "utf8");
    return stored.trim() === expectedHash;
  } catch {
    return false;
  }
}

/**
 * Scrive il file companion `<keyframe>.hash` per il PNG appena generato.
 * Chiamare DOPO che il PNG è stato salvato con successo.
 */
export async function writeKeyframeHash(keyframePath: string, hash: string): Promise<void> {
  await writeFile(`${keyframePath}.hash`, hash, "utf8");
}
