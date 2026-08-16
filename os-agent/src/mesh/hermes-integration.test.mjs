import { test, expect } from "bun:test";
import { runHermesTask, validateHermesTask } from "./hermes-bridge.mjs";
import { listHermesExecutions, hermesExecutionStats } from "./hermes-execution.mjs";
import { listLearnings } from "./learning.mjs";

const task = (tool, args = {}, extra = {}) => ({ taskId: "h-" + Math.random().toString(36).slice(2, 8), tool, arguments: args, agentId: "hermes", ...extra });

// ── CONTRACT VALIDATION ───────────────────────────────────────────────────
test("validateHermesTask accepts a valid structured tool task", () => {
  expect(validateHermesTask({ tool: "git.status", arguments: {} }).ok).toBe(true);
  expect(validateHermesTask({ tool: "project.check", arguments: { file: "os-agent/cost-cache.mjs" } }).ok).toBe(true);
});

test("validateHermesTask rejects raw command / shell / exec / script / process / env", () => {
  expect(validateHermesTask({ tool: "x", arguments: {}, command: "rm -rf /" }).ok).toBe(false);
  expect(validateHermesTask({ tool: "x", arguments: { shell: "whoami" } }).ok).toBe(false);
  expect(validateHermesTask({ tool: "x", arguments: { exec: "ls" } }).ok).toBe(false);
  expect(validateHermesTask({ tool: "x", arguments: { script: "..." } }).ok).toBe(false);
  expect(validateHermesTask({ tool: "x", arguments: { process: "node" } }).ok).toBe(false);
  expect(validateHermesTask({ tool: "x", arguments: { cmd: "pwd" } }).ok).toBe(false);
  expect(validateHermesTask({ tool: "x", arguments: { environment: { PATH: "/tmp" } } }).ok).toBe(false);
});

test("validateHermesTask requires tool and object arguments", () => {
  expect(validateHermesTask(null).ok).toBe(false);
  expect(validateHermesTask({ arguments: {} }).ok).toBe(false);
  expect(validateHermesTask({ tool: "git.status", arguments: "not-an-object" }).ok).toBe(false);
});

// ── HAPPY PATH ────────────────────────────────────────────────────────────
test("HERMES happy path: structured task -> MESH allow -> executor -> result", async () => {
  const r = await runHermesTask(task("git.status", {}));
  expect(r.ok).toBe(true);
  expect(r.decision).toBe("allow");
  expect(r.success).toBe(true);
  expect(r.evidence.verification).toBe("ok");
});

test("HERMES project.check runs through MESH", async () => {
  const r = await runHermesTask(task("project.check", { file: "os-agent/cost-cache.mjs", path: "." }));
  expect(r.ok).toBe(true);
  expect(r.success).toBe(true);
});

// ── SECURITY DENIALS ─────────────────────────────────────────────────────
test("HERMES unknown tool is denied", async () => {
  const r = await runHermesTask(task("unknown.tool", {}));
  expect(r.ok).toBe(false);
  expect(r.decision).toBe("deny");
});

test("HERMES raw command is denied before MESH", async () => {
  const r = await runHermesTask(task("git.status", { command: "rm -rf /" }));
  expect(r.ok).toBe(false);
  expect(r.decision).toBe("deny");
  expect(r.reason).toMatch(/raw command/);
});

test("HERMES secret access (.env) is denied at the executor boundary", async () => {
  const r = await runHermesTask(task("file.read", { path: ".env" }));
  expect(r.ok).toBe(false);
  expect(r.success).toBe(false);
  expect(r.evidence.verification).toBe("failed");
});

test("HERMES workspace escape is denied at the executor boundary", async () => {
  const r = await runHermesTask(task("file.read", { path: "../../../.env" }));
  expect(r.ok).toBe(false);
  expect(r.success).toBe(false);
  expect(r.evidence.verification).toBe("failed");
});

// ── FAILURE RECOVERY ──────────────────────────────────────────────────────
test("HERMES executor failure is structured and does not crash", async () => {
  const r = await runHermesTask(task("file.read", { path: "os-agent/nope-xyz.mjs" }));
  expect(r.decision).toBe("allow"); // capability/risk passed
  expect(r.success).toBe(false);    // execution failed, bridge survived
  expect(r.evidence.verification).toBe("failed");
});

test("HERMES model/planner failure is bounded and survives", async () => {
  // A malformed task that passes contract but is unknown to MESH -> denied, no crash.
  const r = await runHermesTask(task("shell.exec", { command: "whoami" }));
  expect(r.ok).toBe(false);
  expect(r.decision).toBe("deny");
});

// ── EVIDENCE + LEARNING ───────────────────────────────────────────────────
test("HERMES executions are recorded as evidence", async () => {
  await runHermesTask(task("git.status", {}));
  await runHermesTask(task("unknown.tool", {}));
  const all = await listHermesExecutions();
  expect(all.some((e) => e.tool === "git.status")).toBe(true);
  expect(all.some((e) => e.tool === "unknown.tool")).toBe(true);
  const stats = await hermesExecutionStats();
  expect(stats.observed).toBeGreaterThanOrEqual(2);
});

test("HERMES learning is evidence-backed only (success -> learning, deny -> none)", async () => {
  const before = (await listLearnings()).length;
  await runHermesTask(task("git.status", {})); // success -> learning recorded
  const after = (await listLearnings()).length;
  expect(after).toBeGreaterThan(before);
  const before2 = after;
  await runHermesTask(task("unknown.tool", {})); // denied -> no learning
  const after2 = (await listLearnings()).length;
  expect(after2).toBe(before2);
});
