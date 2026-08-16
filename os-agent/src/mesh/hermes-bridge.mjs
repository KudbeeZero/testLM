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
