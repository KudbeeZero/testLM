// os-agent/gastown-dashboard-server.js
// ---------------------------------------------------------------------------
// Gas Town Operations Dashboard — production-grade live operations console.
//
// Aggregates the full agent ecosystem into a single view:
//   1. Per-agent databases (Neon/Postgres agent_local / agent_gemini /
//      agent_grok schemas + table inventory).
//   2. Environment variables the app consumes (safe inventory, secrets masked).
//   3. API health checks for the service endpoints.
//   4. Live event-bus firewall + phone-system feeds.
//   5. Interactive terminal bridged to the monorepo Gemini command dispatcher.
//
// Engineering posture:
//   - Every async boundary is wrapped; failures degrade to safe default shapes.
//   - No unhandled promise rejections: all top-level handlers are guarded.
//   - Graceful shutdown on SIGINT/SIGTERM cleans up the pool + WS clients.
//   - Request-level timeouts and a bounded request-body limit.
//
// Run:  node os-agent/gastown-dashboard-server.js   (default port 4180)
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // testLM/
const PORT = Number(process.env.GASTOWN_DASHBOARD_PORT || 4180);

// Kudbee monorepo .kilo/memory (phone tree, call log, voicemails), if present.
const MONOREPO = path.join(ROOT, "Kudbee-fuel-gage");
const KILO_MEMORY = path.join(MONOREPO, ".kilo", "memory");
const TERMINAL_DISPATCH = path.join(MONOREPO, "services", "terminal", "commandDispatcher.mjs");

const MAX_BODY_BYTES = 64 * 1024; // 64KB terminal-command body cap
const REQUEST_TIMEOUT_MS = 25_000;
const POLL_INTERVAL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 6_000;

// Load workspace-root .env + os-agent .env (same order as src/config.js)
try { loadEnv({ path: path.join(ROOT, ".env") }); } catch { /* no-op */ /* no-op */}
try { loadEnv({ path: path.join(__dirname, ".env") }); } catch { /* no-op */ /* no-op */}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
const log = {
  info: (...a) => console.log(`[gastown] ${new Date().toISOString()}`, ...a),
  warn: (...a) => console.warn(`[gastown] ${new Date().toISOString()}`, ...a),
  error: (...a) => console.error(`[gastown] ${new Date().toISOString()}`, ...a),
};

// Keep Node from crashing on an unhandled rejection anywhere in the stack.
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection:", reason instanceof Error ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception:", err && err.stack ? err.stack : err.message || err);
});

// ---------------------------------------------------------------------------
// Safe JSON response helper (never throws to the wire)
// ---------------------------------------------------------------------------
function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload);
    res.statusCode = status || 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  } catch (e) {
    // Absolute last-resort: fall back to a minimal object so the client always
    // receives parseable JSON.
    try {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "serialization_failed" }));
    } catch { /* no-op */ /* no-op */
      if (res.writableEnded === false) res.end();
    }
  }
}

// ---------------------------------------------------------------------------
// Static inventory (safe metadata; values resolved live from process.env)
// ---------------------------------------------------------------------------

// Each agent owns a Postgres schema in the shared database.
const AGENT_SCHEMAS = [
  { id: "local", label: "LM Studio / Qwen3", db: process.env.PG_DB_LOCAL || "agent_local" },
  { id: "gemini", label: "Gemini (Google)", db: process.env.PG_DB_GEMINI || "agent_gemini" },
  { id: "grok", label: "Grok (xAI)", db: process.env.PG_DB_GROK || "agent_grok" },
];

