import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  PROVIDER, LOCAL_MODEL, LM_STUDIO_BASE_URL,
  GEMINI_API_KEY, GEMINI_MODEL,
  XAI_API_KEY, GROK_MODEL, MODEL_TTL_SECONDS, RATE_LIMIT_PER_MINUTE,
  DEEPSEEK_API_KEY, DEEPSEEK_MODEL, DEEPSEEK_BASE_URL,
  PRICING,
} from "./config.js";
import { overBudget, recordSpend } from "./budget.js";

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
      ? { prompt_tokens: usage.promptTokenCount ?? null, completion_tokens: usage.candidatesTokenCount ?? null }
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
 * Unified provider interface. Returns the content string (legacy contract).
 * Wires recordSpend() telemetry for every call (including local $0 spend).
 *
 * `opts.provider` selects the provider (default: global PROVIDER). The router
 * uses this to choose the execution path; DeepSeek is never selected by it.
 */
export async function generate(prompt, opts = {}) {
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
    await recordSpend({
      provider,
      model: MODEL_FOR[provider],
      usd,
      inputTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? null,
      outputTokens: usage?.completion_tokens ?? usage?.output_tokens ?? null,
      latency,
      taskType,
      success: true,
      reason,
    });
    return content;
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
    throw e;
  }
}

export { PROVIDER, LOCAL_MODEL, GEMINI_MODEL, GROK_MODEL, MODEL_TTL_SECONDS };
