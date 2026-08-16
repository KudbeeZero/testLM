/**
 * evaluation.mjs — RDTHINK evaluation records + deterministic classification.
 *
 * Produces a structured evaluation per task with deterministic failure and
 * recovery classes (the model never classifies its own failure). Also tracks
 * confidence vs verification for calibration, and accumulates a routing
 * dataset. Persisted locally (no new database).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "../config.js";

const FILE = path.join(MEMORY_DIR, "local-evaluations.json");

export const FAILURE_CLASSES = [
  "NONE", "PLANNER_INVALID_TOOL", "PLANNER_INVALID_ARGUMENT", "PLANNER_UNSAFE_PATH",
  "PLANNER_MISSING_ARGUMENT", "MESH_CAPABILITY_DENIED", "MESH_RISK_DENIED",
  "MESH_WORKSPACE_DENIED", "EXECUTOR_FAILURE", "TOOL_TEST_FAILURE",
  "VERIFICATION_FAILURE", "MODEL_FAILURE", "TIMEOUT", "UNKNOWN",
];

export const RECOVERY_CLASSES = [
  "NONE", "REPLAN_SUCCESS", "MESH_DENIAL_REPLAN", "ARGUMENT_CORRECTION",
  "PATH_CORRECTION", "TOOL_SELECTION_CORRECTION", "NO_RECOVERY",
];

/** Deterministic failure classification from a runLocalTask outcome. */
export function classifyFailure(outcome) {
  const status = outcome.status;
  if (status === "complete") return "NONE";
  if (status === "plan_failed") return "MODEL_FAILURE";
  if (status === "planner_invalid") {
    const reason = String(outcome.error || "");
    if (/unknown tool/.test(reason)) return "PLANNER_INVALID_TOOL";
    if (/outside workspace/.test(reason)) return "PLANNER_UNSAFE_PATH";
    if (/argument required|missing|requires/.test(reason)) return "PLANNER_MISSING_ARGUMENT";
    if (/not allowlisted|invalid|must be/.test(reason)) return "PLANNER_INVALID_ARGUMENT";
    return "PLANNER_INVALID_ARGUMENT";
  }
  if (status === "denied") {
    const reason = String(outcome.error || "");
    if (/capability/.test(reason)) return "MESH_CAPABILITY_DENIED";
    if (/risk/.test(reason)) return "MESH_RISK_DENIED";
    if (/workspace/.test(reason)) return "MESH_WORKSPACE_DENIED";
    return "MESH_CAPABILITY_DENIED";
  }
  if (status === "iteration_limit") {
    const last = (outcome.evidence || []).filter((e) => e.kind === "tool").pop();
    if (last && !last.success) {
      if (last.tool === "project.test") return "TOOL_TEST_FAILURE";
      return "EXECUTOR_FAILURE";
    }
    return "VERIFICATION_FAILURE";
  }
  return "UNKNOWN";
}

/** Deterministic recovery classification. */
export function classifyRecovery(outcome) {
  if (outcome.status !== "complete") return "NO_RECOVERY";
  if (outcome.meshDenials > 0) return "MESH_DENIAL_REPLAN";
  if (outcome.plannerRetries > 0) return "REPLAN_SUCCESS";
  return "NONE";
}

/** Build a structured evaluation record from a task + outcome. */
export function buildEvaluation(task, outcome) {
  const tools = (outcome.evidence || []).filter((e) => e.kind === "tool");
  const executed = tools.filter((t) => t.success);
  const failed = tools.filter((t) => !t.success);
  const last = tools[tools.length - 1];
  const failureClass = classifyFailure(outcome);
  const recoveryClass = classifyRecovery(outcome);
  return {
    taskId: task.id || outcome.taskId,
    sessionId: task.sessionId || null,
    taskType: task.skill || "generic",
    model: task.model || "phi4-mini",
    plannerAttempts: outcome.iterations || 0,
    plannerRetries: outcome.plannerRetries || 0,
    meshDenials: outcome.meshDenials || 0,
    toolsRequested: tools.map((t) => t.tool),
    toolsExecuted: executed.map((t) => t.tool),
    successfulTools: executed.map((t) => t.tool),
    failedTools: failed.map((t) => t.tool),
    finalStatus: outcome.status,
    confidence: last?.confidence ?? null,
    verification: last?.verification ?? null,
    failureClass,
    recoveryClass,
    workspaceChanged: task.workspaceChanged ?? false,
    durationMs: outcome.durationMs ?? null,
    usage: outcome.usage ?? null,
    costUsd: outcome.costUsd ?? null,
    timestamp: new Date().toISOString(),
  };
}

async function load() {
  try {
    const d = JSON.parse(await readFile(FILE, "utf8"));
    return d.evaluations || [];
  } catch {
    return [];
  }
}

export async function recordEvaluation(ev) {
  const all = await load();
  all.push(ev);
  try {
    await writeFile(FILE, JSON.stringify({ version: 1, evaluations: all.slice(-500) }, null, 2));
  } catch {
    // non-fatal
  }
  return ev;
}

export async function listEvaluations() {
  return load();
}

/** Confidence calibration: is the model over/under-confident vs verification? */
export function calibrateConfidence(ev) {
  if (ev.confidence == null || ev.verification == null) return null;
  const verified = ev.verification === "ok";
  const confident = ev.confidence >= 0.7;
  if (verified && confident) return "calibrated";
  if (!verified && confident) return "overconfident";
  if (verified && !confident) return "underconfident";
  return "calibrated";
}
