foreach ($id in 15776,4496,16120,16204) {
  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=$id") -ErrorAction SilentlyContinue
  if ($p) {
    Write-Output ("PID=$($p.ProcessId)  Name=$($p.Name)  Parent=$($p.ParentProcessId)  Start=$($p.CreationDate)")
    if ($p.CommandLine) { Write-Output ("    CMD: $($p.CommandLine)") }
  } else {
    Write-Output ("PID=$id  (non attivo)")
  }
}
