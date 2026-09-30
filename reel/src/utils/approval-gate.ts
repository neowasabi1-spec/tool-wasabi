/**
 * GATE 4 — Approval gate per i keyframe (storyboard).
 *
 * Meccanismo semplicissimo: un file marker zero-byte `<keyframe>.approved`
 * accanto al PNG. La pipeline blocca lo Stage 2 image-to-video se ci sono
 * keyframe non approvati per scene che richiedono image input.
 *
 * Workflow utente:
 *   1. pnpm storyboard → genera scene-N.png + scene-N.png.hash
 *   2. open keyframes.html → review visiva
 *   3. Approva: touch scene-N.png.approved
 *      Rifiuta+rigenera: edit script.json + pnpm storyboard --force-regen=N
 *   4. pnpm reel --video-only → gate passa solo se tutti approvati
 *
 * Vantaggio del marker file vs campo JSON:
 *   - Zero edit dello script.json per approvare
 *   - Comando trivialmente CLI-friendly (touch)
 *   - HTML gallery può mostrare stato senza riparsare JSON
 *   - Cache invalidation: rigenerare il keyframe elimina anche il marker
 */

import { access, writeFile, unlink } from "node:fs/promises";

const APPROVED_SUFFIX = ".approved";

export function approvalMarkerPath(keyframePath: string): string {
  return `${keyframePath}${APPROVED_SUFFIX}`;
}

export async function isKeyframeApproved(keyframePath: string): Promise<boolean> {
  try {
    await access(approvalMarkerPath(keyframePath));
    return true;
  } catch {
    return false;
  }
}

export async function approveKeyframe(keyframePath: string): Promise<void> {
  await writeFile(approvalMarkerPath(keyframePath), "", "utf8");
}

/**
 * Rimuove il marker .approved se esiste. Chiamato automaticamente quando
 * la pipeline rigenera un keyframe (cache invalidation per hash change),
 * o manualmente per "rifiutare" un keyframe già approvato.
 */
export async function unapproveKeyframe(keyframePath: string): Promise<void> {
  try {
    await unlink(approvalMarkerPath(keyframePath));
  } catch {
    // OK se il marker non esisteva
  }
}
