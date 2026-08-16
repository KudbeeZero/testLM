import { test, expect } from "bun:test";
import { recordProviderCall, listProviderCalls, providerTelemetry } from "./provider-telemetry.mjs";

test("recordProviderCall normalizes a local call with ACTUAL cost", async () => {
  const rec = await recordProviderCall({
    taskType: "repository-health", provider: "local", model: "phi4-mini", success: true,
    latencyMs: 100, inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: 0, costStatus: "ACTUAL",
  });
  expect(rec.provider).toBe("local");
  expect(rec.costStatus).toBe("ACTUAL");
  expect(rec.totalTokens).toBe(15);
});

test("recordProviderCall marks unknown cost as UNKNOWN (never fabricated)", async () => {
  const rec = await recordProviderCall({
    taskType: "x", provider: "gemini", model: "gemini-flash-latest", success: true,
    latencyMs: 50, cost: null, costStatus: "UNKNOWN",
  });
  expect(rec.cost).toBeNull();
  expect(rec.costStatus).toBe("UNKNOWN");
});

test("providerTelemetry aggregates by provider and counts cloud escalations", async () => {
  await recordProviderCall({ taskType: "a", provider: "local", success: true, latencyMs: 10, cost: 0, costStatus: "ACTUAL" });
  await recordProviderCall({ taskType: "a", provider: "local", success: true, latencyMs: 20, cost: 0, costStatus: "ACTUAL" });
  await recordProviderCall({ taskType: "a", provider: "gemini", success: true, latencyMs: 30, cost: 0.001, costStatus: "ESTIMATED" });
  const t = await providerTelemetry();
  expect(t.collecting).toBe(false);
  expect(t.byProvider.local.calls).toBeGreaterThanOrEqual(2);
  expect(t.byProvider.gemini.calls).toBeGreaterThanOrEqual(1);
  expect(t.cloudEscalations).toBeGreaterThanOrEqual(1);
});

test("providerTelemetry reports collecting when empty", async () => {
  // Can't easily empty the shared store; verify the shape is safe.
  const t = await providerTelemetry();
  expect(typeof t.observed).toBe("number");
  expect(t.collecting).toBe(t.observed === 0);
});
