#requires -Version 5.1
<#
.SYNOPSIS
    OS Agent - Learning module. Uses the local model (Qwen3-8B) to analyze the
    latest system health report and generate insights stored in the learning memory.

.DESCRIPTION
    Part of the "engineering OS Agent" system. Reads agent/memory/learnings.json,
    asks the local model to analyze the current health + optimization history, and
    appends new, non-duplicate learnings to the memory so the agent "always learns"
    about this specific machine over time.

    Requires the LM Studio server (http://localhost:1234/v1) with qwen/qwen3-8b.
#>
[CmdletBinding()]
param(
    # Model to use for learning.
    [string]$Model = "qwen/qwen3-8b",
    # Base URL of the OpenAI-compatible server.
    [string]$BaseUrl = "http://localhost:1234/v1"
)

$ErrorActionPreference = "Stop"

$memFile = Join-Path $PSScriptRoot "memory\learnings.json"
$logDir  = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir ("learn-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")

function Write-Log { param([string]$Msg) $line = "$(Get-Date -Format o)  $Msg"; Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8; Write-Host $line }

if (-not (Test-Path $memFile)) {
    Write-Warning "No learning memory found. Run maintain.ps1 first."
    exit 1
}

# --- Ensure the model is loaded -------------------------------------------
$lms = Join-Path $env:USERPROFILE ".lmstudio\bin\lms.exe"
try {
    $models = (Invoke-RestMethod -Uri "$BaseUrl/models" -Method Get -TimeoutSec 10).data
    if ($models.id -notcontains $Model) {
        Write-Host "Loading model $Model ..." -ForegroundColor DarkGray
        & $lms load $Model --ttl 600 -y 2>&1 | Out-Null
        Start-Sleep -Seconds 2
    }
} catch {
    Write-Host "Starting server..." -ForegroundColor DarkGray
    & $lms server start 2>&1 | Out-Null
    Start-Sleep -Seconds 3
    & $lms load $Model --ttl 600 -y 2>&1 | Out-Null
    Start-Sleep -Seconds 2
}

# --- Build the analysis prompt --------------------------------------------
$mem = Get-Content -LiteralPath $memFile -Raw | ConvertFrom-Json
$context = $mem | ConvertTo-Json -Depth 8

$prompt = @"
You are the learning engine for an engineering OS Agent on a local machine.
Analyze the following system memory (health, optimizations, and prior learnings)
and produce concrete learnings about how to keep THIS machine optimized.

System memory (JSON):
$context

Return a JSON array of 2 to 4 new learning objects. Each object must have:
- "topic": short topic (e.g. "memory", "disk", "startup", "temp", "gpu")
- "insight": a concrete, actionable insight specific to this machine's data
- "recommendation": a specific action to take or monitor

Base your learnings on the actual health numbers (e.g. high RAM %, disk free,
temp size, GPU). Do not repeat learnings that already exist. Do not return an
empty array unless the data is truly unremarkable.
Return ONLY the JSON array, no extra text.
/no_think
"@

$body = @{
    model       = $Model
    messages    = @(@{ role = "system"; content = "You are a concise JSON-producing analysis engine." }, @{ role = "user"; content = $prompt })
    temperature = 0.2
    max_tokens  = 800
} | ConvertTo-Json -Depth 6

$resp = Invoke-RestMethod -Uri "$BaseUrl/chat/completions" -Method Post `
    -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body))

$text = $resp.choices[0].message.content

# --- Extract JSON array from the response ---------------------------------
$json = $text
$start = $text.IndexOf("[")
$end = $text.LastIndexOf("]")
if ($start -ge 0 -and $end -gt $start) { $json = $text.Substring($start, $end - $start + 1) }

try {
    $newLearnings = @($json | ConvertFrom-Json)
} catch {
    Write-Warning "Could not parse model output as JSON. Raw output saved to log."
    Add-Content -LiteralPath $logFile -Value $text -Encoding UTF8
    exit 1
}

# --- Normalize and append only new learnings -----------------------------
# The model may return either one object per learning, or a single object whose
# fields are arrays (grouped). Expand array fields into individual learnings.
$existing = @($mem.learnings | ForEach-Object { $_.topic + "|" + $_.insight })
$added = 0

function Add-Learning {
    param($Topic, $Insight, $Recommendation)
    if ([string]::IsNullOrWhiteSpace($Topic) -or [string]::IsNullOrWhiteSpace($Insight)) { return }
    $key = $Topic + "|" + $Insight
    if ($existing -notcontains $key) {
        $script:mem.learnings += [pscustomobject]@{
            date           = (Get-Date -Format o)
            topic          = $Topic
            insight        = $Insight
            recommendation = $Recommendation
        }
        $script:existing += $key
        $script:added++
    }
}

foreach ($l in $newLearnings) {
    $topics = @($l.topic)
    $insights = @($l.insight)
    $recs = @($l.recommendation)
    $count = [Math]::Max($topics.Count, $insights.Count)
    for ($i = 0; $i -lt $count; $i++) {
        $t = if ($i -lt $topics.Count) { $topics[$i] } else { $topics[0] }
        $in = if ($i -lt $insights.Count) { $insights[$i] } else { $insights[0] }
        $r = if ($i -lt $recs.Count) { $recs[$i] } else { $null }
        Add-Learning -Topic $t -Insight $in -Recommendation $r
    }
}

$json = $mem | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($memFile, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Log "Learning complete: $added new learning(s) added."
Write-Host ""
Write-Host ("Added {0} new learning(s)." -f $added) -ForegroundColor Green
Write-Host ("Total learnings: {0}" -f $mem.learnings.Count) -ForegroundColor Cyan
