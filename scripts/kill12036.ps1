try {
  Stop-Process -Id 12036 -Force -ErrorAction Stop
  Write-Output "KILLED 12036"
} catch {
  Write-Output ("FALLITO: " + $_.Exception.Message)
}
Start-Sleep -Seconds 2
Write-Output "--- stato porta 18789 ---"
$net = netstat -ano | Select-String ":18789"
if ($net) { $net } else { Write-Output "porta 18789 LIBERA (nessuno in ascolto)" }
