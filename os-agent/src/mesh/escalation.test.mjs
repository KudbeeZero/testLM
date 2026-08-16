import { test, expect } from "bun:test";
import { runTaskWithEscalation, ESCALATION_LIMITS } from "./local-runner.mjs";
import { recordEscalation, listEscalations } from "./escalation.mjs";

// Stub model workers.
const successModel = async (prompt) => {
  if (prompt.includes("planner")) return { ok: true, content: JSON.stringify({ tool: "git.status", arguments: {} }), provider: "local", cost: 0, costStatus: "ACTUAL" };
  return { ok: true, content: JSON.stringify({ done: true, confidence: 0.9, note: "ok" }), provider: "local", cost: 0, costStatus: "ACTUAL" };
};
const failModel = async (prompt) => {
  // Invalid tool -> planner validation rejects -> task fails.
  if (prompt.includes("planner")) return { ok: true, content: JSON.stringify({ tool: "shell.exec", arguments: { command: "rm -rf /" } }) };
  return { ok: true, content: JSON.stringify({ done: true, confidence: 0.9 }) };
};
const invalidGemini = async (prompt) => {
  if (prompt.includes("planner")) return { ok: true, content: "not json at all", provider: "gemini", costStatus: "UNKNOWN" };
  return { ok: true, content: JSON.stringify({ done: true }) };
};

const escalateDecision = async () => ({ escalation: true, reason: "test_escalate" });
const stayDecision = async () => ({ escalation: false, reason: "test_stay" });

const task = { id: "esc-1", goal: "check repo", skill: "repository-health" };

test("local-only path: Phi-4 success, no escalation", async () => {
  const r = await runTaskWithEscalation(task, { localModel: successModel, decisionFn: stayDecision });
  expect(r.escalated).toBe(false);
  expect(r.outcome.status).toBe("complete");
  expect(r.escalation.selectedModel).toBe("local");
  expect(r.escalation.reason).toBe("local_success");
});

test("escalation path fires when local fails, cost allowed, budget OK", async () => {
  const r = await runTaskWithEscalation(task, {
    localModel: failModel, escalationModel: successModel,
    decisionFn: escalateDecision, allowUnknownCost: true, sessionCloudUsed: 0,
  });
  expect(r.escalated).toBe(true);
  expect(r.escalation.selectedModel).toBe("gemini");
  expect(r.outcome.status).toBe("complete");
  expect(r.modelJourney.escalated).toBe(true);
  expect(r.modelJourney.finalModel).toBe("gemini-flash-latest");
});

test("unknown cloud cost blocks escalation by default", async () => {
  const r = await runTaskWithEscalation(task, {
    localModel: failModel, escalationModel: successModel,
    decisionFn: escalateDecision, allowUnknownCost: false, sessionCloudUsed: 0,
  });
  expect(r.escalated).toBe(false);
  expect(r.escalation.reason).toBe("escalation_blocked_unknown_cost");
});

test("session cloud budget exhaustion blocks escalation", async () => {
  const r = await runTaskWithEscalation(task, {
    localModel: failModel, escalationModel: successModel,
    decisionFn: escalateDecision, allowUnknownCost: true,
    sessionCloudUsed: 2, sessionCloudBudget: 2,
  });
  expect(r.escalated).toBe(false);
  expect(r.escalation.reason).toBe("escalation_budget_exhausted");
});

test("per-task escalation limit (0) blocks escalation", async () => {
  const r = await runTaskWithEscalation(task, {
    localModel: failModel, escalationModel: successModel,
    decisionFn: escalateDecision, allowUnknownCost: true, maxCloudPerTask: 0,
  });
  expect(r.escalated).toBe(false);
});

test("invalid Gemini proposal fails safely (no MESH bypass)", async () => {
  const r = await runTaskWithEscalation(task, {
    localModel: failModel, escalationModel: invalidGemini,
    decisionFn: escalateDecision, allowUnknownCost: true, sessionCloudUsed: 0,
  });
  expect(r.escalated).toBe(true); // escalation attempted
  expect(r.outcome.status).toBe("planner_invalid"); // Gemini invalid -> task failed safely
});

test("escalation limits are hard-capped", () => {
  expect(ESCALATION_LIMITS.MAX_LOCAL_ATTEMPTS).toBe(3);
  expect(ESCALATION_LIMITS.MAX_CLOUD_ESCALATIONS_PER_TASK).toBe(1);
  expect(ESCALATION_LIMITS.MAX_CLOUD_ESCALATIONS_PER_SESSION).toBe(2);
});

test("escalation record round-trips as RDTHINK evidence", async () => {
  const rec = { taskId: "esc-ev", reason: "test", localAttempts: 3, selectedModel: "gemini", provider: "gemini", costStatus: "UNKNOWN", cost: null, timestamp: new Date().toISOString() };
  await recordEscalation(rec);
  const all = await listEscalations();
  expect(all.some((e) => e.taskId === "esc-ev")).toBe(true);
});
