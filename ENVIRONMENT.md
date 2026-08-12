# Environment & `.env` Reference

This is the **single source of truth** for every environment variable, API key,
and service used by the engineering OS Agent. Keep it updated whenever you add a
service or key so we never lose track again.

> **Security rule:** The real `.env` file is **gitignored** and never committed.
> Only this document and `os-agent/.env.example` are committed (with empty values).
> Never paste live keys into chat or commit them.

---

## 1. The `.env` file

Location: **`C:\Users\domin\Downloads\testLM\.env`** (workspace root).

The os-agent loads it automatically (via `dotenv`) from the workspace root and
the `os-agent/` folder. It is excluded from Git via `.gitignore` (`.env`,
`grok.env`, `os-agent/.env`).

### How to edit
```powershell
notepad C:\Users\domin\Downloads\testLM\.env
```
After editing, restart any running agent/terminal so it picks up the new values.

---

## 2. Model providers

| Variable | Purpose | Where to get it |
| --- | --- | --- |
| `LOCAL_MODEL` | Local LM Studio model (currently `qwen/qwen3-1.7b`) | Installed via `lms get` |
| `LM_STUDIO_BASE_URL` | LM Studio server (ws:// for SDK, http:// for API) | LM Studio Developer tab |
| `GEMINI_API_KEY` | Google Gemini API | https://aistudio.google.com/apikey |
| `GEMINI_MODEL` | Gemini model (cheapest thinking: `gemini-2.5-flash`) | — |
| `XAI_API_KEY` | xAI Grok API | https://console.x.ai/team/default/api-keys |
| `GROK_MODEL` | Grok model (cheapest reasoning: `grok-4.3`) | — |
| `LIGHTNING_API_KEY` | Lightning AI servers | https://lightning.ai |
| `LIGHTNING_USER_ID` | Lightning AI account user id | Lightning console / account |

### Provider switching
Set `MODEL_PROVIDER=local|gemini|grok` in `.env` to choose which the os-agent uses.

---

## 3. Databases & storage

| Variable | Purpose | Where to get it |
| --- | --- | --- |
| `DATABASE_URL` | Neon serverless Postgres connection string | Neon console → database |
| `DATABASE_API_PRODUCTION` | Neon REST (PostgREST) API URL | Neon console → API |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` | Local PostgreSQL (optional) | Local install |
| `PG_DB_LOCAL` / `PG_DB_GEMINI` / `PG_DB_GROK` | Per-agent schema names | — |

The agent auto-creates one schema per agent: `agent_local`, `agent_gemini`,
`agent_grok` — each with a `learnings` table.

---

## 4. Upstash (Redis / Vector / QStash / Box)

| Variable | Purpose | Where to get it |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint | Upstash console → Redis |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis read/write token | Upstash console → Redis |
| `UPSTASH_VECTOR_REST_URL` | Upstash Vector endpoint (1536-dim) | Upstash console → Vector |
| `UPSTASH_VECTOR_REST_TOKEN` | Upstash Vector token | Upstash console → Vector |
| `UPSTASH_BOX_API_KEY` | Upstash Box sandbox API key | Upstash console → Box |
| `QSTASH_URL` | QStash messaging endpoint | Upstash console → QStash |
| `QSTASH_TOKEN` | QStash token | Upstash console → QStash |
| `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | QStash signing keys | Upstash console → QStash |

### Upstash Box
Box ID: **`singular-haddock-28317`** · Preview: `https://singular-haddock-28317-9223.preview.box.upstash.com`
Connect via SDK (`@upstash/box`) using `UPSTASH_BOX_API_KEY`, or SSH with the
Box API key as the password:
```bash
ssh singular-haddock-28317@us-east-1.box.upstash.com   # password = UPSTASH_BOX_API_KEY
```

---

## 5. Budget & rate limits

| Variable | Default | Purpose |
| --- | --- | --- |
| `MONTHLY_BUDGET_USD` | `50` | Hard cap on monthly LLM spend per provider |
| `RATE_LIMIT_PER_MINUTE` | `30` | Max cloud API requests per minute |
| `MODEL_TTL_SECONDS` | `600` | Unload local model after idle seconds (RAM saving) |

---

## 6. MCP servers (Grok CLI)

Config: **`C:\Users\domin\.grok\settings.json`**

| Server | Purpose |
| --- | --- |
| `filesystem` | Read/write files in the workspace |
| `postgres` | Query the Neon Postgres DB |
| `upstash-redis` | Interact with Upstash Redis (`@upstash/redis-mcp`) |

---

## 7. Setup checklist (trace log)

- [x] Git installed (winget) + repo initialized
- [x] Node.js LTS installed (v24.19.0) + npm
- [x] PostgreSQL 18 installed (local, service `postgresql-x64-18`)
- [x] LM Studio + local model `qwen/qwen3-1.7b`
- [x] Grok CLI installed (`@xai-official/grok`)
- [x] Neon Postgres connected, per-agent schemas created
- [x] Upstash Redis / Vector / QStash / Box verified
- [x] MCP servers configured (filesystem, postgres, upstash-redis)
- [x] SDKs installed (`@upstash/*`, `pg`, `@lmstudio/sdk`, `@google/generative-ai`, `dotenv`)

---

## 8. How to verify everything works

Run the OS Agent:
```powershell
cd C:\Users\domin\Downloads\testLM\os-agent
node index.js
```
It should: run maintenance → learn → store learnings in Neon (`agent_local`)
and mirror memory to Upstash Redis. Check the DB:
```powershell
$env:PGPASSWORD="<neon-pass>"
"C:\Program Files\PostgreSQL\18\bin\psql.exe" "postgresql://neondb_owner@<host>/local-comp?sslmode=require" -tAc "SELECT provider, topic FROM agent_local.learnings ORDER BY id DESC LIMIT 5;"
```
