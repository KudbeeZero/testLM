/**
 * thinkbox-contracts.mjs — THINK BOX backend contracts.
 *
 * Lightweight interface/type definitions for the THINK BOX foundation:
 * Task, Agent, Tool, Result, Evidence. These are plain factory functions that
 * define the contract shapes — no UI, no new database, no new agent framework.
 * They reuse the existing MESH ToolRequest/ToolResult structures.
 */

export const THINKBOX_VERSION = "0.1.0";

/**
 * A unit of work for an agent. A task may either carry a `goal` (free-form) or
 * a structured `tool` request. `maxRisk` bounds what MESH may allow (default L1).
 */
export function createTask({ id, agentId, goal = "", tool = null, arguments: args = {}, priority = 0, maxRisk = "L1" }) {
  return {
    id,
    agentId,
    goal,
    tool,
    arguments: args,
    priority,
    maxRisk,
    status: "queued",
    createdAt: new Date().toISOString(),
  };
}

/**
 * A registered agent. Capabilities are resolved by MESH (policy.mjs) — never
 * self-declared. `role` maps to an agent capability set.
 */
export function createAgent({ id, role = "local-operator", capabilities = [] }) {
  return { id, role, capabilities, createdAt: new Date().toISOString() };
}

/**
 * A tool descriptor. Must match the MESH TOOL_POLICY (name/capability/risk/approval).
 */
export function createTool({ name, capability, risk, approval = false }) {
  return { name, capability, risk, approval };
}

/**
 * A structured result from executing a tool (the MESH ToolResult shape).
 */
export function createToolResult({ taskId, tool, success, exitCode = null, stdout = "", stderr = "", durationMs = null, evidence = {}, error = null }) {
  return {
    taskId,
    tool,
    success,
    exitCode,
    stdout,
    stderr,
    durationMs,
    evidence,
    error,
    ts: new Date().toISOString(),
  };
}

/**
 * An RDTHINK evidence record (TASK → EXECUTE → OBSERVE → EVALUATE).
 * This is the durable, structured input a future learning loop consumes.
 */
export function createEvidence({ taskId, tool, request, result, decision, auditId, verification }) {
  return {
    taskId,
    tool,
    request,
    result,
    decision,
    auditId,
    verification,
    ts: new Date().toISOString(),
  };
}
