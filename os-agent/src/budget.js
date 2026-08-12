import { Redis } from "@upstash/redis";
import { UPSTASH_REDIS_URL, UPSTASH_REDIS_TOKEN, MONTHLY_BUDGET_USD, PROVIDER } from "./config.js";

const redis = (UPSTASH_REDIS_URL && UPSTASH_REDIS_TOKEN)
  ? new Redis({ url: UPSTASH_REDIS_URL, token: UPSTASH_REDIS_TOKEN })
  : null;

const monthKey = () => {
  const d = new Date();
  return `budget:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/** Record spend (USD) for the current provider for this month. */
export async function recordSpend(usd) {
  if (!redis) return;
  await redis.hincrby(monthKey(), PROVIDER, Math.round(usd * 1000)); // store in milli-USD
}

/** Get this month's spend (USD) for the active provider. */
export async function monthSpend() {
  if (!redis) return 0;
  const raw = await redis.hget(monthKey(), PROVIDER);
  return (Number(raw) || 0) / 1000;
}

/** True if the active provider is at/over the monthly budget. */
export async function overBudget() {
  const spent = await monthSpend();
  return spent >= MONTHLY_BUDGET_USD;
}
