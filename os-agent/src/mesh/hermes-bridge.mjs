/**
 * hermes-bridge.mjs — HERMES → MESH integration seam.
 *
 * Provides a single function that a HERMES-style task can call to run a
 * structured tool request through the MESH gate. It does NOT rewrite HERMES
 * and does NOT touch the production submodule — it is the local seam that a
 * future HERMES worker can invoke.
 *
 * The task must remain STRUCTURED (tool + arguments). HERMES can never submit
 * a raw command string — MESH only knows named tools, and the executor decides
 * the actual allowed executable.
 */
import { meshGate } from "./index.mjs";
import { recordLearning } from "./learning.mjs";
import { recordHermesExecution } from "./hermes-execution.mjs";

/**
 * Validate a HERMES structured tool task contract BEFORE MESH.
 * Rejects raw command / shell / exec / script / process / env fields.
 * @returns {{ok:boolean, tool?:string, error?:string}}
 */
export function validateHermesTask(task) {
  if (!task || typeof task !== "object") return { ok: false, error: "task required" };
  const tool = task.tool;
  if (!tool || typeof tool !== "string") return { ok: false, error: "tool required" };
  const args = task.arguments || {};
  if (typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "arguments must be an object" };
  // Reject any raw-command / executable field anywhere in the request.
  for (const bad of ["command", "shell", "exec", "script", "process", "cmd", "environment"]) {
    if (bad in task || bad in args) return { ok: false, error: "raw command field present: " + bad };
  }
  return { ok: true, tool };
}

/**
 * Run a HERMES-style structured tool task through MESH.
 * @param {object} task  { id, taskId, tool, arguments, agentId, risk }
 * @returns {Promise<object>} ToolResult + RDTHINK evidence
 */
export async function runHermesToolTask(task) {
  const request = {
    id: task.id || `hermes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentId: task.agentId || "hermes",
    taskId: task.taskId || null,
    tool: task.tool,
    arguments: task.arguments || {},
    risk: task.risk,
  };

  const result = await meshGate(request);

  // First structured RDTHINK evidence record (TASK → EXECUTE → OBSERVE → EVALUATE).
  const evidence = {
    task: task.taskId || null,
    tool: task.tool,
    request: { tool: request.tool, arguments: request.arguments },
    decision: result.decision,
    success: result.success,
    durationMs: result.result?.durationMs ?? null,
    verification: result.success ? "ok" : "failed",
    auditId: result.id,
    ts: new Date().toISOString(),
  };

  return { ...result, evidence };
}

/**
 * Full HERMES execution lifecycle: validate contract → MESH → evidence →
 * learning. This is the seam a production HERMES worker calls for a
 * structured tool task. Malicious/malformed requests are denied before MESH
 * and never crash the caller. Learning is evidence-backed only.
 *
 * @param {object} task  { taskId, tool, arguments, ... }
 * @returns {Promise<object>} { ok, decision, success, evidence, ... }
 */
export async function runHermesTask(task) {
  const v = validateHermesTask(task);
  if (!v.ok) {
    const evidence = {
      task: task?.taskId || null,
      tool: task?.tool || null,
      decision: "deny",
      success: false,
      verification: "failed",
      reason: v.error,
      ts: new Date().toISOString(),
    };
    await recordHermesExecution({
      taskId: task?.taskId || null, tool: task?.tool || null, decision: "deny",
      success: false, verification: "failed", reason: v.error,
    });
    return { ok: false, decision: "deny", success: false, reason: v.error, evidence };
  }

  const result = await runHermesToolTask(task);
  await recordHermesExecution({
    taskId: task.taskId || null,
    tool: task.tool,
    decision: result.decision,
    success: result.success,
    verification: result.success ? "ok" : "failed",
    reason: result.success ? null : (result.reason || "executor_failure"),
  });

  // Evidence-backed learning only (never from a model statement alone).
  if (result.success) {
    await recordLearning({
      taskId: task.taskId || null,
      observation: `HERMES tool "${task.tool}" verified`, 
      evidence: { tool: task.tool, success: true, verification: "ok" },
      outcome: "complete",
    });
  }

  return { ...result, ok: result.success, evidence: result.evidence };
}
