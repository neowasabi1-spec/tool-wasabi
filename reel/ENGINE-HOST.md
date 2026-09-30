# Reel Engine — Claude Cloud host (ops)

Mediabuyers create videos **only from Wasabi UI**. They never install MCP or open Claude.

This host runs:

1. `pnpm engine:http` — HTTP API Wasabi calls (`REEL_ENGINE_URL`)
2. `pnpm engine:worker` — imports footage, drives Claude, publishes to Created videos
3. Claude Code **with Cloud** + local MCP `wasabi-reel` (for Claude on *this* machine only)

## Disk layout

```
<REEL_OUTPUT_BASE>/
  <mediaBuyer>/                 ← slug from Wasabi user email/id
    <projectId>/
      footage/cleaned/
      footage/full-cleaned/
      ai-clips/
      YYYY-MM-DD/<slug>/        ← final.mp4 + script artifacts
      _engine/<jobId>.prompt.md
  _jobs/<jobId>.json
```

## One-time setup

```bash
cd tool-wasabi
./scripts/setup-reel-engine-host.sh
# edit reel/.env — FAL, ElevenLabs, Google, Supabase, REEL_ENGINE_SECRET
```

Claude MCP on **this host only** (not for mediabuyers):

```bash
cd tool-wasabi/reel
claude mcp add wasabi-reel -- pnpm exec tsx mcp/server.ts
```

## Run (keep alive while Cloud is on)

```bash
cd tool-wasabi/reel
# terminal A
pnpm engine:http
# terminal B
pnpm engine:worker
```

Or under systemd / pm2. Expose port `8787` (or your `REEL_ENGINE_PORT`) to Netlify via VPN / Cloudflare Tunnel / Tailscale.

## Netlify (Wasabi) env

| Var | Value |
|---|---|
| `REEL_ENGINE_URL` | `https://your-tunnel.example` (no trailing slash) |
| `REEL_ENGINE_SECRET` | same as `reel/.env` |

After both are set, Shots → **Create video on engine** works. Without them the UI shows “Engine not connected”.

## Job flow

1. Mediabuyer clicks **Create video on engine** (+ optional brief)
2. Wasabi `POST …/reel/jobs` → engine `POST /jobs`
3. Worker: import → Claude (auto or prompt file) → wait `final.mp4` → `publishReelToWasabi`
4. Video appears in **Created videos**

`REEL_AUTO_CLAUDE=0` → worker only writes `_engine/<job>.prompt.md`; you paste/run it in the Cloud session. `=1` (default) shells out to `claude -p …`.
