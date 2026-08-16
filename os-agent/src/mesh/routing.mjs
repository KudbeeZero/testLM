/**
 * routing.mjs — local routing intelligence (observation layer only).
 *
 * Aggregates evaluation data and provides `suggestModel()` — a NON-authoritative
 * suggestion. It does NOT control production routing; it only reports whether
 * local Phi-4 has a strong verified history for a task category. MESH remains
 * the permission authority.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "../config.js";
import { listEvaluations } from "./evaluation.mjs";

const DECISION_FILE = path.join(MEMORY_DIR, "local-routing-decisions.json");

/**
 * Conservative adaptive routing policy. These are RECOMMENDATION bounds only —
 * MESH remains the permission authority and the router can never grant
 * capability.
 */
export const ROUTING_POLICY = {
  MIN_SAMPLES: 3,          // require >=3 samples per task type before adapting
  MAX_LOCAL_ATTEMPTS: 3,   // three-strike rule: max local attempts before escalate/stop
  MAX_CLOUD_ESCALATIONS_PER_TASK: 1, // no recursive escalation
  LOCAL_CONFIDENCE_THRESHOLD: 0.7,   // below this, consider escalation
};

/** Aggregate routing stats from evaluation records. */
export async function routingIntelligence(evals = null) {
  const list = evals || await listEvaluations();
  if (!list.length) return { observed: 0, collecting: true };

  const byType = {};
  const tools = {};
  const failures = {};
  const recoveries = {};
  let success = 0, retries = 0, denials = 0, verified = 0, durationSum = 0, confSum = 0, confCount = 0;

  for (const e of list) {
    byType[e.taskType] = byType[e.taskType] || { n: 0, ok: 0 };
    byType[e.taskType].n++;
    if (e.finalStatus === "complete") { success++; byType[e.taskType].ok++; }
    retries += e.plannerRetries || 0;
    denials += e.meshDenials || 0;
    if (e.verification === "ok") verified++;
    if (e.durationMs != null) durationSum += e.durationMs;
    if (e.confidence != null) { confSum += e.confidence; confCount++; }
    for (const t of e.successfulTools || []) tools[t] = (tools[t] || 0) + 1;
    failures[e.failureClass] = (failures[e.failureClass] || 0) + 1;
    recoveries[e.recoveryClass] = (recoveries[e.recoveryClass] || 0) + 1;
  }

  return {
    observed: list.length,
    collecting: false,
    successRate: +(success / list.length).toFixed(3),
    plannerRetryRate: +(retries / list.length).toFixed(3),
    meshDenialRate: +(denials / list.length).toFixed(3),
    verificationRate: +(verified / list.length).toFixed(3),
    avgDurationMs: list.length ? Math.round(durationSum / list.length) : null,
    avgConfidence: confCount ? +(confSum / confCount).toFixed(3) : null,
    byType,
    topTools: Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 5),
    topFailures: Object.entries(failures).sort((a, b) => b[1] - a[1]).slice(0, 5),
    topRecoveries: Object.entries(recoveries).sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

/**
 * Suggest a model for a task based on evidence. OBSERVATION ONLY.
 * Returns { model, reason, confidence, escalation }.
 */
export async function suggestModel(taskType, evals = null) {
  const list = evals || await listEvaluations();
  const relevant = list.filter((e) => e.taskType === taskType);
  if (relevant.length < 3) {
    return { model: "local", reason: "Insufficient evidence for escalation", confidence: 0.5, escalation: false };
  }
  const ok = relevant.filter((e) => e.finalStatus === "complete").length;
  const rate = ok / relevant.length;
  if (rate >= 0.8) {
    return { model: "local", reason: `Phi-4 verified ${(rate * 100).toFixed(0)}% of ${relevant.length} ${taskType} tasks`, confidence: +rate.toFixed(2), escalation: false };
  }
  if (rate < 0.5) {
    return { model: "gemini", reason: `Phi-4 only verified ${(rate * 100).toFixed(0)}% of ${taskType} — consider escalation`, confidence: +(1 - rate).toFixed(2), escalation: true };
  }
  return { model: "local", reason: `Phi-4 verified ${(rate * 100).toFixed(0)}% — monitor`, confidence: +rate.toFixed(2), escalation: false };
}

/** Per-task-type stats from accumulated evidence. Returns null with no samples. */
export async function taskTypeStats(taskType, evals = null) {
  const list = evals || await listEvaluations();
  const relevant = list.filter((e) => e.taskType === taskType);
  if (!relevant.length) return null;
  const ok = relevant.filter((e) => e.finalStatus === "complete").length;
  const replans = relevant.reduce((s, e) => s + (e.plannerRetries || 0), 0);
  const denials = relevant.reduce((s, e) => s + (e.meshDenials || 0), 0);
  const verified = relevant.filter((e) => e.verification === "ok").length;
  const latencySum = relevant.reduce((s, e) => s + (e.durationMs || 0), 0);
  const costSum = relevant.reduce((s, e) => s + (e.costUsd || 0), 0);
  return {
    taskType,
    sampleCount: relevant.length,
    localSuccessRate: +(ok / relevant.length).toFixed(3),
    localFailureRate: +((relevant.length - ok) / relevant.length).toFixed(3),
    replanRate: +(replans / relevant.length).toFixed(3),
    meshDenialRate: +(denials / relevant.length).toFixed(3),
    verificationRate: +(verified / relevant.length).toFixed(3),
    avgLatencyMs: Math.round(latencySum / relevant.length),
    avgCost: +costSum.toFixed(4),
  };
}

/**
 * Adaptive routing decision. RECOMMENDATION ONLY — never authorization.
 *
 * Conservative: stays local by default, only recommends escalation when there
 * is enough evidence (>= MIN_SAMPLES) AND local success is below threshold.
 * If cloud cost is UNKNOWN, escalation is blocked unless an explicit policy
 * opts in (costStatus !== "UNKNOWN").
 */
export async function routingDecision(taskType, { evals = null, costStatus = "UNKNOWN", allowEscalation = false } = {}) {
  const decision = {
    taskId: null,
    taskType,
    localModel: "phi4-mini",
    localAttempts: 0,
    confidence: 0.5,
    failures: 0,
    verification: null,
    escalation: false,
    selectedModel: "local",
    reason: "default_local",
    estimatedCost: null,
    actualCost: null,
    timestamp: new Date().toISOString(),
  };

  const stats = await taskTypeStats(taskType, evals);
  if (!stats || stats.sampleCount < ROUTING_POLICY.MIN_SAMPLES) {
    decision.reason = "insufficient_samples_default_local";
    return decision;
  }

  decision.localAttempts = Math.min(stats.sampleCount, ROUTING_POLICY.MAX_LOCAL_ATTEMPTS);
  decision.failures = stats.sampleCount - Math.round(stats.localSuccessRate * stats.sampleCount);
  decision.confidence = stats.localSuccessRate;
  decision.verification = stats.verificationRate;
  decision.estimatedCost = stats.avgCost;

  if (stats.localSuccessRate < ROUTING_POLICY.LOCAL_CONFIDENCE_THRESHOLD) {
    decision.escalation = true;
    decision.selectedModel = "gemini";
    decision.reason = `local_success_${(stats.localSuccessRate * 100).toFixed(0)}pct_below_threshold`;
  } else {
    decision.reason = `local_reliable_${(stats.localSuccessRate * 100).toFixed(0)}pct`;
  }

  // Never auto-escalate on unknown cloud cost unless explicitly allowed.
  if (decision.escalation && costStatus === "UNKNOWN" && !allowEscalation) {
    decision.escalation = false;
    decision.selectedModel = "local";
    decision.reason = "escalation_blocked_unknown_cost";
  }
  return decision;
}

async function loadDecisions() {
  try {
    const d = JSON.parse(await readFile(DECISION_FILE, "utf8"));
    return d.decisions || [];
  } catch {
    return [];
  }
}

/** Persist a routing decision as RDTHINK evidence. Non-fatal on error. */
export async function recordRoutingDecision(rec) {
  if (!rec || !rec.taskType) return null;
  const all = await loadDecisions();
  all.push(rec);
  try {
    await writeFile(DECISION_FILE, JSON.stringify({ version: 1, decisions: all.slice(-500) }, null, 2));
  } catch {
    // non-fatal
  }
  return rec;
}

export async function listRoutingDecisions() {
  return loadDecisions();
}
