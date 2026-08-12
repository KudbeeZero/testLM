#requires -Version 5.1
<#
.SYNOPSIS
    OS Agent - Maintenance module. Gathers system health, applies safe
    optimizations, and records results into the persistent learning memory.

.DESCRIPTION
    This is part of the "engineering OS Agent" system. It:
      1. Collects system health (memory, disk, temp, startup, top processes).
      2. Applies safe, reversible optimizations (temp cleanup, etc.).
      3. Updates agent/memory/learnings.json with health + optimization records.

    Run it directly, or via os-agent.ps1 which also triggers the learning step.
#>
[CmdletBinding()]
param(
    # If set, only gather health data without applying optimizations.
    [switch]$ReportOnly
)

$ErrorActionPreference = "Stop"

# Paths
$root     = Split-Path -Parent $PSScriptRoot
$memDir   = Join-Path $PSScriptRoot "memory"
$memFile  = Join-Path $memDir "learnings.json"
$logDir   = Join-Path $PSScriptRoot "logs"
$logFile  = Join-Path $logDir ("maintain-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
if (-not (Test-Path $memFile)) {
    New-Item -ItemType Directory -Path $memDir -Force | Out-Null
    Set-Content -LiteralPath $memFile -Value '{"system":{},"health":{},"optimizations":[],"learnings":[]}' -Encoding UTF8
}

function Write-Log { param([string]$Msg) $line = "$(Get-Date -Format o)  $Msg"; Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8; Write-Host $line }

Write-Log "=== OS Agent maintenance run ==="

# --- Gather system health -------------------------------------------------
$os     = Get-CimInstance Win32_OperatingSystem
$cs     = Get-CimInstance Win32_ComputerSystem
$total  = $os.TotalVisibleMemorySize / 1MB
$free   = $os.FreePhysicalMemory / 1MB
$usedPct = [math]::Round((($total - $free) / $total) * 100, 0)

$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name })
$tempMB = [math]::Round((Get-ChildItem $env:TEMP -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 0)

$disk = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object {
    [pscustomobject]@{ Drive = $_.Name; FreeGB = [math]::Round($_.Free / 1GB, 1) }
}

$topProcs = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 |
    ForEach-Object { "{0} ({1} MB)" -f $_.Name, [math]::Round($_.WorkingSet64 / 1MB, 0) })

Write-Log ("Host: {0} | RAM: {1:N1} GB total, {2}% used | GPU: {3}" -f $cs.Name, $total, $usedPct, ($gpus -join ", "))
Write-Log ("Disk free: " + (($disk | ForEach-Object { "$($_.Drive): $($_.FreeGB) GB" }) -join ", "))
Write-Log ("Temp: {0} MB | Top procs: {1}" -f $tempMB, ($topProcs -join ", "))

# --- Apply safe optimizations ---------------------------------------------
$optimizations = @()
if (-not $ReportOnly -and $tempMB -gt 100) {
    $before = $tempMB
    Get-ChildItem $env:TEMP -Recurse -Force -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    $after = [math]::Round((Get-ChildItem $env:TEMP -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 0)
    $freed = $before - $after
    if ($freed -gt 0) {
        $optimizations += [pscustomobject]@{
            date   = (Get-Date -Format o)
            action = "temp-cleanup"
            detail = "Cleaned user temp folder"
            freed_mb = $freed
            impact = "Freed $freed MB of disk space"
        }
        Write-Log ("Optimization: temp cleanup freed {0} MB" -f $freed)
    }
}

# --- Update learning memory ------------------------------------------------
$mem = Get-Content -LiteralPath $memFile -Raw | ConvertFrom-Json

$mem.system.hostname   = $cs.Name
$mem.system.ram_gb     = [math]::Round($total, 1)
$mem.system.gpu        = @($gpus)
$mem.system.local_model = "qwen/qwen3-8b"
$mem.system.server      = "http://localhost:1234/v1"

$mem.health.last_check          = (Get-Date -Format o)
$mem.health.last_memory_used_pct = $usedPct
$mem.health.last_disk_free_gb   = [math]::Round(($disk | Measure-Object FreeGB -Sum).Sum, 1)
$mem.health.last_temp_mb        = $tempMB

foreach ($opt in $optimizations) {
    $mem.optimizations += $opt
}

# If memory usage is critically high, record a guarded learning recommendation
if ($usedPct -ge 85) {
    $warning = [pscustomobject]@{
        date = (Get-Date -Format o)
        topic = "memory"
        insight = "Critical memory usage detected ($usedPct% used)."
        recommendation = "Close or reduce memory-heavy applications (e.g. model servers) or upgrade RAM. Run maintenance with -ReportOnly first to inspect processes."
    }
    $mem.learnings += $warning
    Write-Log ("WARNING: {0}" -f $warning.insight)
}

# Write JSON without a UTF-8 BOM so it is valid for JSON parsers (Node, etc.).
$json = $mem | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($memFile, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Log "Learning memory updated: agent/memory/learnings.json"

# --- Output summary --------------------------------------------------------
Write-Host ""
Write-Host "Health summary:" -ForegroundColor Cyan
Write-Host ("  RAM: {0}% used" -f $usedPct)
Write-Host ("  Disk free: " + (($disk | ForEach-Object { "$($_.Drive): $($_.FreeGB) GB" }) -join ", "))
Write-Host ("  Temp: {0} MB" -f $tempMB)
if ($optimizations.Count -gt 0) {
    Write-Host "Optimizations applied:" -ForegroundColor Green
    foreach ($o in $optimizations) { Write-Host ("  - {0}: {1}" -f $o.action, $o.impact) }
} else {
    Write-Host "No optimizations needed this run." -ForegroundColor DarkGray
}
