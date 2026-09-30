import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as T;
}

/**
 * Hash corto del contenuto di script.json. Salvato in composition-props.json
 * (campo scriptHash) per rilevare a render-time se lo script è stato modificato
 * dopo l'ultimo calcolo dei props — elimina il gotcha "props cached stale".
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Default output base directory.
 * Override con REEL_OUTPUT_BASE in .env (path assoluto). Default: ~/Movies/reel-ai
 * — funziona su qualsiasi macchina/utente, non solo sul setup originale.
 */
export const OUTPUT_BASE =
  process.env.REEL_OUTPUT_BASE?.trim() || join(homedir(), "Movies", "reel-ai");

/** Generate output directory path for a new reel */
export function getOutputDir(baseDir?: string): string {
  const base = baseDir ?? OUTPUT_BASE;
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const seq = String(Date.now()).slice(-4); // last 4 digits of timestamp as sequence
  return join(base, date, `reel-${seq}`);
}
