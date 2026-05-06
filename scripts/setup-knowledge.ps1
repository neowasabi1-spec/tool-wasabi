# Setup Knowledge Base (Copywriting)
# ----------------------------------
# Copia i file della KB di copywriting da C:\Users\Neo\Downloads
# alla cartella src/knowledge/copywriting/raw/ del repo.
#
# Esegui UNA VOLTA dopo aver scaricato i file:
#   pwsh ./scripts/setup-knowledge.ps1
#
# I file sono attesi in C:\Users\Neo\Downloads (puoi cambiare $SourceDir sotto).

$ErrorActionPreference = "Stop"

$SourceDir = "C:\Users\Neo\Downloads"
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$DestDir   = Join-Path $RepoRoot "src\knowledge\copywriting\raw"

# Mappa: nome file in Downloads -> nome canonico nel repo
$FileMap = @{
    "Tony-Flores-Million-Dollar-Mechanisms.txt" = "tony-flores-mechanisms.md"
    "16-Word-Sales-Letter-Evaldo.txt"           = "evaldo-16-word.md"
    "COS-Engine.txt"                            = "cos-engine.md"
    "Anghelache-Crash-Course-KNOWLEDGE.txt"     = "anghelache-crash-course.md"
    "Savage-Advertising-System.txt"             = "savage-system.md"
    "108-Split-Test-Winners.txt"                = "108-split-tests.md"
    "Swipe-Mastery-Course.txt"                  = "swipe-mastery-full-book.md"
    "RMBC-Copywriting-All-Docs.txt"             = "rmbc-full-course.md"
}

if (-not (Test-Path $DestDir)) {
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
    Write-Host "Created: $DestDir" -ForegroundColor Green
}

$copied = 0
$missing = @()

foreach ($entry in $FileMap.GetEnumerator()) {
    $src = Join-Path $SourceDir $entry.Key
    $dst = Join-Path $DestDir  $entry.Value

    if (Test-Path $src) {
        Copy-Item -Path $src -Destination $dst -Force
        $size = [math]::Round((Get-Item $dst).Length / 1KB, 1)
        Write-Host ("  OK  {0,-40} -> {1,-35} ({2} KB)" -f $entry.Key, $entry.Value, $size) -ForegroundColor Cyan
        $copied++
    } else {
        $missing += $entry.Key
        Write-Host ("  MISS {0,-40} (skip)" -f $entry.Key) -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host ("Done. Copied {0}/{1} files into {2}" -f $copied, $FileMap.Count, $DestDir) -ForegroundColor Green
if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "Missing files (will be skipped at runtime, no error):" -ForegroundColor Yellow
    $missing | ForEach-Object { Write-Host "  - $_" }
}
