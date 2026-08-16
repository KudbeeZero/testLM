import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  PROVIDER, LOCAL_MODEL, LM_STUDIO_BASE_URL,
  GEMINI_API_KEY, GEMINI_MODEL,
  XAI_API_KEY, GROK_MODEL, MODEL_TTL_SECONDS, RATE_LIMIT_PER_MINUTE,
  DEEPSEEK_API_KEY, DEEPSEEK_MODEL, DEEPSEEK_BASE_URL,
  PRICING,
} from "./config.js";
import { overBudget, recordSpend } from "./budget.js";
import { recordProviderCall } from "./mesh/provider-telemetry.mjs";

/**
 * Simple token-bucket rate limiter. Enforces at most `perMinute` calls per
 * minute across all providers, so we never slam a cloud API and hit limits.
 */
class RateLimiter {
  constructor(perMinute) {
    this.perMinute = Math.max(1, perMinute);
    this.timestamps = [];
  }
  async acquire() {
    const now = Date.now();
    const windowMs = 60_000;
    // Drop timestamps older than the window.
    this.timestamps = this.timestamps.filter((t) => now - t < windowMs);
    if (this.timestamps.length >= this.perMinute) {
      const oldest = this.timestamps[0];
      const waitMs = windowMs - (now - oldest);
      if (waitMs > 0) {
        console.log(`[rate-limit] waiting ${Math.ceil(waitMs / 1000)}s to respect ${this.perMinute}/min limit`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    this.timestamps.push(Date.now());
  }
}

const limiter = new RateLimiter(RATE_LIMIT_PER_MINUTE);

/**
 * Each provider returns { content, usage } where usage is null when the
 * provider does not expose token counts (we never fabricate measurements).
 */

// --- Local (LM Studio, OpenAI-compatible HTTP API) -------------------------
async function localGenerate(prompt) {
  const base = LM_STUDIO_BASE_URL.replace(/^ws:\/\//, "http://").replace(/\/$/, "");
  const timeoutMs = Number(process.env.PHI4_TIMEOUT_MS || 60000);
  const maxRetries = Number(process.env.PHI4_MAX_RETRIES || 2);
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: LOCAL_MODEL,
          messages: [
            { role: "system", content: "You are a concise analysis engine that returns JSON." },
            { role: "user", content: prompt },
          ],
          max_tokens: 1500,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`LM Studio error ${resp.status}: ${text.slice(0, 300)}`);
      }
      const data = await resp.json();
      return {
        content: data.choices?.[0]?.message?.content ?? "",
        usage: data.usage || null,
      };
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        console.warn(`[local] attempt ${attempt + 1} failed (${e.message}) — retrying (bounded)`);
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr || new Error("LM Studio unavailable");
}

// --- Gemini (Google) ------------------------------------------------------
async function geminiGenerate(prompt) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set in .env");
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const result = await model.generateContent(prompt);
  const usage = result.response.usageMetadata || null;
  return {
    content: result.response.text(),
    usage: usage
      ? {
          prompt_tokens: usage.promptTokenCount ?? null,
          completion_tokens: usage.candidatesTokenCount ?? null,
          cached_input_tokens: usage.cachedContentTokenCount ?? null,
        }
      : null,
  };
}

// --- Grok (xAI, OpenAI-compatible) ----------------------------------------
async function grokGenerate(prompt) {
  if (!XAI_API_KEY) throw new Error("XAI_API_KEY is not set in .env");
  const resp = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${XAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROK_MODEL,
      messages: [
        { role: "system", content: "You are a concise analysis engine that returns JSON." },
        { role: "user", content: prompt },
      ],
      max_tokens: 1500,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Grok API error ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    usage: data.usage || null,
  };
}

// --- DeepSeek (OpenAI-compatible) -----------------------------------------
// NOTE: DeepSeek is intentionally EXCLUDED from application routing. This
// implementation is preserved for legacy/read-only reference only and is never
// selected by the router.
async function deepseekGenerate(prompt) {
  if (!DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not set in .env");
  const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: "You are a concise analysis engine that returns JSON." },
        { role: "user", content: prompt },
      ],
      max_tokens: 1500,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`DeepSeek API error ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    usage: data.usage || null,
  };
}

const generators = { local: localGenerate, gemini: geminiGenerate, grok: grokGenerate, deepseek: deepseekGenerate };

const MODEL_FOR = { local: LOCAL_MODEL, gemini: GEMINI_MODEL, grok: GROK_MODEL, deepseek: DEEPSEEK_MODEL };

/**
 * Estimate USD cost from usage. Local = 0. Cloud = null unless pricing is
 * configured (we never fabricate cost). Distinguish actual vs unknown.
 */
function estimateCost(provider, usage) {
  if (provider === "local") return 0;
  const pricing = PRICING[provider];
  if (!pricing) return null;
  const inTok = usage?.prompt_tokens ?? usage?.input_tokens ?? null;
  const outTok = usage?.completion_tokens ?? usage?.output_tokens ?? null;
  if (inTok == null || outTok == null) return null;
  if (pricing.inPer1k <= 0 && pricing.outPer1k <= 0) return null;
  return (inTok / 1000) * pricing.inPer1k + (outTok / 1000) * pricing.outPer1k;
}

/**
 * Shared provider invocation. Returns a full structured metadata object.
 * Never fabricates token counts or costs: missing fields are null/UNKNOWN.
 *
 * costStatus: local = ACTUAL ($0); cloud with configured pricing + usage =
 * ESTIMATED; otherwise UNKNOWN.
 */
async function callProvider(prompt, opts = {}) {
  const provider = opts.provider || PROVIDER;
  const taskType = opts.taskType || "unknown";
  const reason = opts.reason || null;

  const fn = generators[provider];
  if (!fn) throw new Error(`Unknown provider: ${provider}`);

  if (provider !== "local") {
    try {
      if (await overBudget()) {
        throw new Error(`Monthly budget reached for provider "${provider}" — skipping cloud call.`);
      }
    } catch (e) {
      if (e.message.includes("budget")) throw e;
      // Redis unavailable — proceed.
    }
  }

  await limiter.acquire();
  const start = Date.now();
  try {
    const { content, usage } = await fn(prompt);
    const latency = Date.now() - start;
    const usd = estimateCost(provider, usage);
    const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? null;
    const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? null;
    const totalTokens = (inputTokens != null && outputTokens != null) ? inputTokens + outputTokens : null;
    const costStatus = provider === "local" ? "ACTUAL" : (usd == null ? "UNKNOWN" : "ESTIMATED");
    const meta = {
      content,
      provider,
      model: MODEL_FOR[provider],
      usage: {
        inputTokens,
        outputTokens,
        totalTokens,
        cachedInputTokens: usage?.cached_input_tokens ?? null,
      },
      latencyMs: latency,
      requestId: null,
      estimatedCost: usd,
      costStatus,
      success: true,
    };
    await recordSpend({
      provider,
      model: MODEL_FOR[provider],
      usd,
      inputTokens,
      outputTokens,
      cachedInputTokens: usage?.cached_input_tokens ?? null,
      cacheHit: usage?.cached_input_tokens ? true : null,
      latency,
      taskType,
      success: true,
      reason,
    });
    await recordProviderCall({
      taskType, provider, model: MODEL_FOR[provider], success: true,
      latencyMs: latency, inputTokens, outputTokens, totalTokens,
      cost: usd, costStatus,
    });
    return meta;
  } catch (e) {
    const latency = Date.now() - start;
    await recordSpend({
      provider,
      model: MODEL_FOR[provider],
      usd: 0,
      latency,
      taskType,
      success: false,
      reason: e.message,
    });
    await recordProviderCall({
      taskType, provider, model: MODEL_FOR[provider], success: false,
      latencyMs: latency, cost: 0, costStatus: "UNKNOWN", failureClass: "MODEL_FAILURE",
    });
    throw e;
  }
}

/**
 * Unified provider interface. Returns the content string (legacy contract).
 * Wires recordSpend() + provider telemetry for every call.
 */
export async function generate(prompt, opts = {}) {
  const r = await callProvider(prompt, opts);
  return r.content;
}

/**
 * Detailed provider interface — returns full structured metadata.
 * Compatible with generate() for content; callers that need usage/cost/latency
 * use this. Throws on failure (same as generate).
 */
export async function generateDetailed(prompt, opts = {}) {
  return callProvider(prompt, opts);
}

export { PROVIDER, LOCAL_MODEL, GEMINI_MODEL, GROK_MODEL, MODEL_TTL_SECONDS };
