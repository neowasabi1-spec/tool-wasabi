import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { ensureProjectDirs } from "./paths";

const BUCKET = "project-files";

export type CleanedShot = {
  id: number;
  project_id: string;
  brand_id?: number | null;
  ad_id?: number | null;
  file_path: string;
  clean_path?: string | null;
  has_text?: boolean | null;
  duration_sec?: number | null;
  caption?: string | null;
  action?: string | null;
  tags?: string[] | null;
};

export type ImportedShot = CleanedShot & {
  storageKey: string;
  localPath: string;
};

function getSupabase(): SupabaseClient {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";
  if (!url || !key) {
    throw new Error(
      "Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Same usability rule as Competitor Library UI: cleaned OR never had burned-in text. */
export function usableStorageKey(s: CleanedShot): string | null {
  if (s.clean_path) return s.clean_path;
  if (s.has_text !== true && s.file_path) return s.file_path;
  return null;
}

export async function listCleanedShots(opts: {
  projectId: string;
  brandId?: number;
  adId?: number;
  cleanedOnly?: boolean;
  limit?: number;
}): Promise<CleanedShot[]> {
  const sb = getSupabase();
  let q = sb
    .from("competitor_shots")
    .select(
      "id, project_id, brand_id, ad_id, file_path, clean_path, has_text, duration_sec, caption, action, tags",
    )
    .eq("project_id", opts.projectId)
    .order("id", { ascending: false })
    .limit(opts.limit ?? 200);

  if (opts.brandId != null) q = q.eq("brand_id", opts.brandId);
  if (opts.adId != null) q = q.eq("ad_id", opts.adId);
  if (opts.cleanedOnly) q = q.not("clean_path", "is", null);

  const { data, error } = await q;
  if (error) throw new Error(`competitor_shots query failed: ${error.message}`);

  const rows = (data || []) as CleanedShot[];
  return rows.filter((s) => usableStorageKey(s) != null);
}

async function downloadToFile(
  sb: SupabaseClient,
  storageKey: string,
  dest: string,
): Promise<void> {
  const { data, error } = await sb.storage.from(BUCKET).download(storageKey);
  if (error || !data) {
    throw new Error(`storage download ${storageKey}: ${error?.message || "no data"}`);
  }
  const body = data.stream ? data.stream() : Readable.fromWeb(data as unknown as import("stream/web").ReadableStream);
  // Blob in supabase-js node often has arrayBuffer
  if (typeof (data as Blob).arrayBuffer === "function" && !data.stream) {
    const buf = Buffer.from(await (data as Blob).arrayBuffer());
    await pipeline(Readable.from(buf), createWriteStream(dest));
    return;
  }
  const nodeStream =
    body instanceof Readable
      ? body
      : Readable.fromWeb(body as import("stream/web").ReadableStream);
  await pipeline(nodeStream, createWriteStream(dest));
}

export type CleanedFullAd = {
  id: number;
  project_id: string;
  brand_id: number;
  name?: string | null;
  clean_full_path: string;
  clean_status?: string | null;
};

export type ImportedFullAd = CleanedFullAd & {
  localPath: string;
};

export async function listCleanedFullAds(opts: {
  projectId: string;
  brandId?: number;
  adId?: number;
  limit?: number;
}): Promise<CleanedFullAd[]> {
  const sb = getSupabase();
  let q = sb
    .from("competitor_ads")
    .select("id, project_id, brand_id, name, clean_full_path, clean_status")
    .eq("project_id", opts.projectId)
    .not("clean_full_path", "is", null)
    .order("id", { ascending: false })
    .limit(opts.limit ?? 100);

  if (opts.brandId != null) q = q.eq("brand_id", opts.brandId);
  if (opts.adId != null) q = q.eq("id", opts.adId);

  const { data, error } = await q;
  if (error) {
    if (/clean_full_path/i.test(error.message || "")) return [];
    throw new Error(`competitor_ads query failed: ${error.message}`);
  }
  return ((data || []) as CleanedFullAd[]).filter((a) =>
    String(a.clean_full_path || "").trim(),
  );
}

export async function importCleanedShots(opts: {
  projectId: string;
  brandId?: number;
  adId?: number;
  cleanedOnly?: boolean;
  limit?: number;
}): Promise<{ footageDir: string; imported: ImportedShot[] }> {
  const { footage } = ensureProjectDirs(opts.projectId);
  const sb = getSupabase();
  const shots = await listCleanedShots({
    ...opts,
    cleanedOnly: opts.cleanedOnly ?? true,
  });

  const imported: ImportedShot[] = [];
  for (const s of shots) {
    const key = usableStorageKey(s);
    if (!key) continue;
    const ext = key.split(".").pop()?.toLowerCase() || "mp4";
    const localPath = join(footage, `shot-${s.id}.${ext}`);
    try {
      await downloadToFile(sb, key, localPath);
      imported.push({ ...s, storageKey: key, localPath });
    } catch (e) {
      console.warn(`[import-cleaned] skip shot ${s.id}:`, e);
    }
  }

  return { footageDir: footage, imported };
}

export async function importCleanedFullAds(opts: {
  projectId: string;
  brandId?: number;
  adId?: number;
  limit?: number;
}): Promise<{ fullDir: string; imported: ImportedFullAd[] }> {
  const { fullCleaned } = ensureProjectDirs(opts.projectId);
  const sb = getSupabase();
  const ads = await listCleanedFullAds(opts);
  const imported: ImportedFullAd[] = [];
  for (const a of ads) {
    const key = String(a.clean_full_path || "").trim();
    if (!key) continue;
    const ext = key.split(".").pop()?.toLowerCase() || "mp4";
    const localPath = join(fullCleaned, `ad-${a.id}.${ext}`);
    try {
      await downloadToFile(sb, key, localPath);
      imported.push({ ...a, localPath });
    } catch (e) {
      console.warn(`[import-full-cleaned] skip ad ${a.id}:`, e);
    }
  }
  return { fullDir: fullCleaned, imported };
}

/** Shots + full cleaned ads; writes footage/manifest.json under the project root. */
export async function importReelFootage(opts: {
  projectId: string;
  brandId?: number;
  adId?: number;
  cleanedOnly?: boolean;
  includeFullAds?: boolean;
  limit?: number;
}): Promise<{
  footageDir: string;
  fullDir: string;
  shots: ImportedShot[];
  fullAds: ImportedFullAd[];
  manifestPath: string;
}> {
  const { writeFileSync } = await import("node:fs");
  const dirs = ensureProjectDirs(opts.projectId);
  const { imported: shots } = await importCleanedShots(opts);
  const fullAds =
    opts.includeFullAds === false
      ? []
      : (await importCleanedFullAds(opts)).imported;

  const manifest = {
    projectId: opts.projectId,
    brandId: opts.brandId ?? null,
    adId: opts.adId ?? null,
    exportedAt: new Date().toISOString(),
    footageDir: dirs.footage,
    fullDir: dirs.fullCleaned,
    shots: shots.map((s) => ({
      id: s.id,
      adId: s.ad_id,
      brandId: s.brand_id,
      localPath: s.localPath,
      storageKey: s.storageKey,
      durationSec: s.duration_sec,
      caption: s.caption,
      action: s.action,
    })),
    fullAds: fullAds.map((a) => ({
      id: a.id,
      brandId: a.brand_id,
      name: a.name,
      localPath: a.localPath,
      storageKey: a.clean_full_path,
    })),
  };
  const manifestPath = join(dirs.root, "footage", "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  return {
    footageDir: dirs.footage,
    fullDir: dirs.fullCleaned,
    shots,
    fullAds,
    manifestPath,
  };
}

export async function reelFootageStatus(projectId: string): Promise<{
  projectId: string;
  usableShots: number;
  cleanedShots: number;
  fullCleanedAds: number;
}> {
  const [usable, cleanedOnly, fullAds] = await Promise.all([
    listCleanedShots({ projectId, cleanedOnly: false }),
    listCleanedShots({ projectId, cleanedOnly: true }),
    listCleanedFullAds({ projectId }),
  ]);
  return {
    projectId,
    usableShots: usable.length,
    cleanedShots: cleanedOnly.length,
    fullCleanedAds: fullAds.length,
  };
}
