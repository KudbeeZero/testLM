/**
 * local-worker.mjs — Phi-4 Mini local reasoning worker.
 *
 * Wraps the existing local provider (LM Studio) with bounded retries and
 * structured JSON parsing. The model PROPOSES; MESH authorizes; the executor
 * executes. This worker never executes tools directly.
 */
import { generateDetailed } from "../providers.js";

/** Map generateDetailed() metadata onto the worker contract. */
function toWorker(meta) {
  return {
    ok: true,
    content: meta.content,
    provider: meta.provider,
    model: meta.model,
    usage: meta.usage,
    latencyMs: meta.latencyMs,
    cost: meta.estimatedCost,
    costStatus: meta.costStatus,
    requestId: meta.requestId,
  };
}

/**
 * Call the local Phi-4 worker with bounded retries.
 * @returns {{ok:boolean, content?:string, provider?:string, model?:string, usage?:object, cost?:number, costStatus?:string, error?:string}}
 */
export async function localWorker(prompt, { maxRetries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const meta = await generateDetailed(prompt, { provider: "local" });
      return toWorker(meta);
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr) };
}

/**
 * Gemini escalation worker — PROPOSES only; MESH authorizes. Bounded retries.
 * Used exclusively as an escalation model; never the default.
 */
export async function geminiWorker(prompt, { maxRetries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const meta = await generateDetailed(prompt, { provider: "gemini", taskType: "escalation" });
      return toWorker(meta);
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr) };
}

/**
 * Parse a model's JSON response, tolerating code fences. Returns null on
 * malformed output (never throws).
 */
export function parseModelJson(content) {
  if (!content) return null;
  const stripped = String(content).replace(/```json/g, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}
