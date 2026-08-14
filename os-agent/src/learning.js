/**
 * os-agent/src/learning.js
 * ---------------------------------------------------------------------------
 * KUDBEE closed-loop learning primitives (Phase 4D, P0/P1).
 *
 * Provides a minimal, deterministic learning lifecycle with provenance so
 * that os-agent learnings can be traced to evidence/outcome and linked to the
 * richer THINK-token ecosystem by ID (not duplicated).
 *
 * Lifecycle: OBSERVED -> CANDIDATE -> VALIDATED -> ACTIVE -> DEPRECATED
 *
 * A model-generated suggestion is NEVER automatically VALIDATED/ACTIVE —
 * validation requires evidence (sampleCount/successCount/failureCount).
 * ---------------------------------------------------------------------------
 */

export const LEARNING_STATUS = ["OBSERVED", "CANDIDATE", "VALIDATED", "ACTIVE", "DEPRECATED"];

let idCounter = 0;
function genId(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** Normalize a string for deterministic dedup. */
function norm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Create a learning record with provenance. Unknown IDs use null (never
 * fabricated). Status starts at OBSERVED.
 */
export function createLearning({
  topic, insight, recommendation,
  source = "os-agent", taskType = null, agentId = "os-agent",
  provider = null, model = null,
  traceId = null, evidenceId = null, outcomeId = null, thinkTokenId = null,
}) {
  return {
    learningId: genId("lrn"),
    topic, insight, recommendation,
    source, taskType, agentId, provider, model,
    traceId, evidenceId, outcomeId, thinkTokenId,
    status: "OBSERVED",
    confidence: null,
    sampleCount: 0, successCount: 0, failureCount: 0,
    evaluationMethod: null,
    createdAt: new Date().toISOString(),
    validatedAt: null,
    lastObservedAt: new Date().toISOString(),
    version: 1,
  };
}

/**
 * Validate a candidate learning against evidence. Without evidence the status
 * stays CANDIDATE (never VALIDATED on a model's word alone).
 */
export function validateLearning(learning, { sampleCount = 0, successCount = 0, failureCount = 0, evaluationMethod = "router_validation", threshold = 0.7 }) {
  const total = sampleCount || (successCount + failureCount);
  if (total <= 0) {
    learning.status = "CANDIDATE";
    return learning;
  }
  const confidence = successCount / total;
  learning.confidence = confidence;
  learning.sampleCount = sampleCount;
  learning.successCount = successCount;
  learning.failureCount = failureCount;
  learning.evaluationMethod = evaluationMethod;
  learning.validatedAt = new Date().toISOString();
  learning.status = confidence >= threshold ? "VALIDATED" : "CANDIDATE";
  return learning;
}

/** Promote a VALIDATED learning to ACTIVE (bumps version). */
export function activate(learning) {
  if (learning.status === "VALIDATED") {
    learning.status = "ACTIVE";
    learning.version += 1;
  }
  return learning;
}

/** Deprecate a learning (history preserved, never deleted). */
export function deprecate(learning, reason) {
  learning.status = "DEPRECATED";
  learning.deprecationReason = reason;
  return learning;
}

/**
 * P0 no-call check: deterministically decide whether an equivalent learning
 * already exists so we can avoid an unnecessary model call.
 */
export function noCallCheck(existingLearnings, { topic, insight }) {
  const t = norm(topic);
  const i = norm(insight);
  if (!t && !i) return false;
  return existingLearnings.some((l) => {
    const lt = norm(l.topic);
    const li = norm(l.insight);
    return (t && lt === t) || (i && li === i);
  });
}

/**
 * P1 learning -> test generation. Only VALIDATED/ACTIVE learnings produce a
 * test specification (a test artifact, not an autonomous code change).
 */
export function generateTestSpec(learning) {
  if (learning.status !== "VALIDATED" && learning.status !== "ACTIVE") return null;
  return {
    testId: genId("tst"),
    learningId: learning.learningId,
    taskType: learning.taskType,
    input: learning.insight,
    expectedBehavior: learning.recommendation,
    evaluationCriteria: `output must be valid and align with: ${learning.insight}`,
    sourceEvidence: learning.evidenceId,
    version: learning.version,
    createdAt: new Date().toISOString(),
  };
}

/**
 * P1 regression knowledge: record a verified failure as a regression record
 * so the system does not relearn the same failure.
 */
export function recordRegression({ learningId = null, traceId = null, failureId = null, agentId = "os-agent", provider = null, model = null, failure }) {
  return {
    regressionId: genId("reg"),
    learningId, traceId, failureId, agentId, provider, model,
    failure,
    createdAt: new Date().toISOString(),
  };
}
