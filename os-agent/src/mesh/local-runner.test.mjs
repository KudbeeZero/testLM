import { test, expect } from "bun:test";
import { runLocalTask, MAX_ITERATIONS } from "./local-runner.mjs";
import { parseModelJson } from "./local-worker.mjs";
import { recordLearning, listLearnings } from "./learning.mjs";
import { getSkill, listSkills } from "./skills.mjs";

// A stub model that returns a scripted sequence of JSON responses.
function stubModel(planJson, evalJson) {
  return async (prompt) => {
    if (prompt.includes("planner")) return { ok: true, content: JSON.stringify(planJson) };
    return { ok: true, content: JSON.stringify(evalJson) };
  };
}

test("runLocalTask completes with evidence + learning (git.status)", async () => {
  const model = stubModel({ tool: "git.status", arguments: {} }, { done: true, confidence: 0.9, note: "repo is clean" });
  const out = await runLocalTask({ id: "t1", goal: "Check git status" }, { model });
  expect(out.status).toBe("complete");
  expect(out.iterations).toBeGreaterThanOrEqual(1);
  expect(out.evidence.length).toBeGreaterThanOrEqual(1);
  expect(out.evidence[0].tool).toBe("git.status");
  expect(out.evidence[0].decision).toBe("allow");
  expect(out.evidence[0].success).toBe(true);
  expect(out.learning).toBeTruthy();
});

test("runLocalTask stops on MESH denial (non-enabled tool)", async () => {
  const model = stubModel({ tool: "filesystem.write", arguments: {} }, { done: true });
  const out = await runLocalTask({ id: "t2", goal: "write a file" }, { model });
  expect(out.status).toBe("denied");
  expect(out.error).toMatch(/missing capability|unknown tool/);
});

test("runLocalTask handles malformed plan without crashing", async () => {
  const model = async () => ({ ok: true, content: "not json at all" });
  const out = await runLocalTask({ id: "t3", goal: "anything" }, { model });
  expect(out.status).toBe("malformed_plan");
  expect(out.error).toMatch(/malformed plan/);
});

test("runLocalTask is bounded by MAX_ITERATIONS", async () => {
  const model = stubModel({ tool: "git.status", arguments: {} }, { done: false, confidence: 0.5, note: "keep going" });
  const out = await runLocalTask({ id: "t4", goal: "loop forever" }, { model, maxIterations: 3 });
  expect(out.status).toBe("iteration_limit");
  expect(out.iterations).toBeLessThanOrEqual(MAX_ITERATIONS);
});

test("runLocalTask survives model failure (plan_failed)", async () => {
  const model = async () => ({ ok: false, error: "LM Studio unavailable" });
  const out = await runLocalTask({ id: "t5", goal: "x" }, { model });
  expect(out.status).toBe("plan_failed");
  expect(out.error).toMatch(/unavailable/);
});

test("parseModelJson handles fences and malformed input", () => {
  expect(parseModelJson('{"tool":"git.status"}')).toEqual({ tool: "git.status" });
  expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  expect(parseModelJson("not json")).toBeNull();
  expect(parseModelJson("")).toBeNull();
});

test("learning requires evidence", async () => {
  const bad = await recordLearning({ observation: "no evidence" });
  expect(bad.ok).toBe(false);
  const good = await recordLearning({ observation: "x", evidence: { tool: "git.status" } });
  expect(good.ok).toBe(true);
  const all = await listLearnings();
  expect(all.some((l) => l.id === good.id)).toBe(true);
});

test("skill registry exposes real skills", () => {
  const names = listSkills();
  expect(names).toContain("repository-health");
  expect(names).toContain("test-and-diagnose");
  const s = getSkill("repository-health");
  expect(s.tools).toContain("git.status");
  expect(s.permissions).toContain("git.read");
  expect(getSkill("nope")).toBeNull();
});
