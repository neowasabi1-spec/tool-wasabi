Write-Host "🔄 Persistent Worker Manager started"
while ($true) {
    Write-Host "$(Get-Date -Format 'HH:mm:ss') - Starting worker..."
    $proc = Start-Process -FilePath "node" -ArgumentList "openclaw-worker.js" -WorkingDirectory "C:\Users\Neo\Cloner-Funnel-Builder" -PassThru -NoNewWindow
    Write-Host "$(Get-Date -Format 'HH:mm:ss') - Worker PID: $($proc.Id)"
    $proc.WaitForExit()
    Write-Host "$(Get-Date -Format 'HH:mm:ss') - Worker died (exit: $($proc.ExitCode)), restarting in 3s..."
    Start-Sleep 3
}
