#requires -Version 5.1
<#
.SYNOPSIS
    A lightweight local agent that runs against a local LLM server (e.g. LM Studio)
    using the OpenAI-compatible Chat Completions API with tool/function calling.

.DESCRIPTION
    The agent runs a loop:
      1. Send the conversation (system prompt + history) to the local model.
      2. If the model requests tool calls, execute them and feed results back.
      3. Repeat until the model produces a final answer, then print it.

    It only uses built-in PowerShell cmdlets, so no dependencies are required.

.EXAMPLE
    .\local-agent.ps1 -Prompt "What files are in this folder?"

.EXAMPLE
    .\local-agent.ps1 -Prompt "Read README.md and summarize it" -Model "qwen2.5-coder-7b-instruct"
#>
[CmdletBinding()]
param(
    # Base URL of the OpenAI-compatible API (LM Studio default).
    [string]$BaseUrl = "http://localhost:1234/v1",

    # Model id to use. If empty, the server's default model is used.
    [string]$Model = "qwen/qwen3-1.7b",

    # System prompt that defines the agent's behavior.
    [string]$SystemPrompt = @"
You are a helpful local coding agent running on the user's machine.
You can use the provided tools to inspect the filesystem and run commands.
Be concise, accurate, and honest. When you are unsure, say so.
"@,

    # The user's request. If empty, read from stdin (interactive mode).
    [string]$Prompt = "",

    # Watch the filesystem live and summarize work without needing the LLM.
    [switch]$Watch,

    # Directory to watch. Defaults to the current working directory.
    [string]$WatchPath = ".",

    # Log file to append live filesystem events to.
    [string]$WatchLogPath = "",

    # Maximum number of tool-call iterations before stopping.
    [int]$MaxIterations = 10,

    # Temperature for sampling.
    [double]$Temperature = 0.3,

    # Append "/no_think" to user messages to disable reasoning. Qwen3 models
    # reason by default, which is very slow on CPU. Turn this off for speed.
    [switch]$NoThink = $true,

    # Maximum tokens per model response (safety cap against runaway generation).
    [int]$MaxTokens = 2048
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Tool definitions (name -> schema) sent to the model.
# ---------------------------------------------------------------------------
$Tools = @(
    @{
        type = "function"
        function = @{
            name        = "list_directory"
            description = "List the files and subfolders in a directory."
            parameters  = @{
                type = "object"
                properties = @{
                    path = @{ type = "string"; description = "Directory path. Empty means current directory." }
                }
                required = @("path")
            }
        }
    },
    @{
        type = "function"
        function = @{
            name        = "read_file"
            description = "Read text from a file."
            parameters  = @{
                type = "object"
                properties = @{
                    path         = @{ type = "string"; description = "Path to the file." }
                    start_line   = @{ type = "integer"; description = "1-indexed first line to read (optional)." }
                    lines_to_read= @{ type = "integer"; description = "Maximum number of lines to read (optional)." }
                }
                required = @("path")
            }
        }
    },
    @{
        type = "function"
        function = @{
            name        = "write_file"
            description = "Write text content to a file (overwrites existing content)."
            parameters  = @{
                type = "object"
                properties = @{
                    path    = @{ type = "string"; description = "Path to the file." }
                    content = @{ type = "string"; description = "Full text content to write." }
                }
                required = @("path", "content")
            }
        }
    },
    @{
        type = "function"
        function = @{
            name        = "run_command"
            description = "Run a shell command and return its output."
            parameters  = @{
                type = "object"
                properties = @{
                    command = @{ type = "string"; description = "The command to run." }
                    workdir = @{ type = "string"; description = "Working directory for the command (optional)." }
                }
                required = @("command")
            }
        }
    }
)

# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------
function Invoke-Tool {
    param(
        [string]$Name,
        [hashtable]$Arguments
    )

    switch ($Name) {
        "list_directory" {
            $p = $Arguments.path
            if ([string]::IsNullOrWhiteSpace($p)) { $p = "." }
            if (-not (Test-Path -LiteralPath $p -PathType Container)) {
                return "ERROR: directory not found: $p"
            }
            $items = Get-ChildItem -LiteralPath $p | ForEach-Object {
                $kind = if ($_.PSIsContainer) { "DIR " } else { "FILE" }
                "{0}  {1}" -f $kind, $_.Name
            }
            if (-not $items) { return "(empty directory)" }
            return ($items -join "`n")
        }
        "read_file" {
            $p = $Arguments.path
            if (-not (Test-Path -LiteralPath $p -PathType Leaf)) {
                return "ERROR: file not found: $p"
            }
            $start = 1
            $count = [int]::MaxValue
            if ($Arguments.ContainsKey("start_line") -and $Arguments.start_line -ne $null) { $start = [int]$Arguments.start_line }
            if ($Arguments.ContainsKey("lines_to_read") -and $Arguments.lines_to_read -ne $null) { $count = [int]$Arguments.lines_to_read }
            $lines = Get-Content -LiteralPath $p -TotalCount ([int]::MaxValue)
            $slice = $lines | Select-Object -Skip ($start - 1) -First $count
            if (-not $slice) { return "(no lines)" }
            return ($slice -join "`n")
        }
        "write_file" {
            $p = $Arguments.path
            $content = if ($Arguments.ContainsKey("content")) { [string]$Arguments.content } else { "" }
            $dir = Split-Path -Parent $p
            if ($dir -and -not (Test-Path -LiteralPath $dir -PathType Container)) {
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
            }
            Set-Content -LiteralPath $p -Value $content -Encoding UTF8
            return "Wrote $((Get-Item -LiteralPath $p).Length) bytes to $p"
        }
        "run_command" {
            $cmd = $Arguments.command
            $wd = if ($Arguments.ContainsKey("workdir") -and $Arguments.workdir) { $Arguments.workdir } else { (Get-Location).Path }
            $out = & powershell.exe -NoProfile -NonInteractive -Command $cmd 2>&1 | Out-String
            return $out.Trim()
        }
        default {
            return "ERROR: unknown tool: $Name"
        }
    }
}

# ---------------------------------------------------------------------------
# Workspace watch helpers
# ---------------------------------------------------------------------------
function Get-WatchSummary {
    param(
        [System.Collections.Generic.List[object]]$Events
    )

    if ($null -eq $Events -or $Events.Count -eq 0) {
        return "waiting for activity..."
    }

    $recent = $Events | Sort-Object Timestamp -Descending | Select-Object -First 12
    $changeCounts = $recent | Group-Object ChangeType | Sort-Object Count -Descending
    if ($changeCounts.Count -eq 0) {
        return "waiting for activity..."
    }

    $part1 = ($changeCounts | Select-Object -First 3 | ForEach-Object { "{0}:{1}" -f $_.Name, $_.Count }) -join " | "
    $topPaths = $recent | Group-Object Path | Sort-Object Count -Descending | Select-Object -First 3 |
        ForEach-Object { $_.Name }
    if ($topPaths.Count -gt 0) {
        $part2 = "top: {0}" -f (($topPaths | ForEach-Object { [System.IO.Path]::GetFileName($_) }) -join ", ")
        return "$part1 | $part2"
    }

    return $part1
}

function Start-WorkspaceWatch {
    param(
        [string]$Path = ".",
        [string]$LogPath = ""
    )

    $watchRoot = if ([string]::IsNullOrWhiteSpace($Path) -or $Path -eq ".") {
        (Get-Location).Path
    } else {
        (Resolve-Path -LiteralPath $Path).Path
    }

    if ([string]::IsNullOrWhiteSpace($LogPath)) {
        $LogPath = Join-Path $watchRoot ".local-agent-watch.log"
    }

    $logDir = Split-Path -Parent $LogPath
    if ($logDir -and -not (Test-Path -LiteralPath $logDir -PathType Container)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }

    $events = New-Object 'System.Collections.Generic.List[object]'
    $watcher = New-Object System.IO.FileSystemWatcher $watchRoot
    $watcher.IncludeSubdirectories = $true
    $watcher.EnableRaisingEvents = $true
    $watcher.NotifyFilter = [System.IO.NotifyFilters]::FileName -bor [System.IO.NotifyFilters]::DirectoryName -bor [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::CreationTime -bor [System.IO.NotifyFilters]::Size

    Write-Host "Watching workspace: $watchRoot" -ForegroundColor Cyan
    Write-Host "Log file: $LogPath" -ForegroundColor DarkGray
    Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray

    while ($true) {
        $result = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::All, 1000)
        if ($result.TimedOut) { continue }

        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $fullPath = if ([string]::IsNullOrWhiteSpace($result.Name)) { $watchRoot } else { (Join-Path $watchRoot $result.Name) }
        $entry = [pscustomobject]@{
            Timestamp = $timestamp
            ChangeType = [string]$result.ChangeType
            Path = $fullPath
        }
        $events.Add($entry) | Out-Null

        Add-Content -LiteralPath $LogPath -Value ("{0}|{1}|{2}" -f $entry.Timestamp, $entry.ChangeType, $entry.Path) -Encoding UTF8
        Write-Host ("[{0}] {1}: {2}" -f $entry.Timestamp, $entry.ChangeType, $entry.Path) -ForegroundColor Green
        Write-Host ("Recent activity: {0}" -f (Get-WatchSummary -Events $events)) -ForegroundColor DarkGray
    }
}

# ---------------------------------------------------------------------------
# API helper
# ---------------------------------------------------------------------------
function Invoke-Chat {
    param(
        [object[]]$Messages
    )

    $body = @{
        model       = $Model
        messages    = $Messages
        temperature = $Temperature
        max_tokens  = $MaxTokens
        tools       = $Tools
        tool_choice = "auto"
    }

    $json = $body | ConvertTo-Json -Depth 20

    $resp = Invoke-RestMethod -Uri "$BaseUrl/chat/completions" -Method Post `
        -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($json))

    return $resp.choices[0].message
}

if ($Watch) {
    Start-WorkspaceWatch -Path $WatchPath -LogPath $WatchLogPath
    exit 0
}

# ---------------------------------------------------------------------------
# Ensure the model is loaded (load on demand if the server has it unloaded).
# ---------------------------------------------------------------------------
function Ensure-ModelLoaded {
    $lms = Join-Path $env:USERPROFILE ".lmstudio\bin\lms.exe"
    if (-not (Test-Path $lms)) { return }
    try {
        $models = (Invoke-RestMethod -Uri "$BaseUrl/models" -Method Get -TimeoutSec 10).data
        if ($models.id -contains $Model) { return }
    } catch {
        # Server not reachable yet; try to start it.
        & $lms server start 2>&1 | Out-Null
        Start-Sleep -Seconds 2
    }
    Write-Host "Loading model $Model ..." -ForegroundColor DarkGray
    # --ttl unloads the model after it has been idle for the given seconds,
    # so RAM is freed when the model is not actively in use.
    & $lms load $Model --ttl 600 -y 2>&1 | Out-Null
    # Wait until the model appears in the server's model list.
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        try {
            $models = (Invoke-RestMethod -Uri "$BaseUrl/models" -Method Get -TimeoutSec 5).data
            if ($models.id -contains $Model) { return }
        } catch { }
    }
    Write-Warning "Could not confirm model $Model is loaded."
}

# ---------------------------------------------------------------------------
# Main agent loop
# ---------------------------------------------------------------------------
Ensure-ModelLoaded

$messages = @(
    @{ role = "system"; content = $SystemPrompt }
)

if ([string]::IsNullOrWhiteSpace($Prompt)) {
    Write-Host "Local Agent (type 'exit' to quit)" -ForegroundColor Cyan
    Write-Host "---------------------------------" -ForegroundColor Cyan
}

$finalAnswer = ""
$iteration = 0

while ($true) {
    if ([string]::IsNullOrWhiteSpace($Prompt)) {
        $userInput = Read-Host "You"
        if ($userInput -eq "exit") { break }
        if ([string]::IsNullOrWhiteSpace($userInput)) { continue }
        if ($NoThink) { $userInput = $userInput + " /no_think" }
        $messages += @{ role = "user"; content = $userInput }
    }
    else {
        $content = $Prompt
        if ($NoThink) { $content = $content + " /no_think" }
        $messages += @{ role = "user"; content = $content }
    }

    $iteration = 0
    while ($iteration -lt $MaxIterations) {
        $iteration++

        $msg = Invoke-Chat -Messages $messages

        # Model wants to call tools
        if ($msg.tool_calls -and $msg.tool_calls.Count -gt 0) {
            $messages += @{
                role         = "assistant"
                content      = $msg.content
                tool_calls   = $msg.tool_calls
            }

            foreach ($call in $msg.tool_calls) {
                $name = $call.function.name
                $rawArgs = $call.function.arguments
                $argTable = @{}
                if ($rawArgs) {
                    $parsed = $rawArgs | ConvertFrom-Json
                    foreach ($prop in $parsed.PSObject.Properties) {
                        $argTable[$prop.Name] = $prop.Value
                    }
                }

                Write-Host ("  [tool] {0} {1}" -f $name, ($rawArgs -replace "\s+", " ")) -ForegroundColor DarkGray
                $result = Invoke-Tool -Name $name -Arguments $argTable

                $messages += @{
                    role         = "tool"
                    tool_call_id = $call.id
                    content      = $result
                }
            }
            continue
        }

        # Final answer
        $finalAnswer = $msg.content
        Write-Host $finalAnswer
        break
    }

    if (-not [string]::IsNullOrWhiteSpace($Prompt)) { break }
    if ($iteration -ge $MaxIterations) {
        Write-Host "(Reached max iterations for this turn.)" -ForegroundColor Yellow
    }
}
