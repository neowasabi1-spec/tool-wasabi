$env:REWRITE_QUALITY_MODE = "high"
Write-Host "Starting OpenClaw Worker with HIGH QUALITY MODE"
Write-Host "REWRITE_QUALITY_MODE = $env:REWRITE_QUALITY_MODE"
node openclaw-worker.js