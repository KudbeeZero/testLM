import { createServer } from "node:http";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY_FILE, AGENT_DIR, PROVIDER, LOCAL_MODEL, providerLabel, WORKSPACE, MONTHLY_BUDGET_USD, RATE_LIMIT_PER_MINUTE } from "./src/config.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.DASHBOARD_PORT || 4173);
const TASKS_FILE = path.join(root, "dashboard", "tasks.json");
const AUDIT_FILE = path.join(root, "dashboard", "audit.log");
const TEST_SPECS_FILE = path.join(AGENT_DIR, "memory", "test-specs.json");
const REGRESSIONS_FILE = path.join(AGENT_DIR, "memory", "regressions.json");
const METRICS_FILE = path.join(AGENT_DIR, "memory", "metrics.json");

// ── Enterprise auth (session cookie, HMAC-signed) ──────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || randomBytes(16).toString("hex");
const SESSION_SECRET = randomBytes(32).toString("hex");
const SESSION_TTL = 12 * 3600 * 1000;

function sessionToken(exp) {
  const sig = createHmac("sha256", SESSION_SECRET).update(String(exp)).digest("base64url");
  return `${exp}.${sig}`;
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
function isAuthed(req) {
  const tok = parseCookies(req).kudbee_session;
  if (!tok) return false;
  const [exp, sig] = tok.split(".");
  if (!exp || !sig) return false;
  const expected = createHmac("sha256", SESSION_SECRET).update(exp).digest("base64url");
  let ok = false;
  try { ok = timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
  return ok && Number(exp) > Date.now();
}

// ── Audit log (append-only governance trace) ───────────────────────────────
async function audit(action, actor = "operator", detail = "") {
  const line = `${new Date().toISOString()} | ${action} | ${actor} | ${String(detail).slice(0, 200)}`;
  try { await appendFile(AUDIT_FILE, line + "\n"); } catch {}
}
async function readAudit(limit = 100) {
  try {
    const txt = await readFile(AUDIT_FILE, "utf8");
    return txt.trim().split("\n").filter(Boolean).slice(-limit).reverse();
  } catch { return []; }
}

// ── Metrics history (bounded, append-only) ─────────────────────────────────
async function readMetrics(limit = 500) {
  try {
    const m = JSON.parse((await readFile(METRICS_FILE, "utf8")).replace(/^\uFEFF/, ""));
    return (m.metrics || []).slice(-limit);
  } catch { return []; }
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
  try { return JSON.parse(await readFile(TASKS_FILE, "utf8")); } catch { return []; }
}
async function readJson(file, key) {
  try {
    const data = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    return key ? (data[key] || []) : data;
  } catch { return []; }
}
async function jsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function getState() {
  let memory = { learnings: [], health: [], optimizations: [] };
  try {
    memory = JSON.parse((await readFile(MEMORY_FILE, "utf8")).replace(/^\uFEFF/, ""));
  } catch {}

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
    auth: { enabled: true, passwordSet: !!process.env.DASHBOARD_PASSWORD },
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
    const ok = pw.length > 0 && pw === DASHBOARD_PASSWORD;
    await audit(ok ? "login.success" : "login.failed", "operator", ok ? "authenticated" : "bad password");
    if (!ok) { json(res, 401, { ok: false, error: "invalid password" }); return; }
    const exp = Date.now() + SESSION_TTL;
    res.setHeader("Set-Cookie", `kudbee_session=${sessionToken(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`);
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url === "/api/logout") {
    res.setHeader("Set-Cookie", "kudbee_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    await audit("logout", "operator");
    json(res, 200, { ok: true });
    return;
  }

  // ── Protected API (everything else under /api) ──────────────────────────
  if (url.startsWith("/api/") && !isAuthed(req)) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return;
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
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd: WORKSPACE, windowsHide: true });
    child.stdout.on("data", data => res.write(JSON.stringify({ stream: "out", text: data.toString() }) + "\n"));
    child.stderr.on("data", data => res.write(JSON.stringify({ stream: "err", text: data.toString() }) + "\n"));
    child.on("close", code => { res.write(JSON.stringify({ stream: "exit", code }) + "\n"); res.end(); }); return;
  }
  if (url === "/api/state") {
    json(res, 200, await getState()); return;
  }
  if (url === "/api/audit") {
    json(res, 200, { entries: await readAudit() }); return;
  }
  if (url === "/api/metrics") {
    json(res, 200, { metrics: await readMetrics() }); return;
  }
  if (url === "/api/ops") {
    try {
      const out = execFileSync("node", [path.join(root, "kudbee-status.mjs")], { encoding: "utf8", timeout: 90000, cwd: WORKSPACE });
      await audit("ops.check", "operator");
      // Record a lightweight metric snapshot (cost + key health flags).
      const cost = (out.match(/month-to-date \$([\d.]+)/) || [])[1] || null;
      await recordMetric({
        ts: new Date().toISOString(),
        cost: cost ? parseFloat(cost) : null,
        phi4: /Phi-4 \(LM Studio\)\s+ONLINE/.test(out),
        github: /GitHub connector\s+PRESENT/.test(out),
        router: /Router\s+OFF/.test(out) ? "OFF" : "ON",
      });
      json(res, 200, { ok: true, output: out });
    } catch (e) {
      json(res, 200, { ok: false, output: (e.stdout || "") + "\n" + (e.message || "") });
    }
    return;
  }

  const file = url === "/" ? "index.html" : url.slice(1);
  if (file.includes("..")) { res.writeHead(400); res.end("Bad path"); return; }
  try {
    const content = await readFile(path.join(root, "dashboard", file));
    res.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : "text/html");
    res.end(content);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
});

// WebSocket terminal — require an authenticated session on upgrade.
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], { cwd: WORKSPACE, windowsHide: true });
  ws.on("message", msg => {
    try {
      const data = typeof msg === "string" ? JSON.parse(msg) : JSON.parse(msg.toString());
      if (data && data.cmd) child.stdin.write(String(data.cmd) + "\n");
    } catch { child.stdin.write(String(msg) + "\n"); }
  });
  child.stdout.on("data", d => { try { ws.send(JSON.stringify({ stream: "out", text: d.toString() })); } catch {} });
  child.stderr.on("data", d => { try { ws.send(JSON.stringify({ stream: "err", text: d.toString() })); } catch {} });
  child.on("close", code => { try { ws.send(JSON.stringify({ stream: "exit", code })); } catch {} ws.close(); });
  ws.on("close", () => { try { child.kill(); } catch {} });
});
server.on("upgrade", (req, socket, head) => {
  const { url } = req;
  if (url === "/ws/terminal" && isAuthed(req)) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Agent dashboard: http://127.0.0.1:${port}`);
  if (!process.env.DASHBOARD_PASSWORD) {
    console.log(`Dashboard password (auto-generated): ${DASHBOARD_PASSWORD}`);
    console.log("Set DASHBOARD_PASSWORD in the environment to use your own.");
  }
});
