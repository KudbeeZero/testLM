import { test, expect } from "bun:test";
import { routingIntelligence, suggestModel, routingDecision, taskTypeStats, recordRoutingDecision, listRoutingDecisions, ROUTING_POLICY } from "./routing.mjs";

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

// ── ADAPTIVE ROUTING DECISION ────────────────────────────────────────────
test("routingDecision defaults to local with insufficient samples", async () => {
  const d = await routingDecision("repository-health", { evals: [mk("repository-health", "complete")] });
  expect(d.selectedModel).toBe("local");
  expect(d.escalation).toBe(false);
  expect(d.reason).toBe("insufficient_samples_default_local");
});

test("routingDecision stays local when Phi-4 is reliable", async () => {
  const evals = Array.from({ length: 4 }, () => mk("repository-health", "complete"));
  const d = await routingDecision("repository-health", { evals });
  expect(d.selectedModel).toBe("local");
  expect(d.escalation).toBe(false);
  expect(d.confidence).toBeGreaterThanOrEqual(0.7);
});

test("routingDecision recommends escalation when local is unreliable", async () => {
  const evals = Array.from({ length: 4 }, () => mk("debugging", "denied", { meshDenials: 1, failureClass: "MESH_CAPABILITY_DENIED" }));
  const d = await routingDecision("debugging", { evals, costStatus: "ESTIMATED", allowEscalation: true });
  expect(d.escalation).toBe(true);
  expect(d.selectedModel).toBe("gemini");
});

test("routingDecision blocks escalation when cloud cost is UNKNOWN", async () => {
  const evals = Array.from({ length: 4 }, () => mk("debugging", "denied", { meshDenials: 1 }));
  const d = await routingDecision("debugging", { evals, costStatus: "UNKNOWN", allowEscalation: false });
  expect(d.escalation).toBe(false);
  expect(d.selectedModel).toBe("local");
  expect(d.reason).toBe("escalation_blocked_unknown_cost");
});

test("routingDecision respects the three-strike local attempt cap", async () => {
  const evals = Array.from({ length: 10 }, () => mk("debugging", "denied", { meshDenials: 1 }));
  const d = await routingDecision("debugging", { evals, costStatus: "ESTIMATED", allowEscalation: true });
  expect(d.localAttempts).toBeLessThanOrEqual(ROUTING_POLICY.MAX_LOCAL_ATTEMPTS);
  expect(ROUTING_POLICY.MAX_LOCAL_ATTEMPTS).toBe(3);
});

test("taskTypeStats computes per-type metrics and honors min samples", async () => {
  const evals = Array.from({ length: 3 }, () => mk("repository-health", "complete"));
  const s = await taskTypeStats("repository-health", evals);
  expect(s.sampleCount).toBe(3);
  expect(s.localSuccessRate).toBe(1);
  expect(s.verificationRate).toBe(1);
  expect(await taskTypeStats("nope", evals)).toBeNull();
});

test("routing decision record round-trips as RDTHINK evidence", async () => {
  const rec = { taskId: "rd1", taskType: "repository-health", selectedModel: "local", reason: "local_reliable", timestamp: new Date().toISOString() };
  await recordRoutingDecision(rec);
  const all = await listRoutingDecisions();
  expect(all.some((d) => d.taskId === "rd1")).toBe(true);
});

test("routing decision never grants capability or permission", async () => {
  const evals = Array.from({ length: 4 }, () => mk("debugging", "denied", { meshDenials: 1 }));
  const d = await routingDecision("debugging", { evals, costStatus: "ESTIMATED", allowEscalation: true });
  expect(d).not.toHaveProperty("capability");
  expect(d).not.toHaveProperty("permission");
  expect(d).not.toHaveProperty("grant");
});
