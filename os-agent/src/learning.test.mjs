/**
 * os-agent/src/learning.test.mjs — PR-6 (learning→test) + PR-7 (regression).
 * Run: bun test os-agent/src/learning.test.mjs
 */
import { test, expect } from "bun:test";
import {
  createLearning,
  validateLearning,
  activate,
  generateTestSpec,
  recordRegression,
} from "./learning.js";

test("generateTestSpec returns null for unvalidated learnings", () => {
  const l = createLearning({ topic: "memory", insight: "high usage", recommendation: "monitor" });
  expect(generateTestSpec(l)).toBeNull(); // DRAFT
  validateLearning(l, { sampleCount: 0, successCount: 0, failureCount: 0 });
  expect(generateTestSpec(l)).toBeNull(); // still DRAFT (no evidence)
});

test("generateTestSpec produces a spec for VALIDATED learning", () => {
  const l = createLearning({ topic: "normalization", insight: "envelope requires ingested_at", recommendation: "validate ingested_at", taskType: "normalization", evidenceId: "ev-1" });
  validateLearning(l, { sampleCount: 10, successCount: 9, failureCount: 1 }); // conf 0.9 → VERIFIED
  const spec = generateTestSpec(l);
  expect(spec).not.toBeNull();
  expect(spec.learningId).toBe(l.learningId);
  expect(spec.taskType).toBe("normalization");
  expect(spec.input).toBe(l.insight);
  expect(spec.expectedBehavior).toBe(l.recommendation);
  expect(spec.sourceEvidence).toBe("ev-1");
  expect(spec.testId).toMatch(/^tst-/);
});

test("generateTestSpec produces a spec for ACTIVE learning", () => {
  const l = createLearning({ topic: "classification", insight: "phi4 routine", recommendation: "route to phi4" });
  validateLearning(l, { sampleCount: 5, successCount: 5, failureCount: 0 }); // VERIFIED
  activate(l); // → ACTIVE
  expect(generateTestSpec(l)).not.toBeNull();
});

test("recordRegression returns attributable regression record", () => {
  const r = recordRegression({
    learningId: "lrn-abc",
    traceId: "tr-1",
    failureId: "f-1",
    agentId: "os-agent",
    provider: "phi4",
    model: "qwen3-8b",
    failure: "normalization omitted ingested_at",
  });
  expect(r.regressionId).toMatch(/^reg-/);
  expect(r.learningId).toBe("lrn-abc");
  expect(r.traceId).toBe("tr-1");
  expect(r.failureId).toBe("f-1");
  expect(r.agentId).toBe("os-agent");
  expect(r.provider).toBe("phi4");
  expect(r.model).toBe("qwen3-8b");
  expect(r.failure).toBe("normalization omitted ingested_at");
  expect(r.createdAt).toBeTruthy();
});

test("recordRegression allows null provenance (never fabricated)", () => {
  const r = recordRegression({ failure: "timeout" });
  expect(r.learningId).toBeNull();
  expect(r.traceId).toBeNull();
  expect(r.failureId).toBeNull();
});
