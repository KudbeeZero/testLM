import { test, expect } from "bun:test";
import { runLocalTask, MAX_ITERATIONS, MAX_PLAN_ATTEMPTS } from "./local-runner.mjs";
import { parseModelJson } from "./local-worker.mjs";
import { validateProposal, toolSchemaText, ALLOWED_TEST_SUITES } from "./tool-contracts.mjs";

// A stub model that returns a scripted sequence of JSON responses.
function stubModel(planJson, evalJson) {
  return async (prompt) => {
    if (prompt.includes("planner")) return { ok: true, content: JSON.stringify(planJson) };
    return { ok: true, content: JSON.stringify(evalJson) };
  };
}

// A stub that returns different plans per call (for replan testing).
function replanStub(firstPlan, secondPlan, evalJson) {
  let calls = 0;
  return async (prompt) => {
    if (prompt.includes("planner")) {
      calls++;
      const p = calls === 1 ? firstPlan : secondPlan;
      return { ok: true, content: JSON.stringify(p) };
    }
    return { ok: true, content: JSON.stringify(evalJson) };
  };
}

test("runLocalTask completes with evidence (git.status)", async () => {
  const model = stubModel({ tool: "git.status", arguments: {} }, { done: true, confidence: 0.9, note: "ok" });
  const out = await runLocalTask({ id: "t1", goal: "Check git status" }, { model });
  expect(out.status).toBe("complete");
  expect(out.evidence.some((e) => e.kind === "planner_validation" && e.valid)).toBe(true);
  expect(out.evidence.some((e) => e.kind === "tool" && e.tool === "git.status" && e.success)).toBe(true);
  expect(out.learning).toBeTruthy();
});

test("runLocalTask handles malformed plan (planner_invalid)", async () => {
  const model = async () => ({ ok: true, content: "not json at all" });
  const out = await runLocalTask({ id: "t2", goal: "anything" }, { model });
  expect(out.status).toBe("planner_invalid");
});

test("runLocalTask replans once after an invalid proposal", async () => {
  const model = replanStub(
    { tool: "shell.exec", arguments: { command: "rm -rf /" } }, // invalid → planner validation rejects
    { tool: "git.status", arguments: {} },                       // valid replan
    { done: true, confidence: 0.9, note: "ok" }
  );
  const out = await runLocalTask({ id: "t3", goal: "check repo" }, { model });
  expect(out.status).toBe("complete");
  expect(out.plannerRetries).toBe(1);
  expect(out.evidence.some((e) => e.kind === "planner_validation" && !e.valid)).toBe(true);
  expect(out.evidence.some((e) => e.kind === "tool" && e.tool === "git.status" && e.success)).toBe(true);
});

test("runLocalTask is bounded by MAX_ITERATIONS", async () => {
  const model = stubModel({ tool: "git.status", arguments: {} }, { done: false, confidence: 0.5, note: "keep going" });
  const out = await runLocalTask({ id: "t4", goal: "loop" }, { model, maxIterations: 3 });
  expect(out.status).toBe("iteration_limit");
  expect(out.iterations).toBeLessThanOrEqual(MAX_ITERATIONS);
});

test("runLocalTask survives model failure (plan_failed)", async () => {
  const model = async () => ({ ok: false, error: "LM Studio unavailable" });
  const out = await runLocalTask({ id: "t5", goal: "x" }, { model });
  expect(out.status).toBe("plan_failed");
});

// project.test suite validation is covered by validateProposal (tool-contracts).

// ── TOOL CONTRACT VALIDATION ─────────────────────────────────────────────
test("validateProposal accepts valid tools and rejects bad ones", () => {
  expect(validateProposal({ tool: "git.status", arguments: {} }).ok).toBe(true);
  expect(validateProposal({ tool: "shell.exec", arguments: { command: "x" } }).ok).toBe(false);
  expect(validateProposal({ tool: "git.status", arguments: {}, command: "x" }).ok).toBe(false);
  expect(validateProposal({ tool: "project.test", arguments: { suite: "rm:all" } }).ok).toBe(false);
  expect(validateProposal({ tool: "project.test", arguments: { suite: "bun:test" } }).ok).toBe(true);
  expect(validateProposal(null).ok).toBe(false);
  expect(validateProposal({ tool: "nope" }).ok).toBe(false);
  expect(validateProposal({ tool: "file.read", arguments: { path: "../.env" } }).ok).toBe(false);
  expect(validateProposal({ tool: "file.read", arguments: { path: "C:/Windows/win.ini" } }).ok).toBe(false);
  expect(validateProposal({ tool: "file.read", arguments: { path: "os-agent/package.json" } }).ok).toBe(true);
});

test("tool schema text exposes contracts and allowlisted suites", () => {
  const text = toolSchemaText();
  expect(text).toContain("git.status");
  expect(text).toContain("project.test");
  expect(text).toContain("bun:test");
  expect(ALLOWED_TEST_SUITES).toContain("bun:test");
  expect(MAX_PLAN_ATTEMPTS).toBe(2);
});

test("runLocalTask attributes provider metadata from the worker", async () => {
  const metaModel = async (prompt) => {
    if (prompt.includes("planner")) return { ok: true, content: JSON.stringify({ tool: "git.status", arguments: {} }), provider: "local", model: "phi4-mini", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, cost: 0, costStatus: "ACTUAL", latencyMs: 100 };
    return { ok: true, content: JSON.stringify({ done: true, confidence: 0.9 }), provider: "local", model: "phi4-mini", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, cost: 0, costStatus: "ACTUAL", latencyMs: 50 };
  };
  const out = await runLocalTask({ id: "meta", goal: "check repo" }, { model: metaModel });
  expect(out.status).toBe("complete");
  expect(out.provider).toBe("local");
  expect(out.model).toBe("phi4-mini");
  expect(out.cost).toBe(0);
  expect(out.costStatus).toBe("ACTUAL");
  expect(out.usage.prompt_tokens).toBe(15);
  expect(out.usage.completion_tokens).toBe(8);
});
