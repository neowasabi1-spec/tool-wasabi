# PERSISTENT WORKER LAUNCHER
Write-Host "PERSISTENT WORKER MANAGER" -ForegroundColor Green

$env:REWRITE_QUALITY_MODE = "standard"
$env:MAX_TOKENS = "4096"

while ($true) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting worker..." -ForegroundColor Cyan
    
    $worker = Start-Process -FilePath "node" -ArgumentList "openclaw-worker.js" -WorkingDirectory $PWD -PassThru -WindowStyle Hidden
    
    Write-Host "Worker started with PID: $($worker.Id)" -ForegroundColor Green
    
    $worker.WaitForExit()
    
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Worker stopped. Exit code: $($worker.ExitCode)" -ForegroundColor Red
    Write-Host "Restarting in 5 seconds..." -ForegroundColor Yellow
    
    Start-Sleep -Seconds 5
}