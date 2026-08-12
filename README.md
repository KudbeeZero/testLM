# Local Agent

A lightweight **local agent** that runs entirely on your machine. It talks to a
locally hosted LLM (via the OpenAI-compatible API) and can inspect files and
run commands using tool/function calling.

The agent is written in **PowerShell** and uses only built-in cmdlets, so there
are **no dependencies to install** — it works out of the box on Windows.

## What's in this folder

| File              | Description                                                       |
| ----------------- | ----------------------------------------------------------------- |
| `local-agent.ps1` | The agent itself (a single self-contained PowerShell script).     |
| `README.md`       | This file.                                                        |

## Current setup

- **Model:** `qwen/qwen3-8b` (Qwen3 8B, Q4_K_M, ~5 GB) — installed via `lms`.
- **Server:** LM Studio local server on `http://localhost:1234/v1` (start with `lms server start`).
- **Agent default:** `local-agent.ps1` defaults to `qwen/qwen3-8b`.
- **CLI:** `lms` is installed at `%USERPROFILE%\.lmstudio\bin` and added to the user PATH.

### Quick start

```powershell
lms server start          # start the local server (if not already running)
.\local-agent.ps1 -Prompt "List the files in this folder"
```

> **Memory note:** On this machine (16 GB RAM, CPU-only) Qwen3-8B uses ~10 GB of
> RAM while loaded, so the agent **loads the model on demand** and the model is
> left unloaded when idle. Running the agent will automatically start the server
> and load `qwen/qwen3-8b` if needed; it takes ~15-20 s to load the first time.

## How it works

The agent runs an agentic loop:

1. Send the conversation (system prompt + history) to the local model.
2. If the model requests tool calls, execute them and feed the results back.
3. Repeat until the model produces a final answer, then print it.

### Tools available to the model

| Tool             | Description                                        |
| ---------------- | -------------------------------------------------- |
| `list_directory` | List files and subfolders in a directory.          |
| `read_file`      | Read text from a file (with optional line range).  |
| `write_file`     | Write text content to a file.                      |
| `run_command`    | Run a shell command and return its output.         |

## Prerequisites

- **Windows** with PowerShell 5.1+ (built in).
- A local LLM server exposing the OpenAI-compatible Chat Completions API.
  The easiest option is **LM Studio**:

  1. Load a model in LM Studio.
  2. Start the local server (**Developer** tab → **Start Server**).
  3. The default endpoint is `http://localhost:1234/v1`.

## Usage

### One-shot mode

```powershell
.\local-agent.ps1 -Prompt "What files are in this folder?"
```

Specify a model (optional — otherwise the server default is used):

```powershell
.\local-agent.ps1 -Prompt "Read README.md and summarize it" -Model "qwen2.5-coder-7b-instruct"
```

### Interactive mode

Run with no `-Prompt` to get a chat REPL. Type `exit` to quit:

```powershell
.\local-agent.ps1
```

### Options

| Parameter       | Default                    | Description                                        |
| --------------- | -------------------------- | -------------------------------------------------- |
| `-BaseUrl`      | `http://localhost:1234/v1` | OpenAI-compatible API base URL.                    |
| `-Model`        | `qwen/qwen3-8b`            | Model id to use.                                   |
| `-SystemPrompt` | *(built-in)*               | System prompt defining agent behavior.             |
| `-Prompt`       | *(interactive)*            | One-shot user request.                             |
| `-MaxIterations`| `10`                       | Max tool-call iterations per turn.                 |
| `-Temperature`  | `0.3`                      | Sampling temperature.                              |
| `-NoThink`      | `true`                     | Append `/no_think` to disable reasoning (faster on CPU). |
| `-MaxTokens`    | `2048`                     | Max tokens per model response (safety cap).       |

> **Note:** If PowerShell blocks script execution, allow it for this folder:
> `Set-ExecutionPolicy -Scope Process Bypass` or run
> `powershell -ExecutionPolicy Bypass -File .\local-agent.ps1`.

## Example

```powershell
.\local-agent.ps1 -Prompt "Create a file called hello.txt containing 'Hello, local agent!'"
```

The agent will call `write_file`, confirm the write, and report the result.
