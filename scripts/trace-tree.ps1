Write-Output "=== Tutti i node.exe ==="
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
foreach ($p in $procs) {
  Write-Output ("PID=$($p.ProcessId)  Parent=$($p.ParentProcessId)  Start=$($p.CreationDate)")
}
Write-Output ""
Write-Output "=== Catena di 12036 (motore su 18789) ==="
$cur = 12036
for ($i=0; $i -lt 8; $i++) {
  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=$cur") -ErrorAction SilentlyContinue
  if (-not $p) { Write-Output ("PID=$cur (non attivo)"); break }
  Write-Output ("PID=$($p.ProcessId)  Name=$($p.Name)  Parent=$($p.ParentProcessId)")
  $cur = $p.ParentProcessId
  if ($cur -le 4) { break }
}
