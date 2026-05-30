foreach ($id in 16120,16204) {
  Write-Output "=== PID $id connessioni ==="
  $lines = netstat -ano | Select-String ("\s$id$")
  if ($lines) {
    $lines | ForEach-Object { Write-Output ($_.ToString().Trim()) }
  } else {
    Write-Output "  (nessuna connessione di rete attiva)"
  }
  Write-Output ""
}
