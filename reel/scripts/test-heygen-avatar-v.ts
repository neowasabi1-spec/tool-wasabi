/**
 * HeyGen Avatar V — test pilota (digital twin).
 *
 * Valuta Avatar V come engine talking-head: stesso volto su ogni video +
 * lipsync phoneme-level dichiarato. Confronto mentale: OmniHuman v1.5
 * (lipsync attuale) e i path Kling i2v/r2v (character consistency).
 *
 * Flusso del test (3 step manuali, ognuno un subcommand):
 *
 *   1. pnpm test:heygen create-avatar <footage.mp4> --name="Michel"
 *      → upload footage (15-600s, max 32MB) → POST /v3/avatars (digital_twin)
 *      → poll training → stampa avatar_id (lk_*) + avatar_group_id (ag_*)
 *
 *   2. pnpm test:heygen consent <avatar_group_id>
 *      → POST /v3/avatars/{group_id}/consent → stampa URL da aprire nel
 *        browser e completare (obbligatorio prima di generare)
 *
 *   3a. pnpm test:heygen generate <avatar_id> --audio=<vo.mp3>
 *       → lipsync sul NOSTRO audio ElevenLabs (test più rilevante per i reel)
 *   3b. pnpm test:heygen generate <avatar_id> --script="..." --voice-id=<id>
 *       → TTS HeyGen (voice_id dalla libreria web HeyGen)
 *      Entrambi: POST /v3/videos engine avatar_v → poll → download mp4.
 *
 * Costo: $0.05/secondo di video generato (~$3/min). La stima viene stampata
 * e richiede conferma prima della POST. Creazione avatar + consent: il
 * pricing del training non è documentato separatamente — verificare il saldo
 * sulla dashboard API dopo lo step 1.
 *
 * Env richiesta: HEYGEN_API_KEY (in .env del reel-engine o env.sh condiviso).
 *
 * Usage:
 *   pnpm test:heygen create-avatar <footage.mp4> [--name="Michel Sainville"]
 *   pnpm test:heygen status <avatar_id>
 *   pnpm test:heygen consent <avatar_group_id>
 *   pnpm test:heygen generate <avatar_id> (--audio=<file.mp3> | --script="testo" --voice-id=<id>)
 *                    [--ar=9:16] [--res=1080p] [--out=<dir>] [--yes]
 */

import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { basename, join } from "node:path";
import { readFile, writeFile, stat } from "node:fs/promises";
import { ensureDir, OUTPUT_BASE } from "../src/utils/file-io.js";

const API_BASE = "https://api.heygen.com";
const COST_PER_SECOND = 0.05; // $/s video generato (API pay-as-you-go, 2026-06)
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

const apiKey = process.env.HEYGEN_API_KEY;

// ---------- helpers ----------

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function getFlag(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.split(/=(.*)/s)[1];
}

const hasFlag = (name: string) => process.argv.includes(`--${name}`);

