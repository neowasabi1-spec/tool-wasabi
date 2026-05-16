# Configurazione più stabile per evitare crash
$env:REWRITE_QUALITY_MODE = "standard"
$env:MAX_TOKENS = "4096"
Write-Host "Starting OpenClaw Worker with STABLE CONFIG"
Write-Host "REWRITE_QUALITY_MODE = $env:REWRITE_QUALITY_MODE"
Write-Host "MAX_TOKENS = $env:MAX_TOKENS"
node openclaw-worker.js