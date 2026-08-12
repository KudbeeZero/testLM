import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY_FILE, PROVIDER, LOCAL_MODEL, providerLabel, WORKSPACE, MONTHLY_BUDGET_USD, RATE_LIMIT_PER_MINUTE } from "./src/config.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.DASHBOARD_PORT || 4173);
const TASKS_FILE = path.join(root, "dashboard", "tasks.json");

async function readTasks() {
  try { return JSON.parse(await readFile(TASKS_FILE, "utf8")); } catch { return []; }
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
  // Fuel / budget status (non-secret): read budget constants and memory spend if provided
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
  };
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "POST" && req.url === "/api/tasks") {
    const body = await jsonBody(req);
    const tasks = await readTasks();
    const task = { id: crypto.randomUUID(), title: String(body.title || "Untitled task").slice(0, 160), status: "queued", owner: "trust-agent", createdAt: new Date().toISOString() };
    tasks.unshift(task); await writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2));
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(task)); return;
  }
  if (req.method === "POST" && req.url === "/api/terminal") {
    const body = await jsonBody(req);
    const command = String(body.command || "").trim();
    if (!command) { res.writeHead(400); res.end("Command required"); return; }
    res.setHeader("Content-Type", "application/x-ndjson");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd: WORKSPACE, windowsHide: true });
    child.stdout.on("data", data => res.write(JSON.stringify({ stream: "out", text: data.toString() }) + "\n"));
    child.stderr.on("data", data => res.write(JSON.stringify({ stream: "err", text: data.toString() }) + "\n"));
    child.on("close", code => { res.write(JSON.stringify({ stream: "exit", code }) + "\n"); res.end(); }); return;
  }
  if (req.url === "/api/state") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(await getState()));
    return;
  }
  const file = req.url === "/" ? "index.html" : req.url.slice(1);
  if (file.includes("..")) { res.writeHead(400); res.end("Bad path"); return; }
  try {
    const content = await readFile(path.join(root, "dashboard", file));
    res.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : "text/html");
    res.end(content);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
});

// WebSocket server for interactive terminal (noServer mode; we upgrade manually)
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req) => {
  // spawn an interactive PowerShell process
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], { cwd: WORKSPACE, windowsHide: true });
  ws.on("message", msg => {
    try {
      const data = typeof msg === "string" ? JSON.parse(msg) : JSON.parse(msg.toString());
      if (data && data.cmd) {
        child.stdin.write(String(data.cmd) + "\n");
      }
    } catch (e) {
      // ignore parse errors
      child.stdin.write(String(msg) + "\n");
    }
  });
  child.stdout.on("data", d => { try { ws.send(JSON.stringify({ stream: "out", text: d.toString() })); } catch {} });
  child.stderr.on("data", d => { try { ws.send(JSON.stringify({ stream: "err", text: d.toString() })); } catch {} });
  child.on("close", code => { try { ws.send(JSON.stringify({ stream: "exit", code })); } catch {} ws.close(); });
  ws.on("close", () => { try { child.kill(); } catch {} });
});

server.on('upgrade', (req, socket, head) => {
  const { url } = req;
  if (url === '/ws/terminal') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Agent dashboard: http://127.0.0.1:${port}`);
});