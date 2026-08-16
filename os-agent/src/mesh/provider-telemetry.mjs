/**
 * provider-telemetry.mjs — KUDBEE-native provider telemetry layer.
 *
 * Normalizes every model invocation into a bounded local record. Persists to
 * the existing local memory architecture (no new database). Cost is never
 * fabricated: costStatus is ACTUAL / ESTIMATED / UNKNOWN.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "../config.js";

const FILE = path.join(MEMORY_DIR, "provider-telemetry.json");

async function load() {
  try {
    const d = JSON.parse(await readFile(FILE, "utf8"));
    return d.calls || [];
  } catch {
    return [];
  }
}

/**
 * Record one normalized provider call. Non-fatal on storage errors.
 * @param {object} rec { taskType, provider, model, success, latencyMs, inputTokens, outputTokens, totalTokens, cost, costStatus, failureClass }
 */
export async function recordProviderCall(rec) {
  if (!rec || !rec.provider) return null;
  const all = await load();
  const entry = {
    ts: new Date().toISOString(),
    taskType: rec.taskType || "unknown",
    provider: rec.provider,
    model: rec.model || null,
    success: rec.success,
    latencyMs: rec.latencyMs ?? null,
    inputTokens: rec.inputTokens ?? null,
    outputTokens: rec.outputTokens ?? null,
    totalTokens: rec.totalTokens ?? null,
    cost: rec.cost ?? null,
    costStatus: rec.costStatus || "UNKNOWN",
    failureClass: rec.failureClass || null,
  };
  all.push(entry);
  try {
    await writeFile(FILE, JSON.stringify({ version: 1, calls: all.slice(-1000) }, null, 2));
  } catch {
    // non-fatal
  }
  return entry;
}

export async function listProviderCalls() {
  return load();
}

/** Aggregate provider telemetry for the Control Room. */
export async function providerTelemetry() {
  const calls = await load();
  if (!calls.length) return { observed: 0, collecting: true };

  const byProvider = {};
  let cloudEscalations = 0;
  for (const c of calls) {
    byProvider[c.provider] = byProvider[c.provider] || { n: 0, ok: 0, latencySum: 0, costSum: 0, tokens: 0 };
    const p = byProvider[c.provider];
    p.n++;
    if (c.success) p.ok++;
    if (c.latencyMs != null) p.latencySum += c.latencyMs;
    if (c.cost != null) p.costSum += c.cost;
    if (c.totalTokens != null) p.tokens += c.totalTokens;
    if (c.provider !== "local") cloudEscalations++;
  }

  const out = {};
  for (const [k, v] of Object.entries(byProvider)) {
    out[k] = {
      calls: v.n,
      successRate: +(v.ok / v.n).toFixed(3),
      avgLatencyMs: v.n ? Math.round(v.latencySum / v.n) : null,
      totalCost: +v.costSum.toFixed(4),
      totalTokens: v.tokens,
    };
  }
  return { observed: calls.length, collecting: false, byProvider: out, cloudEscalations };
}
