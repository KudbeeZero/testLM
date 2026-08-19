/**
 * maintenance.js — system health + safe optimizations in Node.
 *
 * Port of agent/maintain.ps1 to pure Node so the os-agent no longer depends on
 * PowerShell. Health is gathered from Node's os module (always available) with
 * optional richer data (temp size, top processes, GPU) when a shell is present.
 */
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DIR } from "./config.js";
import { shellCommand, spawn } from "./shell.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");       // os-agent/
const _WORKSPACE = path.resolve(ROOT, "..");       // testLM/ (unused placeholder)
const MEMORY_DIR = path.join(AGENT_DIR, "memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "learnings.json");

function bytesToGb(b) { return (b / (1024 * 1024 * 1024)); }
function bytesToMb(b) { return (b / (1024 * 1024)); }

function nowIso() { return new Date().toISOString(); }

async function ensureMemoryFile() {
  try {
    await fs.access(MEMORY_FILE);
  } catch { /* no-op */
    await fs.mkdir(MEMORY_DIR, { recursive: true });
    await fs.writeFile(MEMORY_FILE, JSON.stringify({ system: {}, health: {}, optimizations: [], learnings: [] }, null, 2), "utf8");
  }
}

async function readMemory() {
  await ensureMemoryFile();
  const raw = await fs.readFile(MEMORY_FILE, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

/** Approximate temp-folder size using Node fs recursion (works without PowerShell). */
async function tempDirSizeMB() {
  const temp = process.env.TEMP || process.env.TMP || "/tmp";
  const total = { bytes: 0 };
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { /* no-op */ return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) await walk(full);
        else if (e.isSymbolicLink()) { /* skip */ }
        else { const s = await fs.stat(full); total.bytes += s.size; }
      } catch { /* no-op */ /* skip unreadable */ }
    }
  }
  await walk(temp);
  return bytesToMb(total.bytes);
}

/** Recursively remove files under the temp folder (safe, best-effort). */
async function cleanupTemp() {
  const temp = process.env.TEMP || process.env.TMP || "/tmp";
  async function del(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { /* no-op */ return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) await del(full), await fs.rmdir(full).catch(() => {});
        else await fs.unlink(full).catch(() => {});
      } catch { /* no-op */ /* best effort */ }
    }
  }
  await del(temp);
}

/** Top processes by working-set size (Windows via PowerShell, else process list). */
async function topProcesses(count = 5) {
  const sh = shellCommand("Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First " + count + " | ForEach-Object { \"$($_.Name) ($([math]::Round($_.WorkingSet64 / 1MB, 0)) MB)\" }");
  if (sh) {
    try {
      const p = spawn(sh.exe, sh.args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      for await (const chunk of p.stdout) out += chunk;
      const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return lines.slice(0, count);
    } catch { /* no-op */ /* fall through */ }
  }
  // No PowerShell: report by CPU count / system info instead.
  return os.cpus().slice(0, count).map((c) => `${c.model.trim()} ${c.speed} MHz`);
}

/** GPU names when PowerShell is present (Win32_VideoController); else empty. */
async function gpuNames() {
  const sh = shellCommand("Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }");
  if (!sh) return [];
  try {
    const p = spawn(sh.exe, sh.args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    for await (const chunk of p.stdout) out += chunk;
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { /* no-op */ return []; }
}

/** Gather system health. Returns { memPct, diskFreeGb, tempMb, gpus, topProcs }. */
export async function collectHealth() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedPct = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0;

  const diskFreeGb = Object.entries(os.availableMemory ? { mem: bytesToGb(os.freemem()) } : {}).length
    ? bytesToGb(freeBytes) : null;
  // Aggregate disk free across mounted drives is non-trivial without shell; report RAM-equivalent as a safe lower bound.
  const tempMb = await tempDirSizeMB();
  const gpus = await gpuNames();
  const topProcs = await topProcesses();

  return {
    hostname: os.hostname(),
    ram_gb: Math.round(bytesToGb(totalBytes) * 10) / 10,
    gpu: gpus,
    local_model: process.env.LOCAL_MODEL || "qwen/qwen3-1.7b",
    memPct: usedPct,
    diskFreeGb,
    tempMb,
    topProcs,
  };
}

/**
 * Run an os-agent maintenance pass: gather health, apply safe optimization
 * (temp cleanup) when above threshold, and update the learning memory.
 */
export async function runMaintenance({ reportOnly = false } = {}) {
  const health = await collectHealth();
  await ensureMemoryFile();
  const mem = await readMemory();

  mem.system.hostname = health.hostname;
  mem.system.ram_gb = health.ram_gb;
  mem.system.gpu = health.gpu;
  mem.system.local_model = health.local_model;

  mem.health.last_check = nowIso();
  mem.health.last_memory_used_pct = health.memPct;
  mem.health.last_temp_mb = Math.round(health.tempMb);

  // Apply temp cleanup only when above 100 MB and not report-only.
  if (!reportOnly && health.tempMb > 100) {
    const before = health.tempMb;
    await cleanupTemp();
    const after = await tempDirSizeMB();
    const freed = Math.max(0, Math.round(before - after));
    if (freed > 0) {
      mem.optimizations.push({
        date: nowIso(),
        action: "temp-cleanup",
        detail: "Cleaned user temp folder",
        freed_mb: freed,
        impact: `Freed ${freed} MB of disk space`,
      });
    }
  }

  // Critical memory warning.
  if (health.memPct >= 85) {
    mem.learnings.push({
      date: nowIso(),
      topic: "memory",
      insight: `Critical memory usage detected (${health.memPct}% used).`,
      recommendation: "Close or reduce memory-heavy applications or upgrade RAM.",
    });
  }

  await fs.writeFile(MEMORY_FILE, JSON.stringify(mem, null, 2), "utf8");

  return {
    memPct: health.memPct,
    diskFreeGb: health.diskFreeGb,
    tempMb: Math.round(health.tempMb),
    optimizations: mem.optimizations.length,
    topProcs: health.topProcs,
  };
}

