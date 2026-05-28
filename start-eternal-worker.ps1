# ETERNAL WORKER LAUNCHER
# Worker che bypassa il timeout di 30 minuti

Write-Host "`n🔥 LAUNCHING ETERNAL WORKER" -ForegroundColor Green
Write-Host "This worker will NOT die after 30 minutes!`n" -ForegroundColor Yellow

# Set environment
$env:REWRITE_QUALITY_MODE = "standard"
$env:MAX_TOKENS = "4096"

# Kill vecchi worker
Get-CimInstance Win32_Process -Filter "name='node.exe'" | 
    Where-Object { $_.CommandLine -like "*worker*.js*" } | 
    ForEach-Object { 
        Stop-Process -Id $_.ProcessId -Force
        Write-Host "Killed old worker PID: $($_.ProcessId)"
    }

Write-Host "Starting eternal worker..."
node eternal-worker.js