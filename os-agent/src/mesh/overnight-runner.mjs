/**
 * overnight-runner.mjs — bounded local overnight engine.
 *
 * Runs queued safe tasks through the MESH-gated local loop, enforcing:
 *   - a machine-readable safety manifest (validated before start)
 *   - a single-session lock (no two runners)
 *   - task / iteration / runtime limits
 *   - workspace integrity (git status must not change)
 *   - crash recovery (an interrupted RUNNING session requires explicit re-arm)
 *
 * AWS / network / production / mutation are all off. Read-only + test + analyze.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { WORKSPACE, MEMORY_DIR } from "../config.js";
import { runTaskWithEscalation, ESCALATION_LIMITS } from "./local-runner.mjs";
import { getState, setState, setOvernightMode } from "./agent-state.mjs";
import { nextQueued, updateTask } from "./task-queue.mjs";

const SESSION_FILE = path.join(MEMORY_DIR, "local-session.json");

async function persistSession(session) {
  try {
    const all = JSON.parse(await readFile(SESSION_FILE, "utf8").catch(() => "[]"));
    all.unshift(session);
    await writeFile(SESSION_FILE, JSON.stringify(all.slice(0, 20), null, 2));
  } catch {
    // non-fatal
  }
}

export async function getLatestSession() {
  try {
    const all = JSON.parse(await readFile(SESSION_FILE, "utf8"));
    return all[0] || null;
  } catch {
    return null;
  }
}

export const SAFETY_MANIFEST = {
  mode: "local-readonly",
  maxRisk: "L1",
  capabilities: [
    "filesystem.read", "filesystem.list", "filesystem.search",
    "git.read", "project.check", "project.test",
  ],
  network: false,
  aws: false,
  production: false,
  mutation: false,
  packageInstall: false,
  gitWrite: false,
  secretAccess: false,
};

export const LIMITS = {
  MAX_TASKS_PER_RUN: 10,
  MAX_ITERATIONS_PER_TASK: 3,
  MAX_TOTAL_ITERATIONS: 20,
  MAX_RUNTIME_MINUTES: 60,
  MAX_CLOUD_ESCALATIONS_PER_SESSION: ESCALATION_LIMITS.MAX_CLOUD_ESCALATIONS_PER_SESSION,
};

let running = false;

function gitStatus() {
  try {
    return execFileSync("git", ["status", "--short"], { cwd: WORKSPACE, encoding: "utf8", timeout: 10000 });
  } catch {
    return "";
  }
}

/** Validate the safety manifest — the runner refuses to start if it fails. */
export function validateManifest(m = SAFETY_MANIFEST) {
  if (m.mode !== "local-readonly") return { ok: false, error: "mode must be local-readonly" };
  if (m.maxRisk !== "L1") return { ok: false, error: "maxRisk must be L1" };
  if (m.network || m.aws || m.production || m.mutation || m.packageInstall || m.gitWrite || m.secretAccess) {
    return { ok: false, error: "unsafe flag set in manifest" };
  }
  return { ok: true };
}

/**
 * Run a bounded overnight session.
 * @returns {{ok:boolean, session?:object, error?:string}}
 */
