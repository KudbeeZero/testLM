/**
 * index.mjs — MESH gate.
 *
 * The safety boundary around tool execution:
 *
 *   ToolRequest
 *     → capability check
 *     → risk check
 *     → approval check
 *     → execute (dispatcher)
 *     → verify (structured evidence)
 *     → audit
 *     → ToolResult
 *
 * The model proposes. MESH authorizes. The executor executes. The result is
 * structured evidence for RDTHINK. Nothing here grants arbitrary shell or
 * filesystem access.
 */
import { TOOL_POLICY, MAX_ALLOWED_RISK, riskLevel, agentHasCapability } from "./policy.mjs";
import { executeTool } from "./executor.mjs";
import { meshAudit } from "./audit.mjs";

/**
 * Authorize and execute a tool request.
 * @param {object} request  ToolRequest { id, agentId, taskId, tool, arguments, ... }
 * @returns {Promise<object>} ToolResult { decision, success, result, ... }
 */
export async function meshGate(request) {
  const id = request.id || `mesh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tool = request.tool;
  const agentId = request.agentId || "local-operator";

  const base = { id, tool, agentId, taskId: request.taskId || null, decision: "deny", reason: "", approvalRequired: false };

  // 1. Known tool?
  const policy = TOOL_POLICY[tool];
  if (!policy) {
    base.reason = "unknown tool";
    await meshAudit(base);
    return { ...base, success: false };
  }

  // 2. Capability?
  if (!agentHasCapability(agentId, policy.capability)) {
    base.reason = "missing capability: " + policy.capability;
    await meshAudit(base);
    return { ...base, success: false };
  }

  // 3. Risk within allowed bound?
  if (riskLevel(policy.risk) > riskLevel(MAX_ALLOWED_RISK)) {
    base.reason = `risk ${policy.risk} exceeds allowed ${MAX_ALLOWED_RISK}`;
    await meshAudit(base);
    return { ...base, success: false };
  }

  // 4. Approval required?
  if (policy.approval) {
    base.decision = "approval_required";
    base.approvalRequired = true;
    base.reason = "human approval required";
    await meshAudit(base);
    return { ...base, success: false };
  }

  // 5. Execute.
  base.decision = "allow";
  const result = await executeTool(request);

  // 6. Audit (never records secret values).
  const entry = {
    ...base,
    capability: policy.capability,
    risk: policy.risk,
    success: result.success,
    reason: result.error || "ok",
    durationMs: result.durationMs,
  };
  await meshAudit(entry);

  return { ...entry, result };
}
