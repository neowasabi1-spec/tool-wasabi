import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Istruzioni di installazione per piattaforma, mostrate quando un binario manca. */
const INSTALL_HINTS: Record<string, string> = {
  ffmpeg:
    "macOS: brew install ffmpeg · Windows: winget install ffmpeg (o via WSL2: sudo apt install ffmpeg) · Linux: sudo apt install ffmpeg",
  ffprobe:
    "ffprobe è incluso in ffmpeg. macOS: brew install ffmpeg · Windows: winget install ffmpeg · Linux: sudo apt install ffmpeg",
  whisper:
    "pip install openai-whisper (richiede Python 3.10+). Se è installato fuori dal PATH, imposta WHISPER_BIN nel .env col path assoluto.",
};

/**
 * Verifica che i binari di sistema richiesti esistano PRIMA di partire.
 * Senza questo check, un binario mancante produce un "ENOENT spawn ffmpeg"
 * criptico a metà pipeline (magari dopo aver già speso soldi in API).
 */
export async function ensureBinaries(bins: string[]): Promise<void> {
  const missing: string[] = [];
  for (const bin of bins) {
    try {
      await execFileAsync(bin, ["-version"]);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // ENOENT = binario non trovato. Altri errori (es. exit code ≠ 0 per
      // flag -version non supportato) significano che il binario ESISTE.
      if (code === "ENOENT") missing.push(bin);
    }
  }
  if (missing.length > 0) {
    const lines = missing.map(
      (b) => `   • ${b} — ${INSTALL_HINTS[b] ?? "installalo e assicurati che sia nel PATH"}`
    );
    throw new Error(
      `Prerequisiti mancanti: ${missing.join(", ")}\n${lines.join("\n")}\n` +
        `   Dopo l'installazione riapri il terminale e rilancia il comando.`
    );
  }
}
