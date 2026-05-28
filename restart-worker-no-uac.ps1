# restart-worker-no-uac.ps1
#
# Variante di restart-worker-now.ps1 SENZA auto-elevation UAC.
# Killa solo i worker openclaw/eternal che girano sotto l'utente corrente.
# Se trovi processi che non riesci a uccidere ("Accesso negato"), torna a
# usare restart-worker-now.ps1 e dai OK al popup UAC.
#
# USO: doppio-click sul file, oppure `.\restart-worker-no-uac.ps1` in PS.

$ErrorActionPreference = 'Stop'

$workerDir = Split-Path -Parent $PSCommandPath
Set-Location $workerDir

Write-Host ""
Write-Host "=== RESTART WORKER (no UAC) ===" -ForegroundColor Cyan
Write-Host "CWD: $workerDir"
Write-Host ""

Write-Host "[1/3] Killing vecchi worker openclaw/eternal..." -ForegroundColor Yellow
$killedAny = $false
$failed = $false
Get-CimInstance Win32_Process -Filter "name='node.exe'" | ForEach-Object {
    $cmd = $_.CommandLine
    if ($cmd -and ($cmd -like "*openclaw-worker*" -or $cmd -like "*eternal-worker*")) {
        $preview = $cmd.Substring(0, [Math]::Min(80, $cmd.Length))
        Write-Host "  - kill PID $($_.ProcessId): $preview..."
        try {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
            $killedAny = $true
        } catch {
            Write-Host "    [ERRORE] $($_.Exception.Message)" -ForegroundColor Red
            $failed = $true
        }
    }
}
if (-not $killedAny -and -not $failed) {
    Write-Host "  (nessun worker openclaw/eternal trovato - primo avvio?)"
}
if ($failed) {
    Write-Host ""
    Write-Host "ATTENZIONE: alcuni processi non sono stati killati (Accesso negato)." -ForegroundColor Red
    Write-Host "Usa restart-worker-now.ps1 e accetta il popup UAC." -ForegroundColor Red
    Write-Host ""
    Read-Host "Premi INVIO per uscire"
    exit 1
}
Start-Sleep -Seconds 1

Write-Host ""
Write-Host "[2/3] Sanity check su worker-lib/build-prompts.js..." -ForegroundColor Yellow
$buildPromptsPath = Join-Path $workerDir "worker-lib\build-prompts.js"
if (Test-Path $buildPromptsPath) {
    $hasFix = (Get-Content $buildPromptsPath -Raw) -match "'tag:div'"
    if ($hasFix) {
        Write-Host "  OK: fix tag:div presente" -ForegroundColor Green
    } else {
        Write-Host "  WARNING: fix tag:div NON trovato. Fai 'git pull' prima!" -ForegroundColor Red
    }
} else {
    Write-Host "  SKIP: build-prompts.js non trovato" -ForegroundColor DarkYellow
}

Write-Host ""
Write-Host "[3/3] Avvio worker (eternal mode)..." -ForegroundColor Yellow
Write-Host "Tieni questa finestra aperta. Per fermare: Ctrl+C o chiudi la finestra."
Write-Host ""
node eternal-worker.js
