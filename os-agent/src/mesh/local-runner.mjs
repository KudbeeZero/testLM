/**
 * local-runner.mjs — LOCAL autonomous engineering loop.
 *
 * A bounded, MESH-gated cycle:
 *
 *   TASK → PLAN (model proposes tool) → MESH → EXECUTE → OBSERVE → EVALUATE
 *   → VERIFY → STORE EVIDENCE → LEARN → NEXT ACTION (or stop)
 *
 * The model only PROPOSES a structured tool; MESH authorizes; the executor
 * runs it. The loop is bounded (MAX_ITERATIONS) and failure-safe. AWS is NOT
 * required — this runs entirely on the laptop.
 */
import { meshGate } from "./index.mjs";
import { localWorker, parseModelJson } from "./local-worker.mjs";
import { recordLearning } from "./learning.mjs";

export const MAX_ITERATIONS = 3;

// Prompt templates (kept small so a cheap local model can follow them).
function planPrompt(task, evidence) {
  return `You are a local engineering planner. Propose the next SINGLE tool to run.
Available tools: git.status, git.diff, project.check, project.test, file.read, filesystem.list, filesystem.search.
Task: ${task.goal}
Evidence so far: ${JSON.stringify(evidence.slice(-2))}
Return ONLY JSON: {"tool":"<tool>","arguments":{}}`;
}

function evalPrompt(task, rec) {
  return `You are a local engineering evaluator. Given the task and the latest tool result, decide if the task is complete.
Task: ${task.goal}
Latest result: ${JSON.stringify({ tool: rec.tool, success: rec.success, output: (rec.result && rec.result.output || "").slice(0, 500), error: rec.result && rec.result.error || null })}
Return ONLY JSON: {"done":true|false,"confidence":0.0,"note":"..."}`;
}

/**
 * Run a bounded local engineering task.
 * @param {object} task  { id, goal, ... }
 * @param {object} opts  { model (injectable), maxIterations }
 * @returns {Promise<object>} outcome with structured evidence
 */
export async function runLocalTask(task, opts = {}) {
  const model = opts.model || localWorker;
  const maxIterations = opts.maxIterations || MAX_ITERATIONS;
  const taskId = task.id || `task-${Date.now()}`;

  const outcome = {
    taskId,
    goal: task.goal,
    status: "running",
    iterations: 0,
    evidence: [],
    learning: null,
    finalResult: null,
    error: null,
  };

  for (let iter = 1; iter <= maxIterations; iter++) {
    outcome.iterations = iter;

    // PLAN — model proposes a structured tool.
    const plan = await model(planPrompt(task, outcome.evidence));
    if (!plan.ok) {
      outcome.status = "plan_failed";
      outcome.error = plan.error || "model unavailable";
      break;
    }
    const proposal = parseModelJson(plan.content);
    if (!proposal || !proposal.tool) {
      outcome.status = "malformed_plan";
      outcome.error = "model returned malformed plan (no tool)";
      break;
    }

    // MESH authorization + execution.
    const gate = await meshGate({
      id: `${taskId}-${iter}`,
      agentId: "hermes",
      taskId,
      tool: proposal.tool,
      arguments: proposal.arguments || {},
    });

    const rec = {
      iteration: iter,
      plan: plan.content,
      tool: proposal.tool,
      arguments: proposal.arguments || {},
      decision: gate.decision,
      success: gate.success,
      result: gate.result || null,
      durationMs: gate.result?.durationMs ?? null,
      observation: gate.success ? "ok" : (gate.reason || "denied"),
      evaluation: null,
      verification: gate.success ? "ok" : "failed",
      confidence: null,
      timestamp: new Date().toISOString(),
    };
    outcome.evidence.push(rec);

    if (!gate.success) {
      outcome.status = "denied";
      outcome.error = gate.reason;
      break;
    }

    // EVALUATE — model decides done / confidence.
    const evalRes = await model(evalPrompt(task, rec));
    if (evalRes.ok) {
      const parsed = parseModelJson(evalRes.content);
      if (parsed) {
        rec.evaluation = parsed.note || "";
        rec.confidence = typeof parsed.confidence === "number" ? parsed.confidence : null;
        if (parsed.done === true) {
          outcome.status = "complete";
          outcome.finalResult = rec.result;
          break;
        }
      }
    }
  }

  if (outcome.status === "running") outcome.status = "iteration_limit";

  // Evidence-backed learning (only if we have real evidence).
  const last = outcome.evidence[outcome.evidence.length - 1];
  if (last && last.success) {
    const lr = await recordLearning({
      taskId,
      observation: `task "${task.goal}" — tool ${last.tool} ${last.verification}`,
      evidence: { tool: last.tool, success: last.success, verification: last.verification },
      evaluation: last.evaluation || null,
      outcome: outcome.status,
    });
    outcome.learning = lr.ok ? lr.id : null;
  }

  return outcome;
}
