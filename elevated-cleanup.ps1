# Kill the rogue elevated tool-wasabi worker(s) so the watchdog respawns a
# fresh one running the current (Anthropic-by-default) code. Leaves the
# OpenClaw gateway processes untouched.
$log = "C:\Users\Neo\tool-wasabi\elevated-cleanup.log"
"==== KILL WORKERS $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====" | Set-Content $log

$all = Get-CimInstance Win32_Process -Filter "name='node.exe'"
"--- all node.exe ---" | Add-Content $log
foreach ($p in $all) { "PID $($p.ProcessId) | $($p.CommandLine)" | Add-Content $log }

$workers = $all | Where-Object {
    $_.CommandLine -like "*openclaw-worker.js*" -or $_.CommandLine -like "*eternal-worker.js*"
}
"--- killing $($workers.Count) worker(s) ---" | Add-Content $log
foreach ($w in $workers) {
    try { Stop-Process -Id $w.ProcessId -Force -ErrorAction Stop; "KILLED $($w.ProcessId)" | Add-Content $log }
    catch { "FAILED $($w.ProcessId): $($_.Exception.Message)" | Add-Content $log }
}
"==== DONE ====" | Add-Content $log
