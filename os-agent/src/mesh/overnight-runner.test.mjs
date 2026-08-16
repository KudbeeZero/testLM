import { test, expect, beforeEach } from "bun:test";
import { getState, setState, transition, setOvernightMode, AGENT_STATES, OVERNIGHT_MODES } from "./agent-state.mjs";
import { enqueue, listTasks, nextQueued, updateTask, clearQueue } from "./task-queue.mjs";
import { runOvernightSession, validateManifest, SAFETY_MANIFEST } from "./overnight-runner.mjs";

beforeEach(async () => {
  await setState({
    state: "idle", overnightMode: "OFF", currentTaskId: null, currentTask: null,
    iteration: 0, error: null,
  });
  await clearQueue();
});

// ── STATE MACHINE ─────────────────────────────────────────────────────────
test("state transitions are explicit and validated", async () => {
  await transition("planning");
  expect((await getState()).state).toBe("planning");
  await transition("complete");
  expect((await getState()).state).toBe("complete");
  expect(AGENT_STATES).toContain("idle");
  expect(OVERNIGHT_MODES).toContain("ARMED");
});

test("invalid state transition is rejected", async () => {
  await expect(transition("bogus")).rejects.toThrow();
});

test("overnight mode is validated", async () => {
  await setOvernightMode("ARMED");
  expect((await getState()).overnightMode).toBe("ARMED");
  await expect(setOvernightMode("NOPE")).rejects.toThrow();
});

// ── TASK QUEUE ────────────────────────────────────────────────────────────
test("task queue enqueue/list/claim/update", async () => {
  const t = await enqueue({ description: "check git status", maxIterations: 2 });
  expect(t.status).toBe("queued");
  const all = await listTasks();
  expect(all.length).toBe(1);
  const claimed = await nextQueued();
  expect(claimed.id).toBe(t.id);
  expect(claimed.status).toBe("running");
  await updateTask(t.id, { status: "complete" });
  expect((await listTasks())[0].status).toBe("complete");
  expect(await nextQueued()).toBeNull();
});

// ── SAFETY MANIFEST ───────────────────────────────────────────────────────
test("safety manifest validates safe config", () => {
  expect(validateManifest(SAFETY_MANIFEST).ok).toBe(true);
  expect(validateManifest({ ...SAFETY_MANIFEST, network: true }).ok).toBe(false);
  expect(validateManifest({ ...SAFETY_MANIFEST, maxRisk: "L3" }).ok).toBe(false);
  expect(validateManifest({ ...SAFETY_MANIFEST, aws: true }).ok).toBe(false);
});

// ── RUNNER ────────────────────────────────────────────────────────────────
test("runner refuses to start when not armed", async () => {
  await enqueue({ description: "x" });
  const r = await runOvernightSession({ maxTasks: 1, taskRunner: async () => ({ status: "complete", evidence: [], learning: null }) });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/not armed/);
});

test("runner prevents duplicate sessions", async () => {
  await setOvernightMode("RUNNING");
  const r = await runOvernightSession({ maxTasks: 1, taskRunner: async () => ({ status: "complete", evidence: [], learning: null }) });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/already running/);
});

test("runner executes a bounded session and produces a summary", async () => {
  await setOvernightMode("ARMED");
  await enqueue({ description: "check git status", maxIterations: 2 });
  await enqueue({ description: "check git diff", maxIterations: 2 });
  const stub = async () => ({
    status: "complete",
    evidence: [{ tool: "git.status", decision: "allow", verification: "ok" }],
    learning: "learn-1",
  });
  const r = await runOvernightSession({ maxTasks: 2, taskRunner: stub });
  expect(r.ok).toBe(true);
  expect(r.session.tasksAttempted).toBe(2);
  expect(r.session.tasksCompleted).toBe(2);
  expect(r.session.toolsUsed).toContain("git.status");
  expect(r.session.learnings).toContain("learn-1");
  expect(r.session.workspaceChanged).toBe(false);
  expect(r.session.stopReason).toBe("session_complete");
  expect((await getState()).overnightMode).toBe("STOPPED");
});

test("runner survives a failed task (session continues)", async () => {
  await setOvernightMode("ARMED");
  await enqueue({ description: "a" });
  await enqueue({ description: "b" });
  const stub = async (task) => {
    if (task.goal === "a") return { status: "denied", evidence: [{ decision: "deny" }], learning: null };
    return { status: "complete", evidence: [{ tool: "git.diff", decision: "allow", verification: "ok" }], learning: null };
  };
  const r = await runOvernightSession({ maxTasks: 2, taskRunner: stub });
  expect(r.ok).toBe(true);
  expect(r.session.tasksAttempted).toBe(2);
  expect(r.session.tasksCompleted).toBe(1);
  expect(r.session.tasksFailed).toBe(1);
  expect(r.session.denials).toBe(1);
});

test("runner records a bounded activity timeline", async () => {
  await setOvernightMode("ARMED");
  await enqueue({ description: "check git status", maxIterations: 2 });
  const stub = async (task) => ({
    status: "complete",
    evidence: [
      { kind: "tool", tool: "git.status", decision: "allow", success: true, verification: "ok", confidence: 0.9 },
    ],
    learning: null,
  });
  const r = await runOvernightSession({ maxTasks: 1, taskRunner: stub });
  expect(r.ok).toBe(true);
  const events = (r.session.timeline || []).map((e) => e.event);
  expect(events).toContain("session.started");
  expect(events).toContain("task.started");
  expect(events).toContain("tool.completed");
  expect(events).toContain("task.completed");
  expect(events).toContain("session.complete");
});

test("runner completes a 3-task session with failure isolation", async () => {
  await setOvernightMode("ARMED");
  await enqueue({ description: "a", maxIterations: 2 });
  await enqueue({ description: "b", maxIterations: 2 });
  await enqueue({ description: "c", maxIterations: 2 });
  const stub = async (task) => {
    if (task.goal === "b") return { status: "denied", evidence: [{ decision: "deny" }], learning: null };
    return { status: "complete", evidence: [{ tool: "git.status", decision: "allow", verification: "ok" }], learning: "learn-x" };
  };
  const r = await runOvernightSession({ maxTasks: 3, taskRunner: stub });
  expect(r.ok).toBe(true);
  expect(r.session.tasksAttempted).toBe(3);
  expect(r.session.tasksCompleted).toBe(2);
  expect(r.session.tasksFailed).toBe(1);
  expect(r.session.stopReason).toBe("session_complete");
  expect(r.session.workspaceChanged).toBe(false);
});