export async function runOvernightSession({ maxTasks = LIMITS.MAX_TASKS_PER_RUN, taskRunner = runTaskWithEscalation } = {}) {
  const st = await getState();
  if (st.overnightMode === "RUNNING") return { ok: false, error: "session already running" };
  if (running) return { ok: false, error: "session already running" };
  if (st.overnightMode !== "ARMED") return { ok: false, error: "runner not armed" };

  const manifest = validateManifest();
  if (!manifest.ok) return { ok: false, error: manifest.error };

  running = true;
  await setOvernightMode("RUNNING");
  await setState({ startedAt: new Date().toISOString(), error: null });

  const before = gitStatus();
  const session = {
    id: `session-${Date.now()}`,
    start: new Date().toISOString(),
    tasksAttempted: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    toolsUsed: [],
    denials: 0,
    modelFailures: 0,
    testResults: [],
    learnings: [],
    stopReason: null,
    workspaceChanged: false,
    timeline: [],
    tasks: [],
    cost: { localCost: 0, cloudCost: 0, totalCost: 0, costStatus: "UNKNOWN" },
    escalations: 0,
  };
  let sessionCloudUsed = 0;
  const startMs = Date.now();
  const pushTimeline = (event) => {
    session.timeline.push({ ts: new Date().toISOString(), ...event });
  };
  pushTimeline({ event: "session.started", state: "planning" });

  try {
    for (let t = 0; t < maxTasks; t++) {
      if (Date.now() - startMs > LIMITS.MAX_RUNTIME_MINUTES * 60000) {
        session.stopReason = "runtime_limit";
        break;
      }
      const task = await nextQueued();
      if (!task) {
        session.stopReason = "queue_empty";
        break;
      }
      session.tasksAttempted++;
      await setState({ currentTaskId: task.id, currentTask: task.description, state: "planning" });
      pushTimeline({ event: "task.started", task: task.id, goal: task.description, state: "planning" });

      const res = await taskRunner(
        { id: task.id, goal: task.description, sessionId: session.id, skill: task.skill || null },
        { maxIterations: task.maxIterations || LIMITS.MAX_ITERATIONS_PER_TASK, sessionCloudUsed, sessionCloudBudget: LIMITS.MAX_CLOUD_ESCALATIONS_PER_SESSION }
      );
      // Support both runTaskWithEscalation (wrapper) and legacy stub runners.
      const out = (res && res.outcome) ? res.outcome : res;
      const journey = (res && res.modelJourney) || null;
      const esc = (res && res.escalation) || null;
      if (esc && esc.escalated) sessionCloudUsed++;

      await updateTask(task.id, { status: out.status === "complete" ? "complete" : "failed", result: out.status });

      if (out.status === "complete") session.tasksCompleted++;
      else session.tasksFailed++;
      if (out.learning) session.learnings.push(out.learning);

      // Per-task cost accounting (truthful; never fabricated).
      if (out.cost != null) {
        if (out.provider === "gemini") session.cost.cloudCost += out.cost;
        else session.cost.localCost += out.cost;
      }
      session.cost.totalCost = +(session.cost.localCost + session.cost.cloudCost).toFixed(4);
      if (out.costStatus) session.cost.costStatus = out.costStatus;

      for (const e of out.evidence || []) {
        if (e.tool && !session.toolsUsed.includes(e.tool)) session.toolsUsed.push(e.tool);
        if (e.decision === "deny") session.denials++;
        if (e.verification === "failed") session.modelFailures++;
        if (e.kind === "tool") {
          pushTimeline({
            event: e.decision === "allow" ? "tool.completed" : "tool.denied",
            task: task.id, tool: e.tool, decision: e.decision,
            success: e.success, verification: e.verification,
            confidence: e.confidence ?? null,
          });
        } else if (e.kind === "planner_validation" && !e.valid) {
          pushTimeline({ event: "planner.invalid", task: task.id, reason: e.reason, state: "planning" });
        }
      }
      if (esc && esc.escalated) {
        session.escalations++;
        pushTimeline({ event: "escalation", task: task.id, to: "gemini", reason: esc.reason });
      }
      // Morning Report model journey record.
      session.tasks.push({
        taskId: task.id,
        goal: task.description,
        status: out.status,
        initialModel: journey ? journey.initialModel : (out.provider || "phi4-mini"),
        finalModel: journey ? journey.finalModel : (out.provider || "phi4-mini"),
        attempts: journey ? journey.attempts : (out.iterations || 0),
        escalated: journey ? journey.escalated : false,
        escalationReason: journey ? journey.escalationReason : null,
        verification: journey ? journey.verification : (out.verification ?? null),
        cost: journey ? journey.cost : (out.cost ?? null),
        costStatus: journey ? journey.costStatus : (out.costStatus || "UNKNOWN"),
        tools: out.evidence ? out.evidence.filter((e) => e.kind === "tool").map((e) => e.tool) : [],
        learning: out.learning || null,
      });
      pushTimeline({
        event: out.status === "complete" ? "task.completed" : "task.failed",
        task: task.id, status: out.status, state: out.status === "complete" ? "complete" : "failed",
      });
      await setState({ state: "idle", currentTaskId: null, currentTask: null, iteration: 0 });
    }

    const after = gitStatus();
    session.workspaceChanged = after !== before;
    if (session.workspaceChanged) session.stopReason = "unexpected_workspace_change";
    else if (!session.stopReason) session.stopReason = "session_complete";
    pushTimeline({ event: "session.complete", stopReason: session.stopReason, state: "complete" });
  } catch (e) {
    session.stopReason = "runner_error";
    session.error = String((e && e.message) || e);
    pushTimeline({ event: "session.error", error: session.error, state: "failed" });
  } finally {
    session.end = new Date().toISOString();
    session.durationMs = Date.now() - startMs;
    await setOvernightMode("STOPPED");
    await setState({ state: "stopped", error: session.stopReason });
    running = false;
  }

  await persistSession(session);
  return { ok: true, session };
}
