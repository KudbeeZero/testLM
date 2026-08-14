import { Redis } from "@upstash/redis";
import { UPSTASH_REDIS_URL, UPSTASH_REDIS_TOKEN, MONTHLY_BUDGET_USD, PROVIDER, TELEMETRY_MAX_WRITES, TELEMETRY_FLUSH_EVERY } from "./config.js";

const redis = (UPSTASH_REDIS_URL && UPSTASH_REDIS_TOKEN)
  ? new Redis({ url: UPSTASH_REDIS_URL, token: UPSTASH_REDIS_TOKEN })
  : null;

const monthKey = () => {
  const d = new Date();
  return `budget:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// Bounded telemetry list per month (last 500 entries).
const TELEMETRY_MAX = 500;
const telemetryKey = () => {
  const d = new Date();
  return `telemetry:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// Redis resource guard: telemetry writes are batched and capped so that
// observability cannot consume the Upstash ~500K monthly request quota.
let telemetryBuffer = [];
let telemetryWrites = 0;
let telemetrySuppressed = false;

async function flushTelemetry() {
  if (!redis || telemetryBuffer.length === 0) return;
  const batch = telemetryBuffer;
  telemetryBuffer = [];
  for (const entry of batch) {
    await redis.lpush(telemetryKey(), JSON.stringify(entry));
  }
  await redis.ltrim(telemetryKey(), 0, TELEMETRY_MAX - 1);
}

/**
 * Record spend + telemetry for a provider call.
 *
 * Accepts either the legacy numeric form `recordSpend(usd)` or an object:
 *   { provider, model, usd, inputTokens, outputTokens, latency, taskType, success, reason }
 *
 * Spend counter is stored per-provider in the `budget:{YYYY-MM}` hash
 * (milli-USD). Detailed per-call telemetry is appended to a bounded list.
 * For local Phi-4, usd is 0 (no external API spend), but latency/tokens/
 * taskType/success are still recorded. Unknown values use null (not fabricated).
 */
export async function recordSpend(record) {
  if (!redis) return;
  // Legacy numeric form.
  if (typeof record === "number") record = { usd: record, provider: PROVIDER };

  const {
    usd = 0,
    provider = PROVIDER,
    model = null,
    inputTokens = null,
    outputTokens = null,
    latency = null,
    taskType = null,
    success = true,
    reason = null,
  } = record || {};

  // Spend counter (per provider, milli-USD) — always recorded (critical).
  await redis.hincrby(monthKey(), provider, Math.round(usd * 1000));

  // Detailed telemetry record — batched and capped to protect the Redis quota.
  const entry = {
    ts: Date.now(),
    provider,
    model,
    inputTokens,
    outputTokens,
    latency,
    taskType,
    usd,
    success,
    reason,
  };
  telemetryWrites++;
  if (telemetryWrites > TELEMETRY_MAX_WRITES) {
    if (!telemetrySuppressed) {
      telemetrySuppressed = true;
      console.warn(`[budget] telemetry suppressed: write cap ${TELEMETRY_MAX_WRITES} reached (spend counter still recorded)`);
    }
    return;
  }
  telemetryBuffer.push(entry);
  if (telemetryBuffer.length >= TELEMETRY_FLUSH_EVERY) {
    await flushTelemetry();
  }
}

/** Get this month's spend (USD) for a provider (default: active provider). */
export async function monthSpend(provider = PROVIDER) {
  if (!redis) return 0;
  const raw = await redis.hget(monthKey(), provider);
  return (Number(raw) || 0) / 1000;
}

/** True if the active provider is at/over the monthly budget. */
export async function overBudget() {
  const spent = await monthSpend();
  return spent >= MONTHLY_BUDGET_USD;
}
