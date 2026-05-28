# PERSISTENT WORKER LAUNCHER
# Rilancia automaticamente il worker se crasha

Write-Host "🔥 PERSISTENT WORKER MANAGER" -ForegroundColor Green
Write-Host "Auto-restart ogni crash/timeout" -ForegroundColor Yellow

$env:REWRITE_QUALITY_MODE = "standard"
$env:MAX_TOKENS = "4096"

while ($true) {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Starting worker..." -ForegroundColor Cyan
    
    # Avvia il worker
    $worker = Start-Process -FilePath "node" -ArgumentList "openclaw-worker.js" -WorkingDirectory $PWD -PassThru -WindowStyle Hidden
    
    Write-Host "Worker started with PID: $($worker.Id)" -ForegroundColor Green
    
    # Aspetta che il worker termini (crash o timeout)
    $worker.WaitForExit()
    
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Worker crashed/stopped. Exit code: $($worker.ExitCode)" -ForegroundColor Red
    Write-Host "Restarting in 5 seconds..." -ForegroundColor Yellow
    
    Start-Sleep -Seconds 5
}