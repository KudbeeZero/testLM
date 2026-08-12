#requires -Version 5.1
<#
.SYNOPSIS
    OS Agent - Main orchestrator. Runs maintenance, then the learning step,
    so the machine stays optimized and the agent keeps learning.

.DESCRIPTION
    The "engineering OS Agent" system entry point. It:
      1. Runs agent/maintain.ps1  -> checks health, applies safe optimizations.
      2. Runs agent/learn.ps1     -> uses the local model to learn and update memory.

    Run periodically (e.g. via Task Scheduler) to keep the laptop optimized
    and the learning memory growing over time.

.EXAMPLE
    .\agent\os-agent.ps1
    .\agent\os-agent.ps1 -ReportOnly   # only check health, no changes
#>
[CmdletBinding()]
param(
    # Only gather health data; skip optimizations and learning.
    [switch]$ReportOnly,

    # Keep running locally and repeat the full cycle at this interval.
    [switch]$Background,

    [ValidateRange(60, 86400)]
    [int]$IntervalMinutes = 30
)

$ErrorActionPreference = "Stop"
$agentDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($agentDir)) { $agentDir = (Get-Location).Path }

function Invoke-AgentCycle {
    Write-Host "======================================" -ForegroundColor Cyan
    Write-Host "  Engineering OS Agent" -ForegroundColor Cyan
    Write-Host "======================================" -ForegroundColor Cyan

    # Step 1: Maintenance
    Write-Host ""
    Write-Host ">> Step 1: Maintenance" -ForegroundColor Yellow
    if ($ReportOnly) {
        & (Join-Path $agentDir "maintain.ps1") -ReportOnly
    } else {
        & (Join-Path $agentDir "maintain.ps1")
    }

    # Step 2: Learning (only if not report-only)
    if (-not $ReportOnly) {
        Write-Host ""
        Write-Host ">> Step 2: Learning" -ForegroundColor Yellow
        & (Join-Path $agentDir "learn.ps1")
    }

    Write-Host ""
    Write-Host "OS Agent run complete." -ForegroundColor Green
}

if ($Background) {
    Write-Host "Background mode enabled; running every $IntervalMinutes minute(s). Press Ctrl+C to stop." -ForegroundColor Green
    while ($true) {
        try {
            Invoke-AgentCycle
        } catch {
            Write-Error "Agent cycle failed: $($_.Exception.Message)"
        }
        Write-Host "Next cycle: $(Get-Date).AddMinutes($IntervalMinutes)" -ForegroundColor DarkGray
        Start-Sleep -Seconds ($IntervalMinutes * 60)
    }
}

Invoke-AgentCycle