async function heygen(
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "x-api-key": apiKey!,
      ...(init.body && typeof init.body === "string"
        ? { "content-type": "application/json" }
        : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    fail(`HeyGen ${init.method ?? "GET"} ${path} → HTTP ${res.status}\n${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function uploadAsset(filePath: string): Promise<string> {
  const info = await stat(filePath).catch(() => fail(`File non trovato: ${filePath}`));
  if (info.size > MAX_UPLOAD_BYTES) {
    fail(
      `${basename(filePath)} pesa ${(info.size / 1024 / 1024).toFixed(1)}MB — limite upload 32MB. ` +
        `Ricomprimi: ffmpeg -i in.mp4 -c:v libx264 -crf 23 -preset medium out.mp4`,
    );
  }
  const form = new FormData();
  const bytes = await readFile(filePath);
  form.append("file", new Blob([bytes]), basename(filePath));
  const res = await heygen("/v3/assets", { method: "POST", body: form as any });
  const assetId = res?.data?.asset_id;
  if (!assetId) fail(`Upload riuscito ma asset_id assente: ${JSON.stringify(res)}`);
  console.log(`📤 Asset caricato: ${assetId} (${(info.size / 1024 / 1024).toFixed(1)}MB)`);
  return assetId;
}

function probeDurationSec(filePath: string): number {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
    { encoding: "utf8" },
  );
  return parseFloat(out.trim());
}

async function confirm(question: string): Promise<boolean> {
  if (hasFlag("yes")) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- subcommands ----------

async function createAvatar(footagePath: string) {
  const duration = probeDurationSec(footagePath);
  if (duration < 15 || duration > 600) {
    fail(`Footage di ${duration.toFixed(1)}s — HeyGen richiede 15-600s.`);
  }
  console.log(`🎬 Footage: ${basename(footagePath)} (${duration.toFixed(1)}s)`);
  const assetId = await uploadAsset(footagePath);

  const res = await heygen("/v3/avatars", {
    method: "POST",
    body: JSON.stringify({
      type: "digital_twin",
      name: getFlag("name") ?? "Michel Sainville",
      file: { type: "asset_id", asset_id: assetId },
    }),
  });
  const item = res?.data?.avatar_item;
  const group = res?.data?.avatar_group;
  console.log(`\n✅ Avatar in training:`);
  console.log(`   avatar_id:       ${item?.id}`);
  console.log(`   avatar_group_id: ${group?.id}`);
  console.log(`   status:          ${item?.status}`);
  if (item?.status === "processing") {
    console.log(`\n⏳ Polling training (60s)...`);
    await pollAvatar(group.id);
  }
}

// Il GET status vive a livello GRUPPO (GET /v3/avatars/{avatar_id} → 404).
// La risposta porta anche consent_status e default_voice_id (voce clonata dal footage).
async function pollAvatar(groupId: string) {
  for (;;) {
    const res = await heygen(`/v3/avatars/${groupId}`);
    const d = res?.data ?? {};
    console.log(`   training: ${d.status} · consent: ${d.consent_status} · default_voice_id: ${d.default_voice_id}`);
    if (d.status === "completed") {
      if (d.consent_status && d.consent_status !== "skipped" && d.consent_status !== "approved") {
        console.log(`\n➡️  Serve il consent: pnpm test:heygen consent ${groupId}`);
      } else {
        console.log(`\n➡️  Pronto: pnpm test:heygen generate <avatar_id> --voice-id=${d.default_voice_id} --script="..."`);
      }
      return;
    }
    if (d.status === "failed") fail(`Training fallito: ${JSON.stringify(res)}`);
    await sleep(60_000);
  }
}

// Nuovo look della STESSA identità in scena/outfit diversi (type "prompt" + avatar_group_id).
async function createLook(groupId: string) {
  const prompt = getFlag("prompt");
  if (!prompt) fail(`Serve --prompt="descrizione scena/outfit" (max 1000 char).`);
  if (prompt.length > 1000) fail(`Prompt di ${prompt.length} char — max 1000.`);
  const body: Record<string, any> = {
    type: "prompt",
    name: getFlag("name") ?? "Look variant",
    prompt,
    avatar_group_id: groupId,
  };
  const refPath = getFlag("ref");
  if (refPath) {
    body.reference_images = [{ type: "asset_id", asset_id: await uploadAsset(refPath) }];
  }
  const res = await heygen("/v3/avatars", { method: "POST", body: JSON.stringify(body) });
  const lookId = res?.data?.avatar_item?.id;
  if (!lookId) fail(`Risposta senza look id: ${JSON.stringify(res)}`);
  console.log(`✨ Look in generazione: ${lookId} — polling ogni 30s...`);
  await pollLook(lookId);
}

async function pollLook(lookId: string) {
  for (;;) {
    const res = await heygen(`/v3/avatars/looks/${lookId}`);
    const d = res?.data ?? {};
    console.log(
      `   look: ${d.status} · engines: ${JSON.stringify(d.supported_api_engines ?? [])}` +
        (d.preview_image_url ? `\n   preview: ${d.preview_image_url}` : ""),
    );
    if (d.status === "completed") {
      if (!(d.supported_api_engines ?? []).includes("avatar_v")) {
        console.log(`   ⚠️ avatar_v non ancora tra gli engines — il run video potrebbe dare 400: riprova tra ~1 min.`);
      }
      console.log(`\n➡️  Genera: pnpm test:heygen generate ${lookId} --voice-id=<id> --script="..."`);
      return;
    }
    if (d.status === "failed") fail(`Look fallito: ${JSON.stringify(d.error)}`);
    await sleep(30_000);
  }
}

async function consent(groupId: string) {
  const res = await heygen(`/v3/avatars/${groupId}/consent`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const url = res?.data?.url ?? res?.url;
  if (!url) fail(`Risposta senza URL consent: ${JSON.stringify(res)}`);
  console.log(`\n🔏 Apri questo URL nel browser e completa il consent:\n\n   ${url}\n`);
  console.log(`Poi: pnpm test:heygen generate <avatar_id> --audio=<vo.mp3>`);
}

async function generate(avatarId: string) {
  const audioPath = getFlag("audio");
  const script = getFlag("script");
  const voiceId = getFlag("voice-id");
  if (!audioPath && !(script && voiceId)) {
    fail(`Serve --audio=<file> OPPURE --script="..." + --voice-id=<id> (libreria voci sul web HeyGen).`);
  }

  // Stima costo PRIMA di lanciare (con audio = durata reale; con script ~14 char/s parlato it)
  const estSec = audioPath ? probeDurationSec(audioPath) : (script!.length / 14);
  const estCost = estSec * COST_PER_SECOND;
  console.log(
    `💰 Stima: ~${estSec.toFixed(0)}s di video → ~$${estCost.toFixed(2)} ($${COST_PER_SECOND}/s)`,
  );
  if (!(await confirm("Procedo con la generazione?"))) fail("Annullato.");

  const body: Record<string, any> = {
    type: "avatar",
    avatar_id: avatarId,
    engine: { type: "avatar_v" },
    aspect_ratio: getFlag("ar") ?? "9:16",
    resolution: getFlag("res") ?? "1080p",
  };
  if (audioPath) {
    body.audio_asset_id = await uploadAsset(audioPath);
  } else {
    body.script = script;
    body.voice_id = voiceId;
  }
  const motionPrompt = getFlag("motion-prompt");
  if (motionPrompt) body.motion_prompt = motionPrompt;

  const res = await heygen("/v3/videos", { method: "POST", body: JSON.stringify(body) });
  const videoId = res?.data?.video_id;
  if (!videoId) fail(`Risposta senza video_id: ${JSON.stringify(res)}`);
  console.log(`🎥 Video in coda: ${videoId} — polling ogni 30s...`);

  for (;;) {
    await sleep(30_000);
    const v = await heygen(`/v3/videos/${videoId}`);
    const d = v?.data ?? v;
    console.log(`   status: ${d.status}`);
    if (d.status === "completed") {
      const outDir = getFlag("out") ?? join(OUTPUT_BASE, "heygen-tests");
      await ensureDir(outDir);
      const outPath = join(outDir, `${videoId}.mp4`);
      const dl = await fetch(d.video_url);
      if (!dl.ok) fail(`Download fallito: HTTP ${dl.status}`);
      await writeFile(outPath, Buffer.from(await dl.arrayBuffer()));
      console.log(`\n✅ Fatto (${d.duration ?? "?"}s, costo ~$${((d.duration ?? estSec) * COST_PER_SECOND).toFixed(2)})`);
      console.log(`open "${outPath}"`);
      return;
    }
    if (d.status === "failed") {
      fail(`Generazione fallita: ${d.failure_code} — ${d.failure_message}`);
    }
  }
}

// ---------- main ----------

async function main() {
  if (!apiKey) {
    fail(
      `HEYGEN_API_KEY mancante. Creala su app.heygen.com (Settings → API) con saldo ` +
        `pay-as-you-go (min $5), poi aggiungila a reel-engine/.env e a env.sh condiviso.`,
    );
  }
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "create-avatar":
      if (!arg) fail("Usage: pnpm test:heygen create-avatar <footage.mp4> [--name=...]");
      return createAvatar(arg);
    case "status":
      if (!arg) fail("Usage: pnpm test:heygen status <avatar_id>");
      return pollAvatar(arg);
    case "create-look":
      if (!arg) fail('Usage: pnpm test:heygen create-look <avatar_group_id> --prompt="..." [--name=...] [--ref=<img>]');
      return createLook(arg);
    case "look-status":
      if (!arg) fail("Usage: pnpm test:heygen look-status <look_id>");
      return pollLook(arg);
    case "consent":
      if (!arg) fail("Usage: pnpm test:heygen consent <avatar_group_id>");
      return consent(arg);
    case "generate":
      if (!arg) fail("Usage: pnpm test:heygen generate <avatar_id> --audio=<vo.mp3> | --script=... --voice-id=...");
      return generate(arg);
    default:
      fail(`Subcommand sconosciuto "${cmd ?? ""}". Vedi header del file per usage.`);
  }
}

main();
