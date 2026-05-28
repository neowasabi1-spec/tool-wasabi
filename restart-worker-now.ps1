# restart-worker-now.ps1
#
# Riavvia il worker openclaw caricando il codice AGGIORNATO dal disco.
# Necessario quando hai modificato worker-lib/* o openclaw-worker.js e
# il worker corrente (in RAM) sta ancora usando la vecchia versione.
#
# Si auto-eleva tramite UAC se non lanciato come admin (perche' i worker
# spesso girano in contesto elevated e Stop-Process da utente normale
# fallisce con "Accesso negato").
#
# USO: doppio-click sul file, oppure `.\restart-worker-now.ps1` in PS.

$ErrorActionPreference = 'Stop'

# Auto-elevation UAC
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole] 'Administrator')) {
    Write-Host "Richiedo privilegi admin via UAC..." -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoExit -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$workerDir = Split-Path -Parent $PSCommandPath
Set-Location $workerDir

Write-Host ""
Write-Host "=== RESTART WORKER ===" -ForegroundColor Cyan
Write-Host "CWD: $workerDir"
Write-Host ""

Write-Host "[1/3] Killing vecchi worker openclaw..." -ForegroundColor Yellow
$killedAny = $false
Get-CimInstance Win32_Process -Filter "name='node.exe'" | ForEach-Object {
    $cmd = $_.CommandLine
    # Adesso che siamo admin possiamo leggere il CommandLine anche dei processi elevated
    if ($cmd -and ($cmd -like "*openclaw-worker*" -or $cmd -like "*eternal-worker*")) {
        Write-Host "  - kill PID $($_.ProcessId): $($cmd.Substring(0, [Math]::Min(80, $cmd.Length)))..."
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        $killedAny = $true
    }
}
if (-not $killedAny) {
    Write-Host "  (nessun worker openclaw trovato - primo avvio?)"
}
Start-Sleep -Seconds 1

Write-Host ""
Write-Host "[2/3] Verifica build-prompts.js abbia il fix tag:div..." -ForegroundColor Yellow
$hasFix = (Get-Content "$workerDir\worker-lib\build-prompts.js" -Raw) -match "'tag:div'"
if ($hasFix) {
    Write-Host "  OK: fix tag:div presente in worker-lib/build-prompts.js" -ForegroundColor Green
} else {
    Write-Host "  WARNING: fix tag:div NON trovato. Fai 'git pull' prima!" -ForegroundColor Red
}

Write-Host ""
Write-Host "[3/3] Avvio worker (eternal mode)..." -ForegroundColor Yellow
Write-Host "Tieni questa finestra aperta. Per fermare il worker: Ctrl+C oppure chiudi la finestra."
Write-Host ""
node eternal-worker.js
