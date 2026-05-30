Write-Output "=== Tutti i processi node.exe (ordinati per avvio) ==="
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Sort-Object CreationDate |
  ForEach-Object {
    Write-Output ("PID=$($_.ProcessId)  Parent=$($_.ParentProcessId)  Start=$($_.CreationDate)")
  }
Write-Output ""
Write-Output "=== Chi ascolta su 18789 ==="
netstat -ano | Select-String ":18789" | Select-Object -First 2
