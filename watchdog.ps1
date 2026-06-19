# Worker Watchdog - Runs via Windows Task Scheduler (RunLevel Highest).
# Ensures ONE correctly-configured openclaw worker is running on this PC (Neo).
# Backend = Anthropic (Claude), so it does NOT need a local LLM.

$workerPath = "C:\Users\Neo\tool-wasabi"
$logFile    = "C:\Users\Neo\tool-wasabi\watchdog.log"

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts $msg" | Add-Content $logFile
}

# Already running? (match the real tool-wasabi worker file)
$worker = Get-CimInstance Win32_Process -Filter "name='node.exe'" |
    Where-Object { $_.CommandLine -like "*openclaw-worker.js*" } |
    Select-Object -First 1

if ($worker) {
    Log "Worker OK - PID $($worker.ProcessId)"
    return
}

Log "Worker NOT found - starting (backend=anthropic agent=openclaw:neo)..."

# Correct config for THIS machine (Neo). Anthropic backend = no local LLM,
# so we never hit the 'OpenClaw HTTP 404' local-server error.
$env:OPENCLAW_BACKEND     = "anthropic"
$env:OPENCLAW_MODEL       = "claude-opus-4-8"
$env:OPENCLAW_MAX_TOKENS  = "32000"
$env:OPENCLAW_AGENT       = "openclaw:neo"   # claim ONLY neo (morfeo -> Mac)
$env:REWRITE_QUALITY_MODE = "high"
Remove-Item Env:\OPENCLAW_CLAIM_AGENTS -ErrorAction SilentlyContinue

# Explicitly load ANTHROPIC_API_KEY from the persistent User-scope registry.
# A scheduled task (especially RunLevel=Highest) does NOT always inherit the
# interactive shell's environment, so relying on inheritance let the worker
# start WITHOUT a key -> it fell back to the local LLM -> "OpenClaw HTTP 404"
# on every job. Reading it here guarantees the child worker always gets it.
if (-not $env:ANTHROPIC_API_KEY) {
    $env:ANTHROPIC_API_KEY = [Environment]::GetEnvironmentVariable("ANTHROPIC_API_KEY", "User")
}
if (-not $env:ANTHROPIC_API_KEY) {
    Log "WARNING: ANTHROPIC_API_KEY missing - worker will fail. Set it: setx ANTHROPIC_API_KEY sk-ant-..."
}

# Redirect worker stdout/stderr to a log so the startup banner (Backend: ...)
# is always inspectable, instead of vanishing into a hidden window.
$proc = Start-Process -FilePath "node" -ArgumentList "openclaw-worker.js" `
    -WorkingDirectory $workerPath -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput "$workerPath\openclaw-worker.log" `
    -RedirectStandardError  "$workerPath\openclaw-worker.err.log"
Log "Worker started - PID $($proc.Id) (backend=anthropic, model=claude-opus-4-8, agent=openclaw:neo)"
