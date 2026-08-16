/**
 * routing.mjs — local routing intelligence (observation layer only).
 *
 * Aggregates evaluation data and provides `suggestModel()` — a NON-authoritative
 * suggestion. It does NOT control production routing; it only reports whether
 * local Phi-4 has a strong verified history for a task category. MESH remains
 * the permission authority.
 */
import { listEvaluations } from "./evaluation.mjs";

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
