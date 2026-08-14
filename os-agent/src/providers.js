import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  PROVIDER, LOCAL_MODEL, LM_STUDIO_BASE_URL,
  GEMINI_API_KEY, GEMINI_MODEL,
  XAI_API_KEY, GROK_MODEL, MODEL_TTL_SECONDS, RATE_LIMIT_PER_MINUTE,
  DEEPSEEK_API_KEY, DEEPSEEK_MODEL, DEEPSEEK_BASE_URL,
} from "./config.js";
import { overBudget } from "./budget.js";

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
 * Unified provider interface: each provider exposes `generate(prompt) -> string`.
 */

// --- Local (LM Studio, OpenAI-compatible HTTP API) -------------------------
// Uses the HTTP server (http://localhost:1234/v1). The @lmstudio/sdk requires
// LM Studio's WebSocket SDK server, which may not be enabled; the HTTP API is
// reliable and already verified.
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
  return data.choices?.[0]?.message?.content ?? "";
}

// --- Gemini (Google) ------------------------------------------------------
async function geminiGenerate(prompt) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set in .env");
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const result = await model.generateContent(prompt);
  return result.response.text();
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
  return data.choices?.[0]?.message?.content ?? "";
}

// --- DeepSeek (OpenAI-compatible) -----------------------------------------
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
  return data.choices?.[0]?.message?.content ?? "";
}

const generators = { local: localGenerate, gemini: geminiGenerate, grok: grokGenerate, deepseek: deepseekGenerate };

export async function generate(prompt) {
  const fn = generators[PROVIDER];
  if (!fn) throw new Error(`Unknown provider: ${PROVIDER}`);
  if (PROVIDER !== "local") {
    try {
      if (await overBudget()) {
        throw new Error(`Monthly budget reached for provider "${PROVIDER}" — skipping cloud call.`);
      }
    } catch (e) {
      if (e.message.includes("budget")) throw e;
      // Redis unavailable — proceed.
    }
  }
  await limiter.acquire();
  return fn(prompt);
}

export { PROVIDER, LOCAL_MODEL, GEMINI_MODEL, GROK_MODEL, MODEL_TTL_SECONDS };
