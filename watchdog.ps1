# Worker Watchdog - Runs via Windows Task Scheduler
# No Claude/OpenClaw involvement

$workerPath = "C:\Users\Neo\Cloner-Funnel-Builder"
$logFile = "C:\Users\Neo\tool-wasabi\watchdog.log"

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts $msg" | Add-Content $logFile
}

# Check if worker is running
$worker = Get-Process | Where-Object {$_.Name -eq "node"} | ForEach-Object {
    $id = $_.Id
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$id").CommandLine
    if ($cmd -like "*openclaw-worker*") { $_ }
}

if ($worker) {
    Log "Worker OK - PID $($worker.Id)"
} else {
    Log "Worker NOT found - Starting..."
    $proc = Start-Process -FilePath "node" -ArgumentList "openclaw-worker.js" -WorkingDirectory $workerPath -WindowStyle Hidden -PassThru
    Log "Worker started - PID $($proc.Id)"
}