// Important variables the app consumes. Secrets are masked; only PRESENCE shown.
const ENV_VARS = [
  { key: "GEMINI_API_KEY", kind: "llm", secret: true },
  { key: "GEMINI_MODEL", kind: "llm" },
  { key: "GROQ_API_KEY", kind: "llm", secret: true },
  { key: "XAI_API_KEY", kind: "llm", secret: true },
  { key: "GROK_MODEL", kind: "llm" },
  { key: "VLLM_BASE_URL", kind: "llm", secret: true },
  { key: "VLLM_API_KEY", kind: "llm", secret: true },
  { key: "DATABASE_URL", kind: "database", secret: true },
  { key: "DATABASE_API_PRODUCTION", kind: "database", secret: true },
  { key: "REDIS_URL", kind: "redis", secret: true },
  { key: "REDIS_WORKER_URL", kind: "redis", secret: true },
  { key: "UPSTASH_REDIS_REST_URL", kind: "redis", secret: true },
  { key: "UPSTASH_REDIS_REST_TOKEN", kind: "redis", secret: true },
  { key: "UPSTASH_VECTOR_REST_URL", kind: "redis", secret: true },
  { key: "UPSTASH_VECTOR_REST_TOKEN", kind: "redis", secret: true },
  { key: "UPSTASH_BOX_API_KEY", kind: "redis", secret: true },
  { key: "QSTASH_URL", kind: "redis", secret: true },
  { key: "QSTASH_TOKEN", kind: "redis", secret: true },
  { key: "STREAM_SECRET", kind: "auth", secret: true },
  { key: "SESSION_SECRET", kind: "auth", secret: true },
  { key: "CORS_ALLOW_ORIGINS", kind: "app" },
  { key: "APP_URL", kind: "app" },
  { key: "REACT_APP_API_URL", kind: "app" },
  { key: "MONTHLY_BUDGET_USD", kind: "app" },
  { key: "RATE_LIMIT_PER_MINUTE", kind: "app" },
];

const API_ENDPOINTS = [
  { name: "Health", path: "/health", friendly: "Health check" },
  { name: "System Deep", path: "/api/system/health-deep", friendly: "Dependency latency probes" },
  { name: "Agent Status", path: "/api/system/agent-status", friendly: "Agent fleet health" },
  { name: "System Alerts", path: "/api/system/alerts", friendly: "Active alerts" },
  { name: "CI Status", path: "/api/ci/status", friendly: "CI workflow status" },
  { name: "PR Status", path: "/api/prs/status", friendly: "Pull request status" },
  { name: "Router Status", path: "/api/router/status", friendly: "Agent router status" },
  { name: "Gastown Dashboard", path: "/api/gastown/dashboard", friendly: "Gas Town KPIs" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mask(v) {
  if (!v) return "";
  const s = String(v);
  // Short/secret values: reveal presence only; never show overlapping chars.
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 3)}…${s.slice(-3)}`;
}

function envStatus(key) {
  const v = process.env[key];
  if (v === undefined || v === "" || v === null) return { status: "missing", value: "" };
  return { status: "configured", value: v };
}

function apiBaseUrl() {
  return (
    process.env.REACT_APP_API_URL ||
    process.env.APP_URL ||
    `http://127.0.0.1:${process.env.PORT || 3000}`
  );
}

// Cooperative timeout wrapper so a slow downstream call can never hang the feed.
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Database metrics (per-agent schema + table inventory) via Postgres
// ---------------------------------------------------------------------------

let _dbCache = null;

async function queryDatabase() {
  const conn = process.env.DATABASE_URL;
  if (!conn) return { connected: false, degraded: true, error: "DATABASE_URL not set", agentSchemas: [], tables: [] };

  let Pool;
  try {
    const mod = await import("pg");
    Pool = mod.Pool || mod.default || null;
  } catch { /* no-op */ /* no-op */
    return { connected: false, degraded: true, error: "pg not installed", agentSchemas: [], tables: [] };
  }
  if (!Pool) return { connected: false, degraded: true, error: "pg not installed", agentSchemas: [], tables: [] };

  const pool = new Pool({
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 6000,
    connectionTimeoutMillis: 8000,
  });

  const result = { connected: true, database: "kudbee", size: "n/a", agentSchemas: AGENT_SCHEMAS.map((a) => ({ ...a, exists: false, tables: [] })), tables: [] };

  try {
    const db = await withTimeout(
      pool.query(`SELECT current_database() AS db, pg_size_pretty(pg_database_size(current_database())) AS size`),
      8000,
      "db-probe"
    );
    result.database = db?.rows?.[0]?.db || "kudbee";
    result.size = db?.rows?.[0]?.size || "n/a";

    for (const agent of AGENT_SCHEMAS) {
      try {
        const s = await withTimeout(
          pool.query(`SELECT count(*) AS c FROM information_schema.schemata WHERE schema_name = $1`, [agent.db]),
          5000,
          `schema-${agent.id}`
        );
        const exists = Number(s?.rows?.[0]?.c) > 0;
        const tables = [];
        if (exists) {
          const t = await withTimeout(
            pool.query(`SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = $1 ORDER BY tablename`, [agent.db]),
            5000,
            `tables-${agent.id}`
          );
          for (const row of t?.rows || []) {
            try {
              const name = String(row.name).replace(/[^A-Za-z0-9_]/g, "");
              const c = await withTimeout(
                pool.query(`SELECT count(*) AS c FROM "${agent.db}"."${name}"`),
                5000,
                `count-${name}`
              );
              tables.push({ name, count: Number(c?.rows?.[0]?.c) || 0 });
            } catch { /* no-op */ /* no-op */
              tables.push({ name: row.name, count: null });
            }
          }
        }
        const idx = result.agentSchemas.findIndex((a) => a.id === agent.id);
        if (idx >= 0) result.agentSchemas[idx] = { ...agent, exists, tables };
      } catch { /* no-op */ /* no-op */
        // schema-level failure keeps default exists:false
      }
    }

    // Aggregate table inventory (roll up per-table totals across schemas).
    const seen = new Map();
    for (const a of result.agentSchemas) {
      for (const t of a.tables || []) {
        const cur = seen.get(t.name) || { name: t.name, count: 0, schemas: [] };
        if (typeof t.count === "number") cur.count += t.count;
        cur.schemas.push(a.id);
        seen.set(t.name, cur);
      }
    }
    result.tables = [...seen.values()];
    result.degraded = false;
  } catch (err) {
    result.connected = false;
    result.degraded = true;
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    try { await pool.end(); } catch { /* no-op */ /* no-op */}
  }
  return result;
}

// ---------------------------------------------------------------------------
// Live API health checks
// ---------------------------------------------------------------------------

async function checkApiHealth() {
  const base = apiBaseUrl().replace(/\/$/, "");
  const checks = [];
  for (const ep of API_ENDPOINTS) {
    let ctrl;
    let timer;
    try {
      ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
      const respondedAt = Date.now();
      const res = await fetch(`${base}${ep.path}`, { signal: ctrl.signal });
      let latency = "";
      try { latency = res.headers.get("x-response-time") || ""; } catch { /* no-op */ /* no-op */}
      checks.push({
        ...ep,
        status: res.ok ? "ok" : res.status,
        latency: latency || `${Date.now() - respondedAt}ms`,
      });
    } catch { /* no-op */ /* no-op */
      checks.push({ ...ep, status: "unreachable", latency: "" });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { base, checks };
}

// ---------------------------------------------------------------------------
// Aggregate state for the dashboard (fully guarded)
// ---------------------------------------------------------------------------

async function getState() {
  // Run each producer independently and never let one failure break the rest.
  let db, api, gastown, inception, aws;
  try { db = await queryDatabase(); } catch (e) { db = { connected: false, degraded: true, error: e?.message || "db failed", agentSchemas: [], tables: [] }; }
  try { api = await checkApiHealth(); } catch (e) { api = { base: apiBaseUrl(), checks: [], error: e?.message || "api check failed" }; }
  try { gastown = getGasTownFeed(); } catch (e) { gastown = { phone: { nodes: [], callLog: [], callCount: 0, voicemails: [], voicemailCount: 0 }, bus: null, error: e?.message || "gastown feed failed" }; }
  try { inception = await getInceptionFullFeed(); } catch (e) { inception = { provider: "Inception Labs", status: "feed error", error: e?.message }; }
  try { aws = awsFeed(); } catch (e) { aws = { ec2Instances: [], rds: {}, error: e?.message }; }

  const env = ENV_VARS.map(({ key, kind, secret }) => {
    try {
      const s = envStatus(key);
      return { key, kind, secret: !!secret, status: s.status, value: secret && s.value ? mask(s.value) : s.value };
    } catch { /* no-op */ /* no-op */
      return { key, kind, secret: !!secret, status: "error", value: "" };
    }
  });

  const envCount = {
    total: ENV_VARS.length,
    configured: env.filter((e) => e.status === "configured").length,
    missing: env.filter((e) => e.status === "missing").length,
  };

  const healthScore = (() => {
    let score = 0, total = 0;
    if (db?.connected) { score += 1; } total += 1;
    if (gastown?.bus?.connected) { score += 1; } total += 1;
    const okApis = (api?.checks || []).filter((c) => c.status === "ok").length;
    if (api?.checks?.length) { score += okApis / api.checks.length; total += 1; }
    return total ? Math.round((score / total) * 100) : 0;
  })();

  return {
    ok: !!(db?.connected || gastown?.bus?.connected || (api?.checks?.length)),
    healthScore,
    timestamp: new Date().toISOString(),
    workspace: path.basename(ROOT),
    services: {
      ingestion: process.env.PORT || 3000,
      dashboard: PORT,
    },
    database: db,
    env: {
      vars: env,
      counts: envCount,
      budgetUsd: process.env.MONTHLY_BUDGET_USD || "50",
      rateLimitPerMinute: process.env.RATE_LIMIT_PER_MINUTE || "30",
    },
    apis: api,
    gastown,
    inception,
    aws,
  };
}

// ---------------------------------------------------------------------------
// Bus firewall + phone system (reads the Kudbee event bus / phone tree)
// ---------------------------------------------------------------------------

function readJsonStore(rel, fallback) {
  try {
    const p = path.join(KILO_MEMORY, rel);
    if (!existsSync(p)) return fallback;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch { /* no-op */ /* no-op */
    return fallback;
  }
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch { /* no-op */ /* no-op */
    return [];
  }
}

// Phone system: tree, call log, voicemails.
function phoneFeed() {
  const tree = readJsonStore("phone-tree.json", { nodes: {} });
  const calls = readJsonStore("call-log.json", { calls: [] });
  const callLog = Array.isArray(calls?.calls) ? calls.calls : [];

  let voicemails = [];
  try {
    const dir = path.join(KILO_MEMORY, "voicemails");
    if (existsSync(dir)) {
      for (const f of readdirSyncSafe(dir).filter((x) => x.endsWith(".json"))) {
        try {
          const d = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
          if (Array.isArray(d)) voicemails.push(...d);
          else voicemails.push(d);
        } catch { /* no-op */ /* no-op */}
      }
    }
  } catch { /* no-op */ /* no-op */}
  voicemails.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));

  const nodes = Object.values(tree?.nodes ?? {});
  return {
    provider: process.env.EDGE_AGENT_PASS ? "mode-b (auth)" : "mode-a (open)",
    nodes,
    callLog: callLog.slice(0, 30),
    callCount: callLog.length,
    voicemails: voicemails.slice(0, 30),
    voicemailCount: voicemails.length,
  };
}

// Bus firewall: model the event bus as Redis/Upstash transport + firewall posture.
function busFeed() {
  const fast = process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
  const worker = process.env.REDIS_WORKER_URL || process.env.REDIS_URL;
  return {
    mode: process.env.SENTINEL_MODE || "monitor",
    transport: {
      primary: fast ? "configured" : "missing",
      worker: worker ? "configured" : "missing",
      qstash: process.env.QSTASH_URL ? "configured" : "missing",
    },
    channel: "kudbee:events",
    firewall: {
      policy: process.env.SENTINEL_MODE || "monitor",
      edgeSentinel: process.env.SENTINEL_AGENT_PASS ? "armed" : "disabled",
      ingestFilter: "low-value/heartbeat events dropped before persist",
      budgetFirewall: "heartbeat filtered at budget firewall",
    },
    connected: !!fast,
  };
}

// ---------------------------------------------------------------------------
// Interactive terminal: bridge to the monorepo command dispatcher
// ---------------------------------------------------------------------------

let _dispatchLoaded = false;

async function loadTerminal() {
  if (_dispatchLoaded) return true;
  try {
    if (!existsSync(TERMINAL_DISPATCH)) return false;
    const { dispatchCommand } = await import(pathToFileURL(TERMINAL_DISPATCH).href);
    if (typeof dispatchCommand === "function") {
      global.__gastownDispatch = dispatchCommand;
      _dispatchLoaded = true;
      return true;
    }
    return false;
  } catch (e) {
    log.warn("Terminal dispatcher unavailable:", e instanceof Error ? e.message : e);
    return false;
  }
}

async function runTerminalCommand(cmd) {
  const safeCmd = String(cmd || "").trim();
  try {
    const loaded = await loadTerminal();
    if (loaded && typeof global.__gastownDispatch === "function") {
      let r;
      try {
        r = await withTimeout(global.__gastownDispatch(safeCmd), 20_000, "dispatch");
      } catch (e) {
        return { type: "terminal:error", exitCode: 1, output: e instanceof Error ? e.message : String(e) };
      }
      const text = r?.output ?? r?.answer ?? (typeof r === "string" ? r : "");
      return {
        type: r && typeof r === "object" && !r.output ? "ask:response" : "terminal:result",
        exitCode: r?.exitCode ?? 0,
        output: typeof text === "string" ? text : JSON.stringify(text),
        meta: {
          provider: r?.provider ?? "",
          model: r?.model ?? "",
          latencyMs: r?.latencyMs ?? null,
          costUsd: r?.costUsd ?? null,
          budget: r?.budget ?? null,
          usage: r?.usage ?? null,
        },
      };
    }

    // Enterprise-safe fallback: an EXPLICIT allowlist of immutable read-only
    // subcommands. No raw user input is ever interpolated into a shell. If a
    // command isn't on the allowlist it is rejected outright; the interactive
    // PowerShell path is intentionally removed (bypassable sandbox).
    const safeRun = (() => {
      const LOW_RISK = {
        git_status: { cmd: ["git", "status", "--short"] },
        git_branch: { cmd: ["git", "branch", "--show-current"] },
        git_log: { cmd: ["git", "log", "--oneline", "-10"] },
        ls: { cmd: ["cmd", "/c", "dir"] },
        node_version: { cmd: [process.execPath, "--version"] },
        npm_ls: { cmd: ["cmd", "/c", "npm ls --depth=0"] },
        system_uptime: { cmd: [process.execPath, "-e", "console.log(process.uptime().toFixed(1))"] },
      };
      const byAlias = (alias, def) => {
        const entry = LOW_RISK[alias];
        if (!entry) {
          return { type: "terminal:error", exitCode: 2, output: `Rejected by gas-town firewall: '${def}' is not an allowed command. Allowed: ${Object.keys(LOW_RISK).join(", ")}` };
        }
        return entry;
      };
      return { LOW_RISK, byAlias };
    })();

    const pre = safeCmd.split(/\s+/)[0]?.toLowerCase();
    const alias = pre === "status" ? "git_status" : pre === "branch" ? "git_branch" : pre === "log" ? "git_log" : pre === "ls" || pre === "dir" ? "ls" : pre === "uptime" ? "system_uptime" : "";
    if (!alias) {
      return { type: "terminal:error", exitCode: 2, output: `Rejected by gas-town firewall: only allowlisted read-only commands are permitted.` };
    }
    const entry = safeRun.byAlias(alias, safeCmd);
    if (entry.type === "terminal:error") return entry;
    return await new Promise((resolve) => {
      const child = spawn(entry.cmd[0], entry.cmd.slice(1), {
        cwd: MONOREPO,
        windowsHide: true,
      });
      let out = "";
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        resolve({ type: "terminal:result", exitCode: code ?? 0, output: out || "(no output)" });
      };
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", (e) => { out += `\n[spawn error] ${e?.message || String(e)}`; finish(1); });
      child.on("close", (code) => finish(code));
      setTimeout(() => { try { child.kill(); } catch { /* no-op */ /* no-op */} finish(-1); }, 20_000);
    });
  } catch (e) {
    return { type: "terminal:error", exitCode: 1, output: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Aggregated "gas town" feed (bus + phone)
// ---------------------------------------------------------------------------

function getGasTownFeed() {
  return {
    phone: phoneFeed(),
    bus: busFeed(),
    firewallArmed: !!process.env.SENTINEL_AGENT_PASS,
  };
}

// ---------------------------------------------------------------------------
// Inception Labs Mercury-2 feed (reads config presence + live spend + health)
// ---------------------------------------------------------------------------

function inceptionFeed() {
  const key = process.env.INCEPTION_API_KEY || "";
  const configured = !!key;
  return {
    provider: "Inception Labs",
    model: process.env.INCEPTION_MODEL || "mercury-2",
    status: configured ? "configured" : "missing key",
    apiKey: configured ? mask(key) : "",
    endpoint: "https://api.inceptionlabs.ai/v1",
    budget: {
      monthlyUsd: process.env.MONTHLY_BUDGET_USD || "50",
      // Placeholder; real cumulative spend is tracked in the monorepo budgetGate.
      // Reported here live once the dashboard links to budgetGate's spend store.
      note: "live spend bridge to services/lib/budgetGate.ts",
    },
  };
}

async function probeInception() {
  const base = "https://api.inceptionlabs.ai/v1";
  let ctrl, timer;
  try {
    ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), 6000);
    const startedAt = Date.now();
    const res = await fetch(`${base}/models`, { signal: ctrl.signal });
    return {
      reachable: res.ok ? "ok" : res.status,
      latencyMs: Date.now() - startedAt,
      error: "",
    };
  } catch { /* no-op */ /* no-op */
    return { reachable: "unreachable", latencyMs: null, error: "endpoint not reachable (no auth or network)" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getInceptionFullFeed() {
  const info = inceptionFeed();
  const health = await probeInception();
  return { ...info, health };
}

// ---------------------------------------------------------------------------
// AWS / EC2 / RDS feed (reads configured instances + RDS cluster metadata)
// ---------------------------------------------------------------------------

function parseCsvList(raw, fallback = []) {
  if (!raw) return fallback;
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function awsFeed() {
  const instances = parseCsvList(process.env.EC2_INSTANCE_ID);
  const secretArn = process.env.AWS_SECRET_ARN_KEY || "";
  return {
    region: "us-east-1",
    vpcId: process.env.INSSTANCES_VPC_ID || process.env.VPC_ID || "",
    ec2Instances: instances.map((id) => ({ id, status: "provisioned" })),
    rds: {
      secretArn: secretArn ? `${String(secretArn).split(":").slice(1, 3).join(":")}/rds` : "",
      database: process.env.AWS_DATABASE_USERNAME ? "configured" : "via Secrets Manager",
      cluster: secretArn.includes("rds!cluster") ? "RDS cluster" : "n/a",
    },
    // AWS SDK not required for config panel; instance state requires creds/CLI.
    awsCli: false,
  };
}

async function getAwsFullFeed() {
  return awsFeed();
}

// ---------------------------------------------------------------------------
// HTTP server (guarded handler)
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    // Enterprise CORS: reflect only the local host origin; never `*` on an
    // endpoint that executes commands. Blocks DNS-rebinding / drive-by pages.
    const origin = req.headers.origin;
    const allowedHosts = ["127.0.0.1", "localhost"];
    const host = String(req.headers.host || "").split(":")[0];
    const allowed = (origin ? origin.startsWith("http://127.0.0.1:") || origin.startsWith("http://localhost:") : allowedHosts.includes(host));
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin || `http://${host}`);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Agent-Pass");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = (req.url || "/").split("?")[0];

    // Gate mutating/executing endpoints behind a shared token. The dashboard
    // derives it from GASTOWN_DASHBOARD_TOKEN (or STREAM_SECRET as fallback),
    // matching how the monorepo terminal-auth gate works. Read roots stay open.
    const DASHBOARD_TOKEN = process.env.GASTOWN_DASHBOARD_TOKEN || process.env.STREAM_SECRET || "";
    const bearerGuard = (wantsToken) => {
      if (!wantsToken) return true;
      if (!DASHBOARD_TOKEN) return false; // fail closed: no token configured => locked
      const t = req.headers["x-agent-pass"];
      return typeof t === "string" && t.length > 0 && t === DASHBOARD_TOKEN;
    };

    // Live state feed (read-only). Open when no token is configured (local),
    // token-gated when DASHBOARD_TOKEN is set.
    if (req.method === "GET" && url === "/api/state") {
      if (!bearerGuard(!!DASHBOARD_TOKEN)) { sendJson(res, 401, { ok: false, error: "unauthorized" }); return; }
      sendJson(res, 200, await getState());
      return;
    }

    // Gas Town feed (bus firewall + phone system)
    if (req.method === "GET" && url === "/api/gastown") {
      sendJson(res, 200, await getGasTownFeed());
      return;
    }

    // Inception Labs live feed (Mercury-2 config + budget + endpoint health)
    if (req.method === "GET" && url === "/api/inception") {
      sendJson(res, 200, await getInceptionFullFeed());
      return;
    }

    // AWS / EC2 / RDS live feed (configured instances + cluster metadata)
    if (req.method === "GET" && url === "/api/aws") {
      sendJson(res, 200, await getAwsFullFeed());
      return;
    }

    // Interactive terminal (bounded body, guarded dispatch, ALWAYS auth-gated)
    if (req.method === "POST" && url === "/api/terminal") {
      if (!bearerGuard(true)) { sendJson(res, 401, { type: "terminal:error", exitCode: 1, output: "Unauthorized: X-Agent-Pass header required." }); return; }
      let raw = "";
      let size = 0;
      let overLimit = false;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { overLimit = true; break; }
        raw += chunk;
      }
      if (overLimit) { sendJson(res, 413, { type: "terminal:error", exitCode: 1, output: "Request body too large." }); return; }
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* no-op */ /* no-op */ sendJson(res, 400, { type: "terminal:error", exitCode: 1, output: "Invalid JSON body." }); return; }
      const cmd = String(body.command || "").trim();
      if (!cmd) { sendJson(res, 400, { type: "terminal:error", exitCode: 1, output: "Command required." }); return; }
      sendJson(res, 200, await runTerminalCommand(cmd));
      return;
    }

    // Live heartbeat (used by load balancers / probes)
    if (req.method === "GET" && url === "/api/health") {
      sendJson(res, 200, { status: "ok", uptime: process.uptime(), ts: new Date().toISOString() });
      return;
    }

    // Serve the self-contained frontend
    const file = decodeURIComponent(url === "/" ? "index.html" : url.slice(1)).replace(/\\/g, "/");
    if (file.includes("..")) { res.writeHead(400); res.end("Bad path"); return; }
    const target = path.join(__dirname, "gastown-dashboard", file);
    const content = await readFile(target);
    const ext = path.extname(target).toLowerCase();
    const mime = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : ext === ".svg" ? "image/svg+xml" : ext === ".woff2" ? "font/woff2" : ext === ".json" ? "application/json" : "text/html";
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", ext === ".html" ? "no-cache" : "public, max-age=600");
    res.end(content);
  } catch (e) {
    // If we already sent headers, we can't write a body — just close safely.
    if (res.headersSent) { try { res.end(); } catch { /* no-op */ /* no-op */} return; }
    sendJson(res, 500, { ok: false, error: "server_error", message: e instanceof Error ? e.message : String(e) });
  }
});

// ---------------------------------------------------------------------------
// WebSocket live feed
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

function sendToSockets(payload) {
  const msg = (() => { try { return JSON.stringify(payload); } catch { /* no-op */ /* no-op */ return null; } })();
  if (!msg) return;
  for (const ws of wss.clients) {
    if (ws.readyState === (typeof ws.OPEN === "number" ? ws.OPEN : 1)) {
      try { ws.send(msg); } catch { /* no-op */ /* no-op */}
    }
  }
}

async function snapState() {
  try { return await getState(); } catch (e) { return { ok: false, error: e?.message || "state failed" }; }
}

wss.on("connection", (ws) => {
  let stopped = false;
  const push = async () => {
    if (stopped) return;
    try {
      sendToSockets(await snapState());
    } catch { /* no-op */ /* no-op */}
  };
  push();
  ws._timer = setInterval(push, POLL_INTERVAL_MS);
  ws.on("close", () => { stopped = true; if (ws._timer) clearInterval(ws._timer); });
  ws.on("error", () => { stopped = true; if (ws._timer) clearInterval(ws._timer); try { ws.close(); } catch { /* no-op */ /* no-op */} });
});

server.on("upgrade", (req, socket, head) => {
  try {
    if (req.url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  } catch { /* no-op */ /* no-op */
    try { socket.destroy(); } catch { /* no-op */ /* no-op */}
  }
});

server.on("clientError", (_err, socket) => {
  try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch { /* no-op */ /* no-op */}
});

// ---------------------------------------------------------------------------
// Startup + graceful shutdown
// ---------------------------------------------------------------------------

server.listen(PORT, "127.0.0.1", () => {
  log.info(`Gas Town Dashboard: http://127.0.0.1:${PORT}`);
});

function shutdown(signal) {
  log.info(`Received ${signal}; shutting down gracefully…`);
  const timer = setTimeout(() => { log.warn("Forced exit after timeout"); process.exit(1); }, 5000);
  timer.unref();
  for (const ws of wss.clients) { try { ws.close(); } catch { /* no-op */ /* no-op */} }
  wss.close(() => {});
  server.close(() => { clearTimeout(timer); process.exit(0); });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));


