/**
 * hermes-execution.mjs — HERMES execution evidence store.
 *
 * Records every structured HERMES tool execution (allowed, denied, or failed)
 * for the Control Room HERMES Execution panel. Persisted locally; no new DB.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "../config.js";

const FILE = path.join(MEMORY_DIR, "local-hermes-executions.json");

async function load() {
  try {
    const d = JSON.parse(await readFile(FILE, "utf8"));
    return d.executions || [];
  } catch {
    return [];
  }
}

/** Record one HERMES execution. Non-fatal on storage error. */
export async function recordHermesExecution(rec) {
  if (!rec || !rec.tool) return null;
  const all = await load();
  const entry = {
    ts: new Date().toISOString(),
    taskId: rec.taskId || null,
    tool: rec.tool,
    decision: rec.decision || "deny",
    success: rec.success,
    verification: rec.verification || "failed",
    reason: rec.reason || null,
  };
  all.push(entry);
  try {
    await writeFile(FILE, JSON.stringify({ version: 1, executions: all.slice(-500) }, null, 2));
  } catch {
    // non-fatal
  }
  return entry;
}

export async function listHermesExecutions() {
  return load();
}

/** Aggregate HERMES execution stats for the Control Room. */
export async function hermesExecutionStats() {
  const all = await load();
  if (!all.length) return { observed: 0, collecting: true };
  const allowed = all.filter((e) => e.decision === "allow").length;
  const denied = all.filter((e) => e.decision === "deny").length;
  const failed = all.filter((e) => e.decision === "allow" && !e.success).length;
  const tools = {};
  for (const e of all) tools[e.tool] = (tools[e.tool] || 0) + 1;
  return {
    observed: all.length,
    collecting: false,
    allowed,
    denied,
    failed,
    successRate: +(allowed ? (allowed - failed) / allowed : 0).toFixed(3),
    topTools: Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}
