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
import { localWorker, geminiWorker, parseModelJson } from "./local-worker.mjs";
import { recordLearning } from "./learning.mjs";
import { buildEvaluation, recordEvaluation } from "./evaluation.mjs";
import { routingDecision } from "./routing.mjs";
import { recordEscalation } from "./escalation.mjs";
import { PRICING, ALLOW_UNKNOWN_CLOUD_COST } from "../config.js";
import { toolSchemaText, validateProposal, TOOL_CONTRACTS } from "./tool-contracts.mjs";

export const MAX_ITERATIONS = 3;
export const MAX_PLAN_ATTEMPTS = 2; // initial + one replan

/** Hard escalation limits (session-level protection). */
export const ESCALATION_LIMITS = {
  MAX_LOCAL_ATTEMPTS: 3,
  MAX_CLOUD_ESCALATIONS_PER_TASK: 1,
  MAX_CLOUD_ESCALATIONS_PER_SESSION: 2,
};

/** Cloud cost status: ESTIMATED only if Gemini pricing is configured. */
function cloudCostStatus() {
  const p = PRICING.gemini || {};
  return (p.inPer1k > 0 || p.outPer1k > 0) ? "ESTIMATED" : "UNKNOWN";
}

/** Derive verification from the last tool evidence (null if none). */
function outcomeVerification(out) {
  const tools = (out.evidence || []).filter((e) => e.kind === "tool");
  const last = tools[tools.length - 1];
  return last ? last.verification : null;
}

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
    provider: null,
    model: null,
    cost: null,
    costStatus: "UNKNOWN",
    latencyMs: null,
    requestId: null,
  };

  // Accumulate real provider usage + cost metadata across model calls.
  // Never fabricates: missing fields stay null/UNKNOWN.
  const accumulateUsage = (u) => {
    if (!u) return;
    const base = outcome.usage || { prompt_tokens: 0, completion_tokens: 0, calls: 0 };
    base.prompt_tokens += u.inputTokens ?? u.prompt_tokens ?? u.input_tokens ?? 0;
    base.completion_tokens += u.outputTokens ?? u.completion_tokens ?? u.output_tokens ?? 0;
    base.calls += 1;
    outcome.usage = base;
  };
  const accumulateMeta = (m) => {
    if (!m) return;
    if (m.provider) outcome.provider = m.provider;
    if (m.model) outcome.model = m.model;
    if (m.cost != null) outcome.cost = (outcome.cost ?? 0) + m.cost;
    if (m.costStatus) outcome.costStatus = m.costStatus;
    if (m.latencyMs != null) outcome.latencyMs = (outcome.latencyMs ?? 0) + m.latencyMs;
    if (m.requestId) outcome.requestId = m.requestId;
  };

  for (let iter = 1; iter <= maxIterations; iter++) {
    outcome.iterations = iter;
    let feedback = null;

    for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
      // PLAN — model proposes a structured tool.
      const plan = await model(planPrompt(task, outcome.evidence, feedback));
      accumulateUsage(plan.usage);
      accumulateMeta(plan);
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
      accumulateMeta(evalRes);
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

/**
 * Bounded local -> cloud escalation task runner.
 *
 * Phi-4 runs first. Only if it fails AND historical routing evidence recommends
 * escalation AND the cloud cost gate + session budget allow it does Gemini run.
 * Gemini gets the SAME MESH boundary as Phi-4 (its intelligence does not
 * increase its authority). Every decision is recorded as RDTHINK evidence.
 */
export async function runTaskWithEscalation(task, opts = {}) {
  const {
    localModel = localWorker,
    escalationModel = geminiWorker,
    maxLocalAttempts = ESCALATION_LIMITS.MAX_LOCAL_ATTEMPTS,
    maxCloudPerTask = ESCALATION_LIMITS.MAX_CLOUD_ESCALATIONS_PER_TASK,
    sessionCloudBudget = ESCALATION_LIMITS.MAX_CLOUD_ESCALATIONS_PER_SESSION,
    sessionCloudUsed = 0,
    allowUnknownCost = ALLOW_UNKNOWN_CLOUD_COST,
    decisionFn = routingDecision,
  } = opts;

  const taskType = task.skill || "generic";
  const escalation = {
    taskId: task.id || `task-${Date.now()}`,
    taskType,
    reason: null,
    localAttempts: 0,
    localConfidence: null,
    failures: 0,
    verification: null,
    selectedModel: "local",
    provider: "local",
    costStatus: "UNKNOWN",
    cost: null,
    timestamp: new Date().toISOString(),
    escalated: false,
  };

  const modelJourney = {
    initialModel: "phi4-mini",
    finalModel: "phi4-mini",
    attempts: 0,
    escalated: false,
    escalationReason: null,
    verification: null,
    cost: null,
    costStatus: "UNKNOWN",
  };

  // 1. Phi-4 first (default worker).
  const localOut = await runLocalTask(task, { model: localModel, modelLabel: "phi4-mini", maxIterations: maxLocalAttempts });
  escalation.localAttempts = localOut.iterations;
  escalation.localConfidence = localOut.confidence ?? null;
  escalation.verification = outcomeVerification(localOut);
  escalation.costStatus = localOut.costStatus || "UNKNOWN";
  escalation.cost = localOut.cost ?? null;
  modelJourney.attempts = localOut.iterations;
  modelJourney.verification = outcomeVerification(localOut);
  modelJourney.cost = localOut.cost ?? null;
  modelJourney.costStatus = localOut.costStatus || "UNKNOWN";

  if (localOut.status === "complete") {
    escalation.reason = "local_success";
    await recordEscalation(escalation);
    return { outcome: localOut, escalated: false, escalation, localOut: null, modelJourney };
  }

  // 2. Local failed — consult historical routing evidence + cost/budget gates.
  escalation.failures = 1;
  const cloudCost = cloudCostStatus();
  const decision = await decisionFn(taskType, { costStatus: cloudCost, allowEscalation: allowUnknownCost });
  const costGateOk = cloudCost !== "UNKNOWN" || allowUnknownCost;
  const budgetOk = sessionCloudUsed < sessionCloudBudget && maxCloudPerTask >= 1;

  if (!decision.escalation || !costGateOk || !budgetOk) {
    escalation.reason = decision.reason || "no_escalation";
    if (!costGateOk) escalation.reason = "escalation_blocked_unknown_cost";
    else if (!budgetOk) escalation.reason = "escalation_budget_exhausted";
    escalation.selectedModel = "local";
    await recordEscalation(escalation);
    return { outcome: localOut, escalated: false, escalation, localOut, modelJourney };
  }

  // 3. Escalate to Gemini (bounded). Same MESH boundary.
  escalation.reason = decision.reason;
  escalation.selectedModel = "gemini";
  escalation.provider = "gemini";
  escalation.escalated = true;
  const gemOut = await runLocalTask(task, { model: escalationModel, modelLabel: "gemini-flash-latest", maxIterations: maxLocalAttempts });
  escalation.cost = gemOut.cost ?? null;
  escalation.costStatus = gemOut.costStatus || "UNKNOWN";
  escalation.verification = outcomeVerification(gemOut);
  await recordEscalation(escalation);

  modelJourney.finalModel = "gemini-flash-latest";
  modelJourney.escalated = true;
  modelJourney.escalationReason = decision.reason;
  modelJourney.attempts = localOut.iterations + gemOut.iterations;
  modelJourney.verification = outcomeVerification(gemOut);
  modelJourney.cost = gemOut.cost ?? null;
  modelJourney.costStatus = gemOut.costStatus || "UNKNOWN";

  return { outcome: gemOut, escalated: true, escalation, localOut, modelJourney };
}
