/**
 * HTTP façade for the Claude Cloud reel engine.
 * Wasabi (Netlify) calls this — mediabuyers never see MCP.
 *
 *   POST /jobs          { kind, mediaBuyer, projectId, brief?, … }
 *   GET  /jobs/:id
 *   GET  /jobs?projectId=&mediaBuyer=
 *   GET  /health
 *
 * Auth: Authorization: Bearer <REEL_ENGINE_SECRET>
 */

import dotenv from "dotenv";
import http from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createJob,
  listJobs,
  loadJob,
  type ReelJobKind,
} from "../src/wasabi/engine-jobs.js";
import { sanitizeBuyerSlug } from "../src/wasabi/paths.js";

const REEL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(REEL_ROOT, ".env"), override: false });

const PORT = Number(process.env.REEL_ENGINE_PORT || 8787);
const SECRET = (process.env.REEL_ENGINE_SECRET || "").trim();

function unauthorized(res: http.ServerResponse) {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function checkAuth(req: http.IncomingMessage): boolean {
  if (!SECRET) return true; // local/dev only
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const alt = String(req.headers["x-reel-engine-secret"] || "").trim();
  return token === SECRET || alt === SECRET;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!checkAuth(req)) return unauthorized(res);
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && path === "/health") {
      return json(res, 200, {
        ok: true,
        service: "wasabi-reel-engine",
        autoClaude: process.env.REEL_AUTO_CLAUDE !== "0",
      });
    }

    if (req.method === "GET" && path === "/jobs") {
      const jobs = listJobs({
        projectId: url.searchParams.get("projectId") || undefined,
        mediaBuyer: url.searchParams.get("mediaBuyer") || undefined,
        limit: Number(url.searchParams.get("limit") || 40),
      });
      return json(res, 200, { jobs });
    }

    const jobMatch = path.match(/^\/jobs\/([a-zA-Z0-9-]+)$/);
    if (req.method === "GET" && jobMatch) {
      const job = loadJob(jobMatch[1]);
      if (!job) return json(res, 404, { error: "Not found" });
      return json(res, 200, { job });
    }

    if (req.method === "POST" && path === "/jobs") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const kind = String(body.kind || "produce") as ReelJobKind;
      if (!["import", "produce", "publish"].includes(kind)) {
        return json(res, 400, { error: "kind must be import|produce|publish" });
      }
      const projectId = String(body.projectId || "").trim();
      const mediaBuyer = sanitizeBuyerSlug(String(body.mediaBuyer || "").trim());
      if (!projectId) return json(res, 400, { error: "projectId required" });
      if (!mediaBuyer) return json(res, 400, { error: "mediaBuyer required" });

      const job = createJob({
        kind,
        mediaBuyer,
        projectId,
        brandId: body.brandId != null ? Number(body.brandId) : undefined,
        brief: typeof body.brief === "string" ? body.brief : undefined,
        slug: typeof body.slug === "string" ? body.slug : undefined,
        includeFullAds: body.includeFullAds !== false,
        reelDir: typeof body.reelDir === "string" ? body.reelDir : undefined,
        name: typeof body.name === "string" ? body.name : undefined,
      });
      return json(res, 201, { job });
    }

    json(res, 404, { error: "Not found" });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[reel-engine-http] listening on :${PORT} (secret ${SECRET ? "set" : "OPEN — set REEL_ENGINE_SECRET"})`);
});
