import { test, expect } from "bun:test";
import {
  classifyFailure, classifyRecovery, buildEvaluation, calibrateConfidence,
  recordEvaluation, listEvaluations, FAILURE_CLASSES, RECOVERY_CLASSES,
} from "./evaluation.mjs";

test("failure taxonomy is deterministic and complete", () => {
  expect(classifyFailure({ status: "complete" })).toBe("NONE");
  expect(classifyFailure({ status: "plan_failed" })).toBe("MODEL_FAILURE");
  expect(classifyFailure({ status: "planner_invalid", error: "unknown tool: shell.exec" })).toBe("PLANNER_INVALID_TOOL");
  expect(classifyFailure({ status: "planner_invalid", error: "file outside workspace" })).toBe("PLANNER_UNSAFE_PATH");
  expect(classifyFailure({ status: "planner_invalid", error: "file argument required" })).toBe("PLANNER_MISSING_ARGUMENT");
  expect(classifyFailure({ status: "planner_invalid", error: "test suite not allowlisted" })).toBe("PLANNER_INVALID_ARGUMENT");
  expect(classifyFailure({ status: "denied", error: "missing capability: filesystem.write" })).toBe("MESH_CAPABILITY_DENIED");
  expect(classifyFailure({ status: "denied", error: "risk L3 exceeds allowed L1" })).toBe("MESH_RISK_DENIED");
  expect(classifyFailure({ status: "denied", error: "path outside workspace" })).toBe("MESH_WORKSPACE_DENIED");
  expect(classifyFailure({ status: "iteration_limit", evidence: [{ kind: "tool", tool: "project.test", success: false }] })).toBe("TOOL_TEST_FAILURE");
  expect(classifyFailure({ status: "bogus" })).toBe("UNKNOWN");
  expect(FAILURE_CLASSES).toContain("PLANNER_INVALID_TOOL");
});

test("recovery taxonomy is deterministic", () => {
  expect(classifyRecovery({ status: "complete", meshDenials: 0, plannerRetries: 0 })).toBe("NONE");
  expect(classifyRecovery({ status: "complete", meshDenials: 1 })).toBe("MESH_DENIAL_REPLAN");
  expect(classifyRecovery({ status: "complete", meshDenials: 0, plannerRetries: 1 })).toBe("REPLAN_SUCCESS");
  expect(classifyRecovery({ status: "denied" })).toBe("NO_RECOVERY");
  expect(RECOVERY_CLASSES).toContain("NO_RECOVERY");
});

test("buildEvaluation produces a structured routing record", () => {
  const task = { id: "t1", skill: "repository-health", model: "phi4-mini" };
  const outcome = {
    taskId: "t1", status: "complete", iterations: 2, plannerRetries: 1, meshDenials: 0,
    evidence: [
      { kind: "planner_validation", valid: false },
      { kind: "tool", tool: "git.status", success: true, confidence: 0.9, verification: "ok" },
    ],
    durationMs: 1234,
  };
  const ev = buildEvaluation(task, outcome);
  expect(ev.taskId).toBe("t1");
  expect(ev.taskType).toBe("repository-health");
  expect(ev.model).toBe("phi4-mini");
  expect(ev.toolsExecuted).toContain("git.status");
  expect(ev.successfulTools).toContain("git.status");
  expect(ev.failureClass).toBe("NONE");
  expect(ev.recoveryClass).toBe("REPLAN_SUCCESS");
  expect(ev.confidence).toBe(0.9);
  expect(ev.verification).toBe("ok");
  expect(ev.durationMs).toBe(1234);
});

test("confidence calibration distinguishes over/under/calibrated", () => {
  expect(calibrateConfidence({ confidence: 0.9, verification: "failed" })).toBe("overconfident");
  expect(calibrateConfidence({ confidence: 0.5, verification: "ok" })).toBe("underconfident");
  expect(calibrateConfidence({ confidence: 0.9, verification: "ok" })).toBe("calibrated");
  expect(calibrateConfidence({ confidence: null, verification: "ok" })).toBeNull();
});

test("recordEvaluation / listEvaluations round-trip", async () => {
  const ev = { taskId: "rt1", taskType: "generic", model: "phi4-mini", finalStatus: "complete", failureClass: "NONE", recoveryClass: "NONE", confidence: 0.9, verification: "ok", timestamp: new Date().toISOString() };
  await recordEvaluation(ev);
  const all = await listEvaluations();
  expect(all.some((e) => e.taskId === "rt1")).toBe(true);
});

test("evaluation records redact raw model output and secrets", () => {
  // A realistic outcome whose evidence carries raw plan text (model output).
  const outcome = {
    taskId: "t-sec", status: "complete", iterations: 1, plannerRetries: 0, meshDenials: 0,
    evidence: [
      { kind: "planner_validation", plan: '{"tool":"git.status"}', valid: true },
      { kind: "tool", tool: "git.status", success: true, confidence: 0.9, verification: "ok" },
    ],
    durationMs: 10,
  };
  const ev = buildEvaluation({ id: "t-sec", skill: "repository-health", model: "phi4-mini" }, outcome);
  const json = JSON.stringify(ev);
  // The evaluation record must NOT carry raw plan/prompt content or secrets.
  expect(json).not.toContain("GEMINI_API_KEY");
  expect(json).not.toContain('{"tool":"git.status"}'); // raw model plan output
  expect(json).not.toContain("secret");
  expect(ev).not.toHaveProperty("plan");
  expect(ev).not.toHaveProperty("prompt");
  expect(ev).not.toHaveProperty("content");
});
