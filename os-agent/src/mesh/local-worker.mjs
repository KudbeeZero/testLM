/**
 * local-worker.mjs — Phi-4 Mini local reasoning worker.
 *
 * Wraps the existing local provider (LM Studio) with bounded retries and
 * structured JSON parsing. The model PROPOSES; MESH authorizes; the executor
 * executes. This worker never executes tools directly.
 */
import { generate } from "../providers.js";

/**
 * Call the local Phi-4 worker with bounded retries.
 * @returns {{ok:boolean, content?:string, error?:string}}
 */
export async function localWorker(prompt, { maxRetries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const content = await generate(prompt, { provider: "local" });
      return { ok: true, content };
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
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
