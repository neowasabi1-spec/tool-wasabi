# Backup e patch del timeout prima di avviare
$file = "openclaw-worker.js"
$backup = "openclaw-worker.js.bak"

# Crea backup se non esiste
if (-not (Test-Path $backup)) {
    Copy-Item $file $backup
}

# Patch del timeout (30 min → 2 ore)
$content = Get-Content $file -Raw
$patched = $content -replace "OPENCLAW_TIMEOUT_MS = 30 \* 60 \* 1000", "OPENCLAW_TIMEOUT_MS = 120 * 60 * 1000"
Set-Content $file $patched

Write-Host "✅ Timeout patchato a 2 ore"

# Avvia il worker
$env:REWRITE_QUALITY_MODE = "standard"
node openclaw-worker.js