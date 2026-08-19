import { createServer } from "node:http";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY_FILE, AGENT_DIR, PROVIDER, LOCAL_MODEL, providerLabel, WORKSPACE, MONTHLY_BUDGET_USD, RATE_LIMIT_PER_MINUTE, GEMINI_MODEL, GROK_MODEL, DEEPSEEK_MODEL, GEMINI_API_KEY, XAI_API_KEY, DEEPSEEK_API_KEY } from "./src/config.js";
import { getCostSnapshot, COST_TTL_MS, COST_COOLDOWN_MS } from "./cost-cache.mjs";
import { getState as getAgentState, setOvernightMode, transition } from "./src/mesh/agent-state.mjs";
import { listTasks, enqueue } from "./src/mesh/task-queue.mjs";
import { runOvernightSession, getLatestSession } from "./src/mesh/overnight-runner.mjs";
import { listLearnings } from "./src/mesh/learning.mjs";
import { listEvaluations } from "./src/mesh/evaluation.mjs";
import { routingIntelligence, suggestModel, routingDecision, listRoutingDecisions, recordRoutingDecision, taskTypeStats } from "./src/mesh/routing.mjs";
import { getLatestBenchmark, runBenchmark } from "./src/mesh/benchmark.mjs";
import { providerTelemetry } from "./src/mesh/provider-telemetry.mjs";
import { runHermesTask } from "./src/mesh/hermes-bridge.mjs";
import { hermesExecutionStats, listHermesExecutions } from "./src/mesh/hermes-execution.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.DASHBOARD_PORT || 4173);
const TASKS_FILE = path.join(root, "dashboard", "tasks.json");
const AUDIT_FILE = path.join(root, "dashboard", "audit.log");
const TEST_SPECS_FILE = path.join(AGENT_DIR, "memory", "test-specs.json");
const REGRESSIONS_FILE = path.join(AGENT_DIR, "memory", "regressions.json");
const METRICS_FILE = path.join(AGENT_DIR, "memory", "metrics.json");

// ── Enterprise access control ───────────────────────────────────────────────
// RBAC (viewer/operator/admin), API keys, rate limiting, CSRF.
// DASHBOARD_AUTH=false disables auth for single-operator local testing.
const AUTH_ENABLED = !["false", "0", "off"].includes(String(process.env.DASHBOARD_AUTH || "").toLowerCase());
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };
const ROLE_PASSWORDS = {
  admin: process.env.DASHBOARD_ADMIN_PASSWORD || null,
  operator: process.env.DASHBOARD_PASSWORD || null,
  viewer: process.env.DASHBOARD_VIEWER_PASSWORD || null,
};
const API_KEY = process.env.DASHBOARD_API_KEY || null;

// If no operator password is set, generate one for the user and display it on startup.
let GENERATED_DASHBOARD_PASSWORD = null;
if (!process.env.DASHBOARD_PASSWORD) {
  GENERATED_DASHBOARD_PASSWORD = randomBytes(6).toString('base64url');
  ROLE_PASSWORDS.operator = GENERATED_DASHBOARD_PASSWORD;
}
const API_KEY_ROLE = ROLE_RANK[process.env.DASHBOARD_API_KEY_ROLE] ? process.env.DASHBOARD_API_KEY_ROLE : "operator";
const SESSION_SECRET = randomBytes(32).toString("hex");
const SESSION_TTL = 12 * 3600 * 1000;

function sessionToken(exp, role) {
  const sig = createHmac("sha256", SESSION_SECRET).update(`${exp}.${role}`).digest("base64url");
  return `${exp}.${role}.${sig}`;
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || "";
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function sessionRole(req) {
  const tok = parseCookies(req).kudbee_session;
  if (!tok) return null;
  const [exp, role, sig] = tok.split(".");
  if (!exp || !role || !sig) return null;
  const expected = createHmac("sha256", SESSION_SECRET).update(`${exp}.${role}`).digest("base64url");
  let ok = false;
  try { ok = timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { /* no-op */ /* no-op */ return null; }
  if (!ok || Number(exp) < Date.now()) return null;
  return ROLE_RANK[role] ? role : null;
}
function apiKeyRole(req) {
  const h = req.headers["authorization"] || "";
  const k = h.startsWith("Bearer ") ? h.slice(7) : (req.headers["x-api-key"] || "");
  if (API_KEY && k) {
    try { if (timingSafeEqual(Buffer.from(k), Buffer.from(API_KEY))) return API_KEY_ROLE; } catch { /* no-op */ /* no-op */}
  }
  return null;
}
function currentRole(req) {
  if (!AUTH_ENABLED) return "admin";
  return apiKeyRole(req) || sessionRole(req);
}
function authorized(req, minRole) {
  const r = currentRole(req);
  if (!r) return { ok: false, code: 401, role: null };
  if (ROLE_RANK[r] < ROLE_RANK[minRole]) return { ok: false, code: 403, role: r };
  return { ok: true, code: 200, role: r };
}

// CSRF tokens for cookie-authenticated state-changing requests (API-key auth skips).
const CSRF = new Map();
function issueCsrf(tok) { const t = randomBytes(16).toString("hex"); CSRF.set(tok, t); return t; }
function checkCsrf(req, tok) {
  const c = CSRF.get(tok);
  if (!c) return false;
  const h = req.headers["x-csrf-token"] || "";
  try { return timingSafeEqual(Buffer.from(h), Buffer.from(c)); } catch { /* no-op */ /* no-op */ return false; }
}

// Simple per-IP rate limiter (in-memory, sliding window).
const RATE = new Map();
function rateLimit(req, limit = 300, windowMs = 60000) {
  const ip = req.socket.remoteAddress || "local";
  const now = Date.now();
  const e = RATE.get(ip) || { count: 0, reset: now + windowMs };
  if (now > e.reset) { e.count = 0; e.reset = now + windowMs; }
  e.count++;
  RATE.set(ip, e);
  if (RATE.size > 10000) RATE.clear();
  return e.count <= limit;
}

// Endpoint → minimum role.
const ENDPOINT_ROLE = {
  "/api/state": "viewer", "/api/status": "viewer", "/api/metrics": "viewer",
  "/api/audit": "viewer", "/api/github": "viewer",
  "/api/ops": "operator", "/api/tasks": "operator", "/api/terminal": "operator",
  "/api/phi4": "operator", "/api/metrics/clear": "operator",
  "/api/cost": "viewer", "/api/cost/refresh": "operator",
  "/api/local-agent/status": "viewer", "/api/local-agent/tasks": "viewer", "/api/local-agent/session": "viewer", "/api/local-agent/learning": "viewer",
  "/api/local-agent/routing": "viewer", "/api/local-agent/evaluations": "viewer", "/api/local-agent/benchmark": "viewer", "/api/local-agent/telemetry": "viewer", "/api/local-agent/adaptive": "viewer",
  "/api/local-agent/arm": "operator", "/api/local-agent/stop": "operator", "/api/local-agent/run": "operator", "/api/local-agent/benchmark/run": "operator", "/api/local-agent/routing/decide": "operator",
  "/api/hermes/status": "viewer", "/api/hermes/execute": "operator",
};
function endpointMinRole(url) {
  if (url.startsWith("/api/export/")) return "viewer";
  if (url.startsWith("/api/learning/")) return "operator";
  return ENDPOINT_ROLE[url] || "viewer";
}

// ── Audit console.log(append-only governance trace) ───────────────────────────────
// Throttle low-value auto-refresh audits (e.g. ops.check every 60s) so the
// governance trace stays readable instead of flooding with noise.
let lastOpsAuditAt = 0;
async function audit(action, actor = "operator", detail = "") {
  const line = `${new Date().toISOString()} | ${action} | ${actor} | ${String(detail).slice(0, 200)}`;
  try { await appendFile(AUDIT_FILE, line + "\n"); } catch { /* no-op */ /* no-op */}
}
async function readAudit(limit = 100) {
  try {
    const txt = await readFile(AUDIT_FILE, "utf8");
    return txt.trim().split("\n").filter(Boolean).slice(-limit).reverse();
  } catch { /* no-op */ /* no-op */ return []; }
}

// ── Metrics history (bounded, append-only) ─────────────────────────────────
async function readMetrics(limit = 500) {
  try {
    const m = JSON.parse((await readFile(METRICS_FILE, "utf8")).replace(/^\uFEFF/, ""));
    return (m.metrics || []).slice(-limit);
  } catch { /* no-op */ /* no-op */ return []; }
}
async function recordMetric(snapshot) {
  const m = await readMetrics(500);
  m.push(snapshot);
  await writeFile(METRICS_FILE, JSON.stringify({ version: 1, metrics: m.slice(-500) }, null, 2));
}

// ── Shared helpers ─────────────────────────────────────────────────────────
function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:");
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function readTasks() {
  try { return JSON.parse(await readFile(TASKS_FILE, "utf8")); } catch { /* no-op */ /* no-op */ return []; }
}
async function readJson(file, key) {
  try {
    const data = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    return key ? (data[key] || []) : data;
  } catch { /* no-op */ /* no-op */ return []; }
}
async function jsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function quickPhi4() {
  try {
    const r = await fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return (j.data || []).some((m) => String(m.id).includes("phi-4-mini")) ? "online" : "no-model";
  } catch { /* no-op */ /* no-op */ return "offline"; }
}
async function quickRedis() {
  try {
    const base = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
    const r = await fetch(base + "/dbsize", { headers: { Authorization: "Bearer " + (process.env.UPSTASH_REDIS_REST_TOKEN || "") }, signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    return j.error ? "error" : `ok (${j.result ?? "?"} keys)`;
  } catch { /* no-op */ /* no-op */ return "unreachable"; }
}

async function computeAlerts() {
  const metrics = await readMetrics(1);
  const last = metrics[metrics.length - 1];
  const alerts = [];
  if (last) {
    if (last.phi4 === false) alerts.push({ level: "warn", msg: "Phi-4 offline" });
    if (last.github === false) alerts.push({ level: "warn", msg: "GitHub connector absent" });
    if (last.redis === false) alerts.push({ level: "warn", msg: "Redis unreachable" });
    if (last.postgres === false) alerts.push({ level: "warn", msg: "Postgres absent" });
    if (last.knowledge === false) alerts.push({ level: "error", msg: "Knowledge audit FAIL" });
    const budgetUsd = Number(MONTHLY_BUDGET_USD || 0);
    if (last.cost != null && budgetUsd > 0 && last.cost >= budgetUsd * 0.8) {
      alerts.push({ level: "error", msg: `Cost $${last.cost.toFixed(2)} >= 80% of budget $${budgetUsd}` });
    }
  }
  return alerts;
}

async function getState(req) {
  let memory = { learnings: [], health: [], optimizations: [] };
  try {
    memory = JSON.parse((await readFile(MEMORY_FILE, "utf8")).replace(/^\uFEFF/, ""));
  } catch { /* no-op */ /* no-op */}

  const learnings = memory.learnings || [];
  const health = memory.health || memory.healthReports || [];
  const optimizations = memory.optimizations || [];
  const tasks = await readTasks();
  const spendUsd = (memory.spend_usd && Number(memory.spend_usd)) || 0;
  const budgetUsd = Number(MONTHLY_BUDGET_USD || 0);
  const spendPercent = budgetUsd > 0 ? Math.round((spendUsd / budgetUsd) * 100) : 0;
  const rateLimitUsage = { used_per_minute: (tasks.length || 0), limit_per_minute: Number(RATE_LIMIT_PER_MINUTE || 0) };
  const agentHealth = memory.health || {};
  return {
    provider: PROVIDER,
    providerLabel: providerLabel(),
    model: LOCAL_MODEL,
    workspace: WORKSPACE,
    memory: {
      learnings: learnings.length,
      healthReports: health.length,
      optimizations: optimizations.length,
      latestLearning: learnings.at(-1) || null,
    },
    cache: {
      status: learnings.length ? "warm" : "cold",
      entries: learnings.length,
      source: "agent/memory/learnings.json",
    },
    fuel_status: {
      spend_usd: spendUsd,
      budget_usd: budgetUsd,
      spend_percent: spendPercent,
      rate_limit: rateLimitUsage,
      agent_health: agentHealth
    },
    handoff: {
      local: { status: "available", label: "LM Studio / Qwen3" },
      gemini: { status: process.env.GEMINI_API_KEY ? "configured" : "needs key", label: "Gemini" },
      grok: { status: process.env.XAI_API_KEY ? "configured" : "needs key", label: "Grok" },
    },
    tasks,
    repo: { name: path.basename(WORKSPACE), branch: "local workspace", source: "filesystem" },
    learning: await getLearningState(),
    auth: { enabled: AUTH_ENABLED, roles: Object.keys(ROLE_RANK), currentRole: currentRole(req), passwordSet: !!process.env.DASHBOARD_PASSWORD },
    alerts: await computeAlerts(),
  };
}

async function getLearningState() {
  const learnings = (await readJson(MEMORY_FILE, "learnings"));
  const testSpecs = await readJson(TEST_SPECS_FILE, "specs");
  const regressions = await readJson(REGRESSIONS_FILE, "regressions");

  const lifecycle = { DRAFT: 0, VERIFIED: 0, ACTIVE: 0, STALE: 0, SUPERSEDED: 0, ARCHIVED: 0 };
  for (const l of learnings) {
    const s = l.status || "DRAFT";
    lifecycle[s] = (lifecycle[s] || 0) + 1;
  }

  const prov = { traceId: 0, evidenceId: 0, outcomeId: 0, thinkTokenId: 0 };
  for (const l of learnings) {
    if (l.traceId) prov.traceId++;
    if (l.evidenceId) prov.evidenceId++;
    if (l.outcomeId) prov.outcomeId++;
    if (l.thinkTokenId) prov.thinkTokenId++;
  }

  return {
    learnings: learnings.length,
    lifecycle,
    provenance: prov,
    testSpecs: testSpecs.map((s) => ({
      testId: s.testId, learningId: s.learningId, taskType: s.taskType || null,
      input: s.input, expectedBehavior: s.expectedBehavior, createdAt: s.createdAt,
    })),
    regressions: regressions.map((r) => ({
      regressionId: r.regressionId, learningId: r.learningId, failure: r.failure,
      provider: r.provider || null, model: r.model || null, createdAt: r.createdAt,
    })),
  };
}

const server = createServer(async (req, res) => {
  securityHeaders(res);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = req.url.split("?")[0];

  // ── Public: login/logout ────────────────────────────────────────────────
  if (req.method === "POST" && url === "/api/login") {
    const body = await jsonBody(req);
    const pw = String(body.password || "");
    let role = null;
    for (const [r, p] of Object.entries(ROLE_PASSWORDS)) {
      if (p && pw.length > 0 && pw === p) { role = r; break; }
    }
    await audit(role ? "login.success" : "login.failed", role || "unknown", role || "bad password");
    if (!role) { json(res, 401, { ok: false, error: "invalid password" }); return; }
    const exp = Date.now() + SESSION_TTL;
    const tok = sessionToken(exp, role);
    const csrf = issueCsrf(tok);
    res.setHeader("Set-Cookie", [
      `kudbee_session=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`,
      `kudbee_csrf=${csrf}; SameSite=Strict; Path=/`,
    ].join(", "));
    json(res, 200, { ok: true, role });
    return;
  }
  if (req.method === "POST" && url === "/api/logout") {
    res.setHeader("Set-Cookie", [
      "kudbee_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      "kudbee_csrf=; SameSite=Strict; Path=/; Max-Age=0",
    ].join(", "));
    await audit("logout", currentRole(req) || "operator");
    json(res, 200, { ok: true });
    return;
  }

  // ── Protected API: rate limit + RBAC + CSRF ─────────────────────────────
  if (url.startsWith("/api/")) {
    if (!rateLimit(req)) { json(res, 429, { ok: false, error: "rate limited" }); return; }
    const minRole = endpointMinRole(url);
    const a = authorized(req, minRole);
    if (!a.ok) { json(res, a.code, { ok: false, error: a.code === 403 ? "forbidden" : "unauthorized" }); return; }
    // CSRF required for cookie-authenticated writes (API-key auth skips).
    // Only enforced when auth is enabled — with DASHBOARD_AUTH=false (single-
    // operator local testing) there is no session cookie to protect, so POSTs
    // must not be blocked by a missing CSRF token.
    if (AUTH_ENABLED && req.method === "POST" && !apiKeyRole(req)) {
      const tok = parseCookies(req).kudbee_session;
      if (!tok || !checkCsrf(req, tok)) { json(res, 403, { ok: false, error: "csrf token required" }); return; }
    }
    req.role = a.role;
  }

  if (req.method === "POST" && url === "/api/tasks") {
    const body = await jsonBody(req);
    const tasks = await readTasks();
    const task = { id: crypto.randomUUID(), title: String(body.title || "Untitled task").slice(0, 160), status: "queued", owner: "trust-agent", createdAt: new Date().toISOString() };
    tasks.unshift(task); await writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2));
    await audit("task.create", "operator", task.title);
    json(res, 200, task); return;
  }
  if (req.method === "POST" && url === "/api/terminal") {
    const body = await jsonBody(req);
    const command = String(body.command || "").trim();
    if (!command) { res.writeHead(400); res.end("Command required"); return; }
    await audit("terminal.command", "operator", command);
    res.setHeader("Content-Type", "application/x-ndjson");
    // cmd.exe avoids the PowerShell execution-policy block on npm.ps1.
    const child = spawn("cmd.exe", ["/c", command], { cwd: WORKSPACE, windowsHide: true });
    child.stdout.on("data", data => res.write(JSON.stringify({ stream: "out", text: data.toString() }) + "\n"));
    child.stderr.on("data", data => res.write(JSON.stringify({ stream: "err", text: data.toString() }) + "\n"));
    child.on("close", code => { res.write(JSON.stringify({ stream: "exit", code }) + "\n"); res.end(); }); return;
  }
  if (url === "/api/state") {
    json(res, 200, await getState(req)); return;
  }
  if (url === "/api/audit") {
    json(res, 200, { entries: await readAudit() }); return;
  }
  if (url === "/api/metrics") {
    json(res, 200, { metrics: await readMetrics() }); return;
  }
  if (req.method === "POST" && url === "/api/metrics/clear") {
    await writeFile(METRICS_FILE, JSON.stringify({ version: 1, metrics: [] }, null, 2));
    await audit("metrics.clear", req.role || "operator");
    json(res, 200, { ok: true });
    return;
  }
  // Cached AWS cost snapshot (GET) — never calls Cost Explorer directly.
  if (url === "/api/cost") {
    const s = await getCostSnapshot();
    json(res, 200, {
      ok: true,
      cost: s,
      ttlMs: COST_TTL_MS,
      cooldownMs: COST_COOLDOWN_MS,
    });
    return;
  }
  // Manual Cost Explorer refresh (POST) — operator role, CSRF, 15 min cooldown.
  if (req.method === "POST" && url === "/api/cost/refresh") {
    const s = await getCostSnapshot({ force: true });
    if (s.throttled) {
      json(res, 429, { ok: false, error: "cost refresh throttled", retryAfterMs: s.retryAfterMs, cost: s });
      return;
    }
    await audit("cost.refresh", req.role || "operator", s.status === "fresh" ? "fresh" : "stale");
    json(res, 200, { ok: true, cost: s });
    return;
  }
  // Local autonomous agent — status / tasks / session (read-only).
  if (url === "/api/local-agent/status") {
    json(res, 200, { ok: true, state: await getAgentState() });
    return;
  }
  if (url === "/api/local-agent/tasks") {
    if (req.method === "POST") {
      if ((req.role ? ROLE_RANK[req.role] : 0) < ROLE_RANK.operator) { json(res, 403, { ok: false, error: "forbidden" }); return; }
      const body = await jsonBody(req);
      const description = String(body.description || "").trim();
      if (!description) { json(res, 400, { ok: false, error: "description required" }); return; }
      const task = await enqueue({ description, maxIterations: body.maxIterations || 3 });
      await audit("local-agent.task", req.role || "operator", description.slice(0, 80));
      json(res, 200, { ok: true, task });
      return;
    }
    json(res, 200, { ok: true, tasks: await listTasks() });
    return;
  }
  if (url === "/api/local-agent/session") {
    json(res, 200, { ok: true, session: await getLatestSession() });
    return;
  }
  if (url === "/api/local-agent/learning") {
    json(res, 200, { ok: true, learnings: await listLearnings() });
    return;
  }
  // Routing intelligence + evaluation dataset (read-only, observation layer).
  if (url === "/api/local-agent/routing") {
    json(res, 200, { ok: true, routing: await routingIntelligence() });
    return;
  }
  if (url === "/api/local-agent/evaluations") {
    json(res, 200, { ok: true, evaluations: await listEvaluations() });
    return;
  }
  if (url === "/api/local-agent/benchmark") {
    json(res, 200, { ok: true, benchmark: await getLatestBenchmark() });
    return;
  }
  // Run a bounded benchmark (operator). Gemini is opt-in and bounded; the
  // default runs Phi-4 only so a stray click never spends cloud budget.
  if (req.method === "POST" && url === "/api/local-agent/benchmark/run") {
    const body = await jsonBody(req);
    const models = Array.isArray(body.models) ? body.models.filter((m) => m === "phi4" || m === "gemini") : ["phi4"];
    const maxTasks = Math.min(Number(body.maxTasks) || 2, 5);
    if (models.includes("gemini") && !process.env.GEMINI_API_KEY) {
      json(res, 400, { ok: false, error: "gemini not configured" });
      return;
    }
    await audit("local-agent.benchmark", req.role || "operator", `models=${models.join("+")} tasks=${maxTasks}`);
    const r = await runBenchmark({ models, maxTasks });
    json(res, 200, { ok: true, ...r });
    return;
  }
  // Provider telemetry + adaptive routing observability (read-only).
  if (url === "/api/local-agent/telemetry") {
    json(res, 200, { ok: true, telemetry: await providerTelemetry() });
    return;
  }
  if (url === "/api/local-agent/adaptive") {
    const [routing, telemetry, decisions] = await Promise.all([
      routingIntelligence(), providerTelemetry(), listRoutingDecisions(),
    ]);
    json(res, 200, { ok: true, routing, telemetry, decisions: decisions.slice(-10).reverse() });
    return;
  }
  // Adaptive routing decision for a task type (recommendation only — no model call).
  if (req.method === "POST" && url === "/api/local-agent/routing/decide") {
    const body = await jsonBody(req);
    const taskType = String(body.taskType || "").trim();
    if (!taskType) { json(res, 400, { ok: false, error: "taskType required" }); return; }
    const costStatus = String(body.costStatus || "UNKNOWN").toUpperCase();
    const allowEscalation = body.allowEscalation === true;
    const decision = await routingDecision(taskType, { costStatus, allowEscalation });
    await recordRoutingDecision(decision);
    await audit("local-agent.routing-decision", req.role || "operator", `${taskType} -> ${decision.selectedModel} (${decision.reason})`);
    json(res, 200, { ok: true, decision });
    return;
  }
  // HERMES execution seam — status (read-only) + structured tool execution.
  if (url === "/api/hermes/status") {
    json(res, 200, { ok: true, stats: await hermesExecutionStats(), recent: (await listHermesExecutions()).slice(-10).reverse() });
    return;
  }
  if (req.method === "POST" && url === "/api/hermes/execute") {
    const body = await jsonBody(req);
    const task = {
      taskId: body.taskId || `hermes-${Date.now()}`,
      tool: body.tool,
      arguments: body.arguments || {},
      agentId: "hermes",
      risk: body.risk || "L0",
    };
    const r = await runHermesTask(task);
    await audit("hermes.execute", req.role || "operator", `${task.tool} -> ${r.decision} (${r.success ? "ok" : "failed"})`);
    json(res, 200, { ok: r.ok, decision: r.decision, success: r.success, reason: r.reason || null, evidence: r.evidence });
    return;
  }
  // Arm / stop / run (operator, CSRF-protected).
  if (req.method === "POST" && url === "/api/local-agent/arm") {
    const st = await setOvernightMode("ARMED");
    await audit("local-agent.arm", req.role || "operator");
    json(res, 200, { ok: true, state: st });
    return;
  }
  if (req.method === "POST" && url === "/api/local-agent/stop") {
    await setOvernightMode("STOPPED");
    await transition("stopped");
    await audit("local-agent.stop", req.role || "operator");
    json(res, 200, { ok: true, state: await getAgentState() });
    return;
  }
  if (req.method === "POST" && url === "/api/local-agent/run") {
    const r = await runOvernightSession();
    await audit("local-agent.run", req.role || "operator", r.ok ? (r.session?.stopReason || "done") : (r.error || "failed"));
    if (!r.ok) { json(res, 409, { ok: false, error: r.error }); return; }
    json(res, 200, { ok: true, session: r.session });
    return;
  }
  if (url === "/api/ops") {
    try {
      const out = execFileSync("node", [path.join(root, "kudbee-status.mjs")], { encoding: "utf8", timeout: 90000, cwd: WORKSPACE });
      // Throttle the auto-refresh audit to once per 5 min (metrics still record every check).
      const now = Date.now();
      if (now - lastOpsAuditAt > 5 * 60 * 1000) { lastOpsAuditAt = now; await audit("ops.check", "operator"); }
      // Record a lightweight metric snapshot (cost + key health flags).
      const cost = (out.match(/month-to-date \$([\d.]+)/) || [])[1] || null;
      await recordMetric({
        ts: new Date().toISOString(),
        cost: cost ? parseFloat(cost) : null,
        phi4: /Phi-4 \(LM Studio\)\s+ONLINE/.test(out),
        github: /GitHub connector\s+PRESENT/.test(out),
        redis: /Redis \(Upstash\)\s+OK/.test(out),
        postgres: /Postgres \(DATABASE_URL\)\s+PRESENT/.test(out),
        knowledge: /Knowledge audit\s+PASS/.test(out),
        router: /Router\s+OFF/.test(out) ? "OFF" : "ON",
      });
      json(res, 200, { ok: true, output: out });
    } catch (e) {
      json(res, 200, { ok: false, output: (e.stdout || "") + "\n" + (e.message || "") });
    }
    return;
  }

  // Live Phi-4 inference test (local LM Studio).
  if (req.method === "POST" && url === "/api/phi4") {
    const body = await jsonBody(req);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) { json(res, 400, { ok: false, error: "prompt required" }); return; }
    const t0 = Date.now();
    try {
      const r = await fetch("http://localhost:1234/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: LOCAL_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 256, temperature: 0.2 }),
        signal: AbortSignal.timeout(240000), // local Phi-4 can be slow (warmup)
      });
      const j = await r.json();
      await audit("phi4.test", "operator", prompt.slice(0, 80));
      json(res, 200, { ok: true, reply: j.choices?.[0]?.message?.content || "", latencyMs: Date.now() - t0, usage: j.usage || null });
    } catch (e) {
      json(res, 200, { ok: false, error: "Phi-4 unavailable: " + e.message });
    }
    return;
  }
  // PR-6: generate test specs from validated learnings (bounded, deduped).
  if (req.method === "POST" && url === "/api/learning/generate-tests") {
    try {
      const out = execFileSync("node", [path.join(root, "generate-tests.mjs"), "--apply"], { encoding: "utf8", timeout: 30000, cwd: root });
      await audit("learning.generate-tests", "operator");
      json(res, 200, { ok: true, output: out });
    } catch (e) { json(res, 200, { ok: false, output: (e.stdout || "") + "\n" + e.message }); }
    return;
  }
  // PR-7: record a regression (append-only).
  if (req.method === "POST" && url === "/api/learning/record-regression") {
    const body = await jsonBody(req);
    const failure = String(body.failure || "").trim();
    if (!failure) { json(res, 400, { ok: false, error: "failure required" }); return; }
    const args = ["record-regression.mjs", "--failure", failure, "--apply"];
    if (body.learningId) args.push("--learningId", String(body.learningId));
    if (body.provider) args.push("--provider", String(body.provider));
    if (body.model) args.push("--model", String(body.model));
    try {
      const out = execFileSync("node", args, { encoding: "utf8", timeout: 30000, cwd: root });
      await audit("learning.record-regression", "operator", failure.slice(0, 80));
      json(res, 200, { ok: true, output: out });
    } catch (e) { json(res, 200, { ok: false, output: (e.stdout || "") + "\n" + e.message }); }
    return;
  }

  // Lightweight structured server + DB status (quick checks, no heavy ops).
  if (url === "/api/status") {
    const [phi4, redis] = await Promise.all([quickPhi4(), quickRedis()]);
    json(res, 200, {
      server: { dashboard: "online", phi4, provider: PROVIDER, model: LOCAL_MODEL },
      db: { redis, postgres: process.env.DATABASE_URL ? "configured" : "absent" },
      github: (process.env.GITHUB_PAT || process.env.GITHUB_TOKEN) ? "configured" : "absent",
      // Specific model/provider visibility (states only — never key values).
      models: {
        phi4: { model: LOCAL_MODEL, status: phi4 },
        gemini: { model: GEMINI_MODEL, status: GEMINI_API_KEY ? "configured" : "absent" },
        xai: { model: GROK_MODEL, status: XAI_API_KEY ? "configured" : "absent" },
        deepseek: { model: DEEPSEEK_MODEL, status: DEEPSEEK_API_KEY ? "configured" : "absent" },
      },
      ts: new Date().toISOString(),
    });
    return;
  }
  // Security posture (states only — never secret values).
  if (url === "/api/security") {
    const ingestionBoundary = process.env.KUDBEE_AUTH_BOUNDARY || (process.env.NODE_ENV === 'production' ? 'required' : 'dev-open');
    const ingestionProtected = ingestionBoundary === 'required' || process.env.NODE_ENV === 'production';
    const devOpen = process.env.KUDBEE_DEV_OPEN === 'true';
    let capability = { available: false, registryVersion: null, enforcement: null, resolutions: 0, denials: 0, missing: 0 };
    try {
      const c = await (await fetch("http://127.0.0.1:3000/api/capability", { signal: AbortSignal.timeout(4000) })).json();
      capability = { available: true, ...c };
    } catch { /* no-op */ /* no-op */ /* ingestion server unreachable — capability telemetry unavailable */ }
    json(res, 200, {
      dashboard: {
        auth: AUTH_ENABLED ? 'ENABLED' : 'DISABLED',
        rbac: AUTH_ENABLED ? 'ENABLED' : 'DISABLED',
        rateLimit: 'ACTIVE',
        csrf: AUTH_ENABLED ? 'ENABLED' : 'N/A',
        spaSession: 'ENABLED',
        audit: 'ACTIVE',
        apiKey: process.env.DASHBOARD_API_KEY ? 'CONFIGURED' : 'NOT CONFIGURED',
        credentialHygiene: 'HEALTHY',
      },
      ingestion: {
        authBoundary: ingestionBoundary,
        anonymousProtected: ingestionProtected ? 'BLOCKED' : 'OPEN',
        terminalBoundary: ingestionProtected || !devOpen ? 'BLOCKED' : 'OPEN',
        filesystemBoundary: ingestionProtected || !devOpen ? 'BLOCKED' : 'OPEN',
      },
      capability,
      ts: new Date().toISOString(),
    });
    return;
  }
  // Export / reporting (JSON download).
  if (url.startsWith("/api/export/")) {
    const type = url.slice("/api/export/".length);
    let data, filename;
    if (type === "state") { data = await getState(); filename = "kudbee-state.json"; }
    else if (type === "audit") { data = { entries: await readAudit() }; filename = "kudbee-audit.json"; }
    else if (type === "metrics") { data = { metrics: await readMetrics() }; filename = "kudbee-metrics.json"; }
    else if (type === "learnings") { data = await readJson(MEMORY_FILE, null); filename = "kudbee-learnings.json"; }
    else { json(res, 404, { ok: false, error: "unknown export type" }); return; }
    await audit("export", "operator", type);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.end(JSON.stringify(data, null, 2));
    return;
  }
  // GitHub PR stack view (read-only, token never exposed).
  if (url === "/api/github") {
    const pat = process.env.GITHUB_PAT || process.env.GITHUB_TOKEN || "";
    if (!pat) { json(res, 200, { ok: false, error: "no GitHub token configured" }); return; }
    const repos = ["KudbeeZero/testLM", "KudbeeZero/Kudbee-fuel-gage"];
    const gh = (p) => fetch(p, { headers: { Authorization: "Bearer " + pat, "User-Agent": "kudbee-agent-connector", "Accept": "application/vnd.github+json" } });
    const results = [];
    for (const repo of repos) {
      try {
        const prs = await (await gh(`https://api.github.com/repos/${repo}/pulls?state=open`)).json();
        const list = [];
        for (const pr of (Array.isArray(prs) ? prs : [])) {
          let ci = "unknown";
          try {
            const checks = await (await gh(`https://api.github.com/repos/${repo}/commits/${pr.head.sha}/check-runs`)).json();
            const cs = checks.check_runs || [];
            if (cs.length) ci = cs.every((c) => c.conclusion === "success") ? "success" : (cs.some((c) => c.conclusion === "failure") ? "failure" : "pending");
          } catch { /* no-op */ /* no-op */}
          list.push({ number: pr.number, title: pr.title, branch: pr.head.ref, base: pr.base.ref, state: pr.state, ci, created: pr.created_at });
        }
        results.push({ repo, open: list.length, prs: list });
      } catch (e) { results.push({ repo, error: e.message }); }
    }
    await audit("github.prs", "operator");
    json(res, 200, { ok: true, results });
    return;
  }

  const file = url === "/" ? "index.html" : url.slice(1);
  if (file.includes("..")) { res.writeHead(400); res.end("Bad path"); return; }
  try {
    const content = await readFile(path.join(root, "dashboard", file));
    res.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : "text/html");
    res.end(content);
  } catch { /* no-op */ /* no-op */
    res.writeHead(404); res.end("Not found");
  }
});

