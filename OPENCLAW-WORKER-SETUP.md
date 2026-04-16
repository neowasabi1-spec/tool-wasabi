# OpenClaw Worker — Setup as Windows Service

Run the worker permanently on the PC where OpenClaw is installed. It will start automatically at boot and restart if it crashes.

## 1. Install prerequisites (once, on the OpenClaw PC)

1. Install **Node.js LTS**: https://nodejs.org
2. Create a folder for the worker, e.g. `C:\openclaw-worker\`
3. Copy `openclaw-worker.js` from the repo into that folder
4. Open **PowerShell (as Admin)** in that folder and run:
   ```powershell
   npm init -y
   npm install @supabase/supabase-js
   ```
5. Test it once manually:
   ```powershell
   node openclaw-worker.js
   ```
   You should see the banner and `Worker started. Waiting for messages...`
   Press `Ctrl+C` to stop.

## 2. Install NSSM (service manager)

1. Download NSSM from https://nssm.cc/download (pick the latest release ZIP)
2. Extract the ZIP
3. Copy `nssm.exe` (from `win64/` subfolder) into `C:\openclaw-worker\` (or any folder on your PATH)

## 3. Register the worker as a service

Open **PowerShell (as Admin)** and run:

```powershell
cd C:\openclaw-worker
.\nssm.exe install OpenClawWorker
```

A graphical window opens. Fill in:

- **Application path**: `C:\Program Files\nodejs\node.exe`  (or wherever your node.exe lives — check with `where node`)
- **Startup directory**: `C:\openclaw-worker`
- **Arguments**: `openclaw-worker.js`

In the **Details** tab:
- **Display name**: `OpenClaw Worker`
- **Description**: `Polls Supabase and forwards messages to local OpenClaw`
- **Startup type**: `Automatic`

In the **I/O** tab (so you can see logs):
- **Output (stdout)**: `C:\openclaw-worker\worker.log`
- **Error (stderr)**: `C:\openclaw-worker\worker.err.log`

In the **Exit actions** tab:
- **On exit**: `Restart application`
- **Restart delay**: `5000` (5 seconds)

Click **Install service**.

## 4. Start the service

```powershell
.\nssm.exe start OpenClawWorker
```

Or from Windows → `services.msc` → find **OpenClaw Worker** → right-click → Start.

## 5. Verify it works

- Check the log:
  ```powershell
  Get-Content C:\openclaw-worker\worker.log -Wait -Tail 20
  ```
  You should see the banner and periodic `Worker started. Waiting for messages...`.

- From the Cloner Funnel Builder on Vercel, click "Clone & Rewrite" with **Use OpenClaw** checked. You should see the log update:
  ```
  [2026-04-16 17:55:12] Processing #abc-123: "Rewrite these 100 texts..."
  [2026-04-16 17:56:42] ✅ Completed #abc-123 in 90.1s (5230 chars, total processed: 1)
  ```

## Useful commands

```powershell
.\nssm.exe status OpenClawWorker    # current state
.\nssm.exe stop OpenClawWorker      # stop it
.\nssm.exe start OpenClawWorker     # start it
.\nssm.exe restart OpenClawWorker   # restart it
.\nssm.exe remove OpenClawWorker    # uninstall the service
```

## Override config via environment variables (optional)

If your OpenClaw runs on a different port/host or you want to point the worker to a staging Supabase, set environment variables in NSSM's **Environment** tab (one per line):

```
OPENCLAW_HOST=127.0.0.1
OPENCLAW_PORT=19001
OPENCLAW_API_KEY=your-key
OPENCLAW_MODEL=openclaw:neo
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=xxx
```

Without env vars the worker falls back to the hardcoded defaults (which already match your current setup).
