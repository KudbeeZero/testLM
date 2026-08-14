# Gas Town — Local & EC2 Runbook

Operating guide for running the Gas Town operations stack **locally** and on the
provisioned **EC2** fleet. Everything below was verified against the live
environment.

---

## 1. Architecture / topology

| Layer | Local this machine | Cloud (EC2) |
|-------|--------------------|-------------|
| **Agent DB (per agent)** | Neon `local-comp` (`agent_local` / `agent_gemini` / `agent_grok`) | AWS RDS Postgres cluster |
| **Shared Neon DB** | `DATABASE_URL` → `ep-damp-voice…neon.tech/local-comp` | — |
| **Redis / Vector / QStash** | Upstash (REST URLs, cloud) | Upstash (cloud) or self-hosted on EC2 |
| **OS agent** | `node index.js` (this host) | `node index.js` on EC2 |
| **Ingestion server** | `services/ingestion/server.js` (port 3000) | EC2 |
| **Gas Town dashboard** | `gastown-dashboard-server.js` (port 4180) | EC2 behind proxy |
| **Agent fleet** | monorepo `services/*` (hermes, sentinel, monitor…) | EC2 |

**Key fact:** the OS agent writes learnings into the **per-agent Postgres
schema** (`agent_gemini.learnings`, etc.). The Gas Town dashboard reads those
back live.

---

## 2. Run locally (verified)

### Prerequisites
- Node.js (>=22) at `C:\Program Files\nodejs\node.exe`
- Local Postgres OR the Neon connection string in `testLM/.env` (`DATABASE_URL`)
- `.env` present at `testLM/.env` and `testLM/os-agent/.env`
- `GEMINI_API_KEY` set (working model: `gemini-flash-latest`)
- Upstash Redis/Vector/QStash keys set in `.env` (cloud — no local Redis needed)

### Start the Gas Town dashboard
```bash
cd testLM/os-agent
node gastown-dashboard-server.js          # http://127.0.0.1:4180
```

Endpoints:
- `GET  /`              — dashboard frontend
- `GET  /api/state`     — full live state (DB, env, APIs, gastown)
- `GET  /api/gastown`   — bus firewall + phone system
- `GET  /api/health`    — probe (`{"status":"ok",...}`)
- `POST /api/terminal`  — interactive terminal → Gemini dispatcher
  `{ "command": "show budget" }`

### Run the OS agent (writes to agent DB)
```bash
cd testLM/os-agent
$env:MODEL_PROVIDER="gemini"   # or "local" / "grok"
node index.js --learn-only     # or --maintain-only, or no flag for both
```
On success you'll see `[db] Stored N learning(s) in schema "agent_gemini".`
The dashboard then reflects the updated row count live.

> **Model gotcha (fixed):** `gemini-2.5-flash` is retired (HTTP 404) for new
> users. Use `gemini-flash-latest`. Both `.env` files were updated.

### Run the monorepo ingestion server (needs Redis/Postgres)
```bash
cd testLM/Kudbee-fuel-gage
npm ci --legacy-peer-deps --ignore-scripts
npm run dev        # or: npx tsx services/ingestion/server.js  (port 3000)
```
This brings the `/api/gastown/dashboard`, `/api/system/*`, and terminal-auth
endpoints online so the dashboard API-health panel goes green.

---

## 3. Run on EC2 (provisioned instances)

Two EC2 instances are configured in `testLM/.env`:
```
EC2_INSTANCE_ID=i-0a8157bc8ea33b36b, i-0685561c90845986d
VPC_ID=vpc-0027c7c93792e84e4
```
AWS RDS Postgres cluster is configured via
`AWS_DATABASE_USERNAME` / `AWS_DATABASE_PASSWORD` / `AWS_SECRET_ARN_KEY`.

### Prereqs on each instance
```bash
# Ubuntu 22/24
sudo apt update && sudo apt install -y git curl postgresql-client redis-tools
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
npm i -g tsx turbo bun@latest
```

### Deploy the stack (idempotent, per instance)
```bash
cd ~ && git clone <kudbee repo> kudbee-fuel-gage
cd kudbee-fuel-gage && npm ci --legacy-peer-deps --ignore-scripts

# Point at the AWS RDS cluster (or the existing Neon local-comp)
export DATABASE_URL="postgresql://postgres:***@<rds-endpoint>/kudbee?sslmode=require"

# Start ingestion server
nohup npx tsx services/ingestion/server.js > /var/log/kudbee-ingest.log 2>&1 &

# Start agent worker(s)
nohup npx tsx services/agent/gastown-cli.ts --daemon > /var/log/kudbee-agent.log 2>&1 &
```

### Optional: self-host Redis on EC2 (instead of Upstash)
```bash
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
export REDIS_URL="redis://127.0.0.1:6379"
```

### Access the dashboard
```bash
ssh -i ~/.ssh/id_rsa ubuntu@<public-ip>
```
Or front it with nginx + TLS for a public hostname.

---

## 4. Recommended production split
- **This laptop** → Gas Town dashboard + OS agent (lightweight, always-on).
- **EC2 instance 1** → monorepo ingestion server + Heroku-style web (port 3000).
- **EC2 instance 2** → agent worker fleet (hermes, sentinel, monitor, qstash) +
  optional self-hosted Redis.
- **Shared** → Neon `local-comp` or AWS RDS Postgres; Upstash Redis/Vector/QStash.

---

## 5. Troubleshooting
- **`ECONNREFUSED :::1234`** on `--learn-only` → provider is `local` but LM Studio
  isn't running. Set `MODEL_PROVIDER=gemini` (or launch LM Studio).
- **Gemini `404 … no longer available`** → stale `GEMINI_MODEL`. Use
  `gemini-flash-latest`.
- **Dashboard `API Health: unreachable`** → ingestion server (port 3000) isn't up.
- **`healthScore` low** → check DB `connected`, bus `connected`, and API OK count
  in `/api/state`.