// WebSocket terminal — require an authenticated session on upgrade.
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => {
  // cmd.exe interactive (quiet) — npm/node/git work without the npm.ps1 block.
  const child = spawn("cmd.exe", ["/Q"], { cwd: WORKSPACE, windowsHide: true });
  ws.on("message", msg => {
    try {
      const data = typeof msg === "string" ? JSON.parse(msg) : JSON.parse(msg.toString());
      if (data && data.cmd) child.stdin.write(String(data.cmd) + "\r\n");
    } catch { /* no-op */ /* no-op */ child.stdin.write(String(msg) + "\r\n"); }
  });
  child.stdout.on("data", d => { try { ws.send(JSON.stringify({ stream: "out", text: d.toString() })); } catch { /* no-op */ /* no-op */} });
  child.stderr.on("data", d => { try { ws.send(JSON.stringify({ stream: "err", text: d.toString() })); } catch { /* no-op */ /* no-op */} });
  child.on("close", code => { try { ws.send(JSON.stringify({ stream: "exit", code })); } catch { /* no-op */ /* no-op */} ws.close(); });
  ws.on("close", () => { try { child.kill(); } catch { /* no-op */ /* no-op */} });
});
server.on("upgrade", (req, socket, head) => {
  const { url } = req;
  if (url === "/ws/terminal" && (!AUTH_ENABLED || authorized(req, "operator").ok)) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.console.log(`Agent dashboard: http://127.0.0.1:${port}`);
  if (!process.env.DASHBOARD_PASSWORD) {
    console.console.log(`Dashboard password (auto-generated): ${GENERATED_DASHBOARD_PASSWORD}`);
    console.console.log("Set DASHBOARD_PASSWORD in the environment to use your own.");
  }
});



