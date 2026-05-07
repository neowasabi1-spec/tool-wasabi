# Import additional copywriting knowledge base files
# Cleans Circle/Skool navigation chrome and copies into src/knowledge/copywriting/raw/
# Run from repo root: pwsh scripts/import-new-kb-2026-05-07.ps1

param(
    [string]$DownloadsDir = "$env:USERPROFILE\Downloads",
    [string]$DestDir      = "src/knowledge/copywriting/raw"
)

function Strip-CircleNav {
    param([string]$Content)

    # Strategy: Circle/Skool exports have a giant nav-menu blob at the top
    # (Feed/GENESIS/Onboarding/...). The actual content starts AFTER one of
    # these markers (in priority order). If none match, return content as-is.
    $markers = @(
        '\nPowered by Circle\s*\n',
        '\nBack to .*?\n',
        '\n## Content\s*\n',
        '\n```\s*\n',
        '\nWrite something\s*\n'
    )

    foreach ($marker in $markers) {
        $m = [regex]::Match($Content, $marker)
        if ($m.Success -and $m.Index -lt $Content.Length / 2) {
            # Cut everything before & including the marker
            $start = $m.Index + $m.Length
            $rest  = $Content.Substring($start)
            # Some files repeat the nav menu later; collapse second occurrence.
            $rest = [regex]::Replace($rest, '(?ms)Powered by Circle.{0,4000}?Skool', '')
            return $rest.Trim()
        }
    }
    return $Content.Trim()
}

function Strip-SkoolBoilerplate {
    param([string]$Content)
    # Remove repeated "My Offers: ..." spam blocks that show up after every post
    $patterns = @(
        '(?ms)My Offers:.*?currently spending \$2M/month\.',
        '(?ms)Ecom Mastery AI[\s\S]{0,400}?\$2M/month\.'
    )
    foreach ($p in $patterns) {
        $Content = [regex]::Replace($Content, $p, '[CTA elided]')
    }
    return $Content
}

function Compact-Whitespace {
    param([string]$Content)
    # Collapse 3+ blank lines into 2 (saves ~5-10% tokens)
    $Content = [regex]::Replace($Content, '\r\n', "`n")
    $Content = [regex]::Replace($Content, '\n{3,}', "`n`n")
    return $Content
}

# Map: source file -> destination file -> cleaning level
$jobs = @(
    @{ src = '27-Copy-Codes-Headlines.txt';      dst = 'cc-27-headlines.md';                clean = 'circle' },
    @{ src = 'Stefan-Georgi-L62.txt';            dst = 'sg-l62-income-psychographics.md';   clean = 'none'   },
    @{ src = 'Stefan-Georgi-L63.txt';            dst = 'sg-l63-big-ideas.md';               clean = 'none'   },
    @{ src = 'VSL-Masterclass-Community-Posts.txt'; dst = 'vsl-masterclass-community.md';   clean = 'skool'  },
    @{ src = 'Ad-Creatives-Academy-Posts.txt';   dst = 'ad-creatives-academy-posts.md';     clean = 'skool'  },
    @{ src = 'Ad-Creatives-Academy-Top-Posts.txt'; dst = 'ad-creatives-academy-top.md';     clean = 'skool'  },
    @{ src = 'Advanced-AI-Hooks.txt';            dst = 'advanced-ai-hooks-transcript.md';   clean = 'none'   },
    @{ src = 'Stefan-Georgi-RMBC-Complete.txt';  dst = 'sg-rmbc-complete.md';               clean = 'none'   }
)

$repoRoot = (Get-Location).Path
$dest = Join-Path $repoRoot $DestDir
if (-not (Test-Path $dest)) {
    New-Item -ItemType Directory -Path $dest | Out-Null
}

$totalIn  = 0
$totalOut = 0
$report   = @()

foreach ($j in $jobs) {
    $srcPath = Join-Path $DownloadsDir $j.src
    $dstPath = Join-Path $dest $j.dst

    if (-not (Test-Path $srcPath)) {
        Write-Warning "MISSING source: $srcPath - skipped"
        continue
    }

    $raw = Get-Content -Raw -Path $srcPath -Encoding UTF8
    $inLen = $raw.Length

    switch ($j.clean) {
        'circle' { $raw = Strip-CircleNav -Content $raw }
        'skool'  {
            $raw = Strip-CircleNav -Content $raw
            $raw = Strip-SkoolBoilerplate -Content $raw
        }
        default  { }
    }

    $raw = Compact-Whitespace -Content $raw

    # Wrap with a small header so the LLM understands provenance.
    $title = [System.IO.Path]::GetFileNameWithoutExtension($j.src)
    $header = @(
        "# $title",
        "",
        "_Imported from $($j.src) on $(Get-Date -Format 'yyyy-MM-dd'). Cleaned: $($j.clean)._",
        "",
        "---",
        ""
    ) -join "`n"

    $final = $header + $raw + "`n"
    Set-Content -Path $dstPath -Value $final -Encoding UTF8 -NoNewline

    $outLen = $final.Length
    $approxTokens = [math]::Round($outLen / 4, 0)
    $totalIn  += $inLen
    $totalOut += $outLen

    $report += [pscustomobject]@{
        Source       = $j.src
        Dest         = $j.dst
        InKB         = [math]::Round($inLen / 1024, 1)
        OutKB        = [math]::Round($outLen / 1024, 1)
        ApproxTokens = $approxTokens
    }
}

Write-Host "`n=== KB Import Report ===" -ForegroundColor Cyan
$report | Format-Table -AutoSize
$inKb     = [math]::Round($totalIn/1024,1)
$outKb    = [math]::Round($totalOut/1024,1)
$outToks  = [math]::Round($totalOut/4,0)
Write-Host ("Input total : " + $inKb + " KB") -ForegroundColor Yellow
Write-Host ("Output total: " + $outKb + " KB / approx " + $outToks + " tokens") -ForegroundColor Yellow
