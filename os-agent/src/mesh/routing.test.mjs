import { test, expect } from "bun:test";
import { routingIntelligence, suggestModel } from "./routing.mjs";

const mk = (taskType, status, extra = {}) => ({
  taskType, finalStatus: status, plannerRetries: 0, meshDenials: 0,
  verification: "ok", confidence: 0.9, durationMs: 100, successfulTools: ["git.status"],
  failureClass: status === "complete" ? "NONE" : "UNKNOWN", recoveryClass: "NONE",
  ...extra,
});

test("routingIntelligence reports collecting when no evidence", async () => {
  const r = await routingIntelligence([]);
  expect(r.collecting).toBe(true);
  expect(r.observed).toBe(0);
});

test("routingIntelligence aggregates stats from evidence", async () => {
  const evals = [
    mk("repository-health", "complete"),
    mk("repository-health", "complete"),
    mk("repository-health", "denied", { meshDenials: 1, failureClass: "MESH_CAPABILITY_DENIED", recoveryClass: "NO_RECOVERY" }),
  ];
  const r = await routingIntelligence(evals);
  expect(r.observed).toBe(3);
  expect(r.successRate).toBeCloseTo(2 / 3, 2);
  expect(r.meshDenialRate).toBeCloseTo(1 / 3, 2);
  expect(r.byType["repository-health"].n).toBe(3);
  expect(r.byType["repository-health"].ok).toBe(2);
  expect(r.topFailures.map((x) => x[0])).toContain("MESH_CAPABILITY_DENIED");
});

test("suggestModel stays local with insufficient evidence", async () => {
  const s = await suggestModel("repository-health", [mk("repository-health", "complete")]);
  expect(s.model).toBe("local");
  expect(s.escalation).toBe(false);
});

test("suggestModel suggests local when Phi-4 is reliable", async () => {
  const evals = Array.from({ length: 4 }, () => mk("repository-health", "complete"));
  const s = await suggestModel("repository-health", evals);
  expect(s.model).toBe("local");
  expect(s.escalation).toBe(false);
  expect(s.confidence).toBeGreaterThanOrEqual(0.8);
});

test("suggestModel suggests escalation when Phi-4 is unreliable", async () => {
  const evals = Array.from({ length: 4 }, () => mk("test-and-diagnose", "denied", { meshDenials: 1, failureClass: "MESH_CAPABILITY_DENIED" }));
  const s = await suggestModel("test-and-diagnose", evals);
  expect(s.escalation).toBe(true);
  expect(s.model).toBe("gemini");
});

test("suggestModel is observation-only and never authoritative", async () => {
  const s = await suggestModel("repository-health", [mk("repository-health", "complete")]);
  // It must return a suggestion object, never mutate policy or grant capability.
  expect(typeof s.model).toBe("string");
  expect(typeof s.confidence).toBe("number");
  expect(s).not.toHaveProperty("capability");
  expect(s).not.toHaveProperty("permission");
});
