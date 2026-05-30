$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
foreach ($p in $procs) {
  Write-Output "PID=$($p.ProcessId)  Parent=$($p.ParentProcessId)  Start=$($p.CreationDate)"
  Write-Output "  CMD: $($p.CommandLine)"
  Write-Output "----"
}
