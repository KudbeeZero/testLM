# Kudbee / testLM — Engineering OS Agent

A multi-provider **engineering OS Agent** that keeps the machine optimized and
always learning, using local models and cloud APIs (Gemini, Grok, DeepSeek).

> **Read [ENVIRONMENT.md](ENVIRONMENT.md) first.** It is the single source of
> truth for every `.env` variable, API key, service, and setup step.

## What's in this folder

| Path | Description |
| --- | --- |
| `os-agent/` | Node.js engineering OS Agent ( multi-provider, learning memory, dashboards). |
| `agent/` | PowerShell maintenance + learning modules (backend). |
| `dev/` | Dev environment tooling (Docker, setup scripts). |
| `v8-embedder/` | Rust V8 embedder project. |
| `local-agent.ps1` | Lightweight PowerShell local agent (single file). |
| `ENVIRONMENT.md` | Full `.env` reference — every key, service, setup step. |
| `Kudbee-fuel-gage/` | Subproject (gitlink). |

## Current setup

- **Local model:** `qwen/qwen3-1.7b` (fast, ~2.5 GB) — installed via `lms`.
- **Server:** LM Studio local server on `http://localhost:1234/v1`.
- **OS Agent:** `os-agent/` (Node) — multi-provider, stores learnings in Neon
  Postgres + mirrors to Upstash Redis.
- **Providers:** local / Gemini / Grok (DeepSeek V4 Flash in progress).

## Quick start

```powershell
cd os-agent
node index.js          # run maintenance + learning
```

## Environment

All secrets live in the workspace `.env` (gitignored). See `ENVIRONMENT.md` for
the full list of providers, databases, Upstash services, MCP servers, and the
setup checklist.
