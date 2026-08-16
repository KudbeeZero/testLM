/**
 * local-runner.mjs — LOCAL autonomous engineering loop.
 *
 * A bounded, MESH-gated cycle with planner validation and denial-aware
 * replanning:
 *
 *   TASK → PLAN (model proposes tool) → VALIDATE → MESH → EXECUTE → OBSERVE
 *   → EVALUATE → VERIFY → STORE EVIDENCE → LEARN → NEXT ACTION (or stop)
 *
 * The model only PROPOSES a structured tool; the planner validates it against
 * the tool contracts; MESH authorizes; the executor runs it. On a MESH denial
 * the model may re-plan ONCE (bounded). MESH is never weakened.
 */
import { meshGate } from "./index.mjs";
import { localWorker, parseModelJson } from "./local-worker.mjs";
import { recordLearning } from "./learning.mjs";
import { buildEvaluation, recordEvaluation } from "./evaluation.mjs";
import { toolSchemaText, validateProposal, TOOL_CONTRACTS } from "./tool-contracts.mjs";

export const MAX_ITERATIONS = 3;
export const MAX_PLAN_ATTEMPTS = 2; // initial + one replan

const SCHEMA = toolSchemaText();

function planPrompt(task, evidence, feedback) {
  const fb = feedback
    ? `\nYour previous proposal was rejected. Feedback: ${feedback}\nChoose a DIFFERENT valid tool.`
    : "";
  return `You are a local engineering planner. Propose the next SINGLE tool to run.
AVAILABLE TOOLS (use ONLY these, exactly as named):
${SCHEMA}
Task: ${task.goal}
Evidence so far: ${JSON.stringify(evidence.slice(-2))}${fb}
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
  const modelLabel = opts.modelLabel || task.model || "phi4-mini";
  const maxIterations = opts.maxIterations || MAX_ITERATIONS;
  const taskId = task.id || `task-${Date.now()}`;
  const startMs = Date.now();

  const outcome = {
    taskId,
    goal: task.goal,
    status: "running",
    iterations: 0,
    evidence: [],
    plannerRetries: 0,
    meshDenials: 0,
    learning: null,
    finalResult: null,
    error: null,
    usage: null,
  };

  // Accumulate real provider usage across model calls (null when unavailable).
  const accumulateUsage = (u) => {
    if (!u) return;
    const base = outcome.usage || { prompt_tokens: 0, completion_tokens: 0, calls: 0 };
    base.prompt_tokens += u.prompt_tokens ?? u.input_tokens ?? 0;
    base.completion_tokens += u.completion_tokens ?? u.output_tokens ?? 0;
    base.calls += 1;
    outcome.usage = base;
  };

  for (let iter = 1; iter <= maxIterations; iter++) {
    outcome.iterations = iter;
    let feedback = null;

    for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
      // PLAN — model proposes a structured tool.
      const plan = await model(planPrompt(task, outcome.evidence, feedback));
      accumulateUsage(plan.usage);
      if (!plan.ok) {
        outcome.status = "plan_failed";
        outcome.error = plan.error || "model unavailable";
        return outcome;
      }
      const proposal = parseModelJson(plan.content);

      // Planner validation (before MESH).
      const v = validateProposal(proposal);
      outcome.evidence.push({
        iteration: iter,
        kind: "planner_validation",
        plan: plan.content,
        tool: proposal?.tool || null,
        valid: v.ok,
        reason: v.ok ? null : v.reason,
        timestamp: new Date().toISOString(),
      });
      if (!v.ok) {
        outcome.plannerRetries++;
        if (attempt < MAX_PLAN_ATTEMPTS) { feedback = v.reason; continue; }
        outcome.status = "planner_invalid";
        outcome.error = v.reason;
        return outcome;
      }

      // MESH authorization + execution.
      const gate = await meshGate({
        id: `${taskId}-${iter}-${attempt}`,
        agentId: "hermes",
        taskId,
        tool: v.tool,
        arguments: proposal.arguments || {},
      });

      const rec = {
        iteration: iter,
        kind: "tool",
        plan: plan.content,
        tool: v.tool,
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
        outcome.meshDenials++;
        if (attempt < MAX_PLAN_ATTEMPTS) {
          feedback = `DENIED: ${gate.reason}. Allowed tools: ${Object.keys(TOOL_CONTRACTS).join(", ")}`;
          continue;
        }
        outcome.status = "denied";
        outcome.error = gate.reason;
        return outcome;
      }

      // EVALUATE — model decides done / confidence.
      const evalRes = await model(evalPrompt(task, rec));
      accumulateUsage(evalRes.usage);
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
      break; // tool succeeded and evaluated — move to next iteration
    }
    if (outcome.status === "complete") break;
  }

  if (outcome.status === "running") outcome.status = "iteration_limit";

  // Evidence-backed learning (only if we have real evidence).
  const last = outcome.evidence.find((e) => e.kind === "tool" && e.success);
  if (last) {
    const lr = await recordLearning({
      taskId,
      observation: `task "${task.goal}" — tool ${last.tool} ${last.verification}`,
      evidence: { tool: last.tool, success: last.success, verification: last.verification },
      evaluation: last.evaluation || null,
      outcome: outcome.status,
      plannerRetries: outcome.plannerRetries,
      meshDenials: outcome.meshDenials,
    });
    outcome.learning = lr.ok ? lr.id : null;
  }

  outcome.durationMs = Date.now() - startMs;
  // RDTHINK evaluation record (feeds routing intelligence + benchmark).
  try {
    await recordEvaluation(buildEvaluation({ ...task, model: modelLabel }, outcome));
  } catch {
    // non-fatal: evaluation store must never break the task loop
  }

  return outcome;
}
