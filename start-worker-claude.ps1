# ============================================================================
#  WORKER "SEMPRE CLAUDE"
#  ---------------------------------------------------------------------------
#  Un SOLO worker su questa macchina, backend Anthropic (Claude), che raccoglie
#  sia i job selezionati come "Neo" sia quelli "Morfeo" nell'interfaccia.
#  L'utente continua a scegliere Neo o Morfeo nella UI, ma a RISCRIVERE e'
#  sempre Claude — in modo trasparente.
#
#  Requisiti:
#    - Una API key Anthropic valida (sk-ant-...). Impostala una volta a livello
#      di sistema con:   setx ANTHROPIC_API_KEY "sk-ant-..."
#      e riapri il terminale; oppure incollala qui sotto.
# ============================================================================

# 1) API KEY ANTHROPIC ------------------------------------------------------
if (-not $env:ANTHROPIC_API_KEY) {
    # >>> INCOLLA QUI LA TUA CHIAVE se non l'hai gia' impostata con setx <<<
    $env:ANTHROPIC_API_KEY = "sk-ant-INSERISCI-LA-TUA-CHIAVE"
}

if ($env:ANTHROPIC_API_KEY -eq "sk-ant-INSERISCI-LA-TUA-CHIAVE" -or [string]::IsNullOrWhiteSpace($env:ANTHROPIC_API_KEY)) {
    Write-Host "[X] ANTHROPIC_API_KEY non impostata!" -ForegroundColor Red
    Write-Host "    Imposta la chiave con:  setx ANTHROPIC_API_KEY ""sk-ant-...""  (poi riapri il terminale)" -ForegroundColor Yellow
    Write-Host "    oppure incollala dentro questo script alla riga indicata." -ForegroundColor Yellow
    exit 1
}

# 2) CONFIG WORKER ----------------------------------------------------------
$env:OPENCLAW_BACKEND      = "anthropic"                       # usa Claude (non il modello locale)
$env:OPENCLAW_MODEL        = "claude-opus-4-8"                 # Claude Opus 4.8 (slug API ufficiale)
                                                              #   alternativa piu' economica: "claude-sonnet-4-6"
$env:OPENCLAW_MAX_TOKENS   = "32000"                           # output ampio (Opus 4.8 regge fino a 128k):
                                                              #   batch piu' grandi = meno chiamate su 1000 testi
$env:OPENCLAW_CLAIM_AGENTS = "openclaw:neo,openclaw:morfeo"    # raccoglie ENTRAMBE le selezioni
$env:REWRITE_QUALITY_MODE  = "high"                            # batch piu' piccoli = piu' copertura/robustezza

# 3) KILL VECCHI WORKER -----------------------------------------------------
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
    Where-Object { $_.CommandLine -like "*worker*.js*" } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
        Write-Host "Killed old worker PID: $($_.ProcessId)"
    }

# 4) AVVIO ------------------------------------------------------------------
Write-Host "`n[OK] WORKER SEMPRE-CLAUDE" -ForegroundColor Green
Write-Host "  Backend       : $env:OPENCLAW_BACKEND"
Write-Host "  Modello       : $env:OPENCLAW_MODEL"
Write-Host "  Max output    : $env:OPENCLAW_MAX_TOKENS token"
Write-Host "  Raccoglie     : $env:OPENCLAW_CLAIM_AGENTS  (Neo + Morfeo -> stesso motore Claude)"
Write-Host "  Quality mode  : $env:REWRITE_QUALITY_MODE"
Write-Host "  API key       : $($env:ANTHROPIC_API_KEY.Substring(0,8))... ($($env:ANTHROPIC_API_KEY.Length) char)`n"

node eternal-worker.js
