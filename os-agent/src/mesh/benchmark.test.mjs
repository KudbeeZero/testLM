import { test, expect } from "bun:test";
import { scoreEvaluation, compareResults, runBenchmark, BENCHMARK_TASKS, MODELS } from "./benchmark.mjs";

test("benchmark exposes a safe default task set and model list", () => {
  expect(BENCHMARK_TASKS.length).toBeGreaterThanOrEqual(5);
  expect(MODELS).toContain("phi4");
  expect(MODELS).toContain("gemini");
});

test("scoreEvaluation computes visible dimensions and a score", () => {
  const ev = {
    failureClass: "NONE", successfulTools: ["git.status"], meshDenials: 0,
    toolsExecuted: ["git.status"], verification: "ok", recoveryClass: "NONE",
    confidence: 0.9, durationMs: 100,
  };
  const s = scoreEvaluation(ev);
  expect(s.dimensions.plannerValid).toBe(1);
  expect(s.dimensions.toolSelected).toBe(1);
  expect(s.dimensions.meshCompliant).toBe(1);
  expect(s.dimensions.verified).toBe(1);
  expect(s.score).toBeGreaterThan(0);
});

test("scoreEvaluation computes quality/latency/cost/overall scores", () => {
  const ev = {
    failureClass: "NONE", successfulTools: ["git.status"], meshDenials: 0,
    toolsExecuted: ["git.status"], verification: "ok", recoveryClass: "NONE",
    confidence: 0.9, durationMs: 100, costUsd: 0,
  };
  const s = scoreEvaluation(ev);
  expect(s.qualityScore).toBeGreaterThan(0);
  expect(s.latencyScore).toBeGreaterThan(0.9); // 100ms is fast
  expect(s.costScore).toBe(1); // $0 local
  expect(s.overallScore).toBeGreaterThan(0);
});

test("scoreEvaluation marks unknown cost as neutral costScore", () => {
  const ev = {
    failureClass: "NONE", successfulTools: ["git.status"], meshDenials: 0,
    toolsExecuted: ["git.status"], verification: "ok", recoveryClass: "NONE",
    confidence: 0.9, durationMs: 100, costUsd: null,
  };
  const s = scoreEvaluation(ev);
  expect(s.costScore).toBe(0.5);
});

test("scoreEvaluation penalizes a MESH denial", () => {
  const ev = {
    failureClass: "MESH_CAPABILITY_DENIED", successfulTools: [], meshDenials: 1,
    toolsExecuted: [], verification: "failed", recoveryClass: "NO_RECOVERY", confidence: 0.9,
  };
  const s = scoreEvaluation(ev);
  expect(s.dimensions.meshCompliant).toBe(0);
  expect(s.dimensions.verified).toBe(0);
});

test("compareResults picks a winner per task", () => {
  const phi = { taskId: "t", skill: "x", model: "phi4", score: 0.9, outcome: "complete" };
  const gem = { taskId: "t", skill: "x", model: "gemini", score: 0.5, outcome: "complete" };
  const c = compareResults([phi, gem]);
  expect(c.rows[0].winner).toBe("phi4");
  expect(c.aggregate.phi4Wins).toBe(1);
});

test("runBenchmark runs identical tasks through both models (stubbed)", async () => {
  // Stub workers: propose git.status, then mark done.
  const stub = async (prompt) => {
    if (prompt.includes("planner")) return { ok: true, content: JSON.stringify({ tool: "git.status", arguments: {} }) };
    return { ok: true, content: JSON.stringify({ done: true, confidence: 0.9, note: "ok" }) };
  };
  const tasks = [{ id: "b1", skill: "repository-health", goal: "check repo" }];
  const r = await runBenchmark({ tasks, models: ["phi4", "gemini"], maxTasks: 1, persist: false, workers: { phi4: stub, gemini: stub } });
  expect(r.results.length).toBe(2);
  const phi = r.results.find((x) => x.model === "phi4");
  const gem = r.results.find((x) => x.model === "gemini");
  expect(phi.outcome).toBe("complete");
  expect(gem.outcome).toBe("complete");
  expect(r.comparison.rows.length).toBe(1);
});

test("runBenchmark is bounded by maxTasks", async () => {
  const stub = async (prompt) => {
    if (prompt.includes("planner")) return { ok: true, content: JSON.stringify({ tool: "git.status", arguments: {} }) };
    return { ok: true, content: JSON.stringify({ done: true, confidence: 0.9 }) };
  };
  const r = await runBenchmark({ tasks: BENCHMARK_TASKS, models: ["phi4"], maxTasks: 2, persist: false, workers: { phi4: stub } });
  expect(r.results.length).toBe(2);
});
