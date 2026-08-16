#!/usr/bin/env node
/**
 * cost-cache.mjs — server-side AWS Cost Explorer cache.
 *
 * Problem: the Control Room auto-refreshed /api/ops every 60s, and each ops
 * check ran `aws ce get-cost-and-usage` — one paid Cost Explorer request per
 * minute while the dashboard was open (~60/hour). This module decouples cost
 * from the frequent health refresh: Cost Explorer is called on a controlled
 * schedule (24h TTL) or an explicit manual refresh (15 min cooldown), and the
 * result is cached to a small JSON snapshot. The dashboard reads the cache.
 *
 * No secrets are stored — only cost figures and timestamps.
 */
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, "dashboard", "cost-cache.json");

// AWS cost data does not need second-level freshness.
export const COST_TTL_MS = 24 * 3600 * 1000; // 24h cache TTL
export const COST_COOLDOWN_MS = 15 * 60 * 1000; // 15 min manual refresh cooldown

let inFlight = null; // single in-flight refresh (dedupe concurrent requests)

/** One controlled Cost Explorer query (MONTHLY granularity, total only). */
function runAwsCe() {
  const month = new Date().toISOString().slice(0, 7) + "-01";
  const end = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const out = execFileSync("aws", [
    "ce", "get-cost-and-usage",
    "--time-period", `Start=${month},End=${end}`,
    "--granularity", "MONTHLY",
    "--metrics", "UnblendedCost",
  ], { encoding: "utf8", timeout: 60000 });
  const d = JSON.parse(out);
  const amt = d.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount;
  return { total: amt != null ? parseFloat(amt).toFixed(2) : null, period: `${month}/${end}` };
}

async function readCache() {
  try { return JSON.parse(await readFile(CACHE_FILE, "utf8")); } catch { return null; }
}
async function writeCache(snap) {
  try { await writeFile(CACHE_FILE, JSON.stringify(snap, null, 2)); } catch { /* non-fatal */ }
}

/** Fetch fresh cost; on failure preserve last-known-good data (status: stale). */
async function fetchFresh() {
  try {
    const r = runAwsCe();
    const snap = {
      period: r.period,
      total: r.total,
      fetchedAt: new Date().toISOString(),
      lastSuccess: new Date().toISOString(),
      status: "fresh",
      error: null,
    };
    await writeCache(snap);
    return snap;
  } catch (e) {
    const prev = await readCache();
    const snap = {
      ...(prev || { total: null, period: null }),
      fetchedAt: new Date().toISOString(),
      status: "stale",
      error: String((e && e.message) || e).slice(0, 200),
    };
    await writeCache(snap);
    return snap;
  }
}

/**
 * Return a cost snapshot without hammering Cost Explorer.
 * - force=true  → manual refresh, subject to COST_COOLDOWN_MS (returns throttled).
 * - otherwise   → serve cache if fresh (TTL), else refresh once (deduped).
 */
export async function getCostSnapshot({ force = false } = {}) {
  const now = Date.now();
  const cached = await readCache();

  if (force) {
    const lastFetch = cached && cached.fetchedAt ? new Date(cached.fetchedAt).getTime() : 0;
    const elapsed = now - lastFetch;
    if (elapsed < COST_COOLDOWN_MS) {
      return { ...(cached || { total: null, period: null, status: "empty" }), throttled: true, retryAfterMs: COST_COOLDOWN_MS - elapsed };
    }
  }

  if (cached && cached.total != null && cached.fetchedAt && now - new Date(cached.fetchedAt).getTime() < COST_TTL_MS) {
    return { ...cached, throttled: false };
  }

  // Stale or missing → refresh (single in-flight lock so concurrent callers share one AWS call).
  if (inFlight) return inFlight;
  inFlight = fetchFresh().finally(() => { inFlight = null; });
  return inFlight;
}

/** Human-friendly one-line cost used by kudbee-status.mjs (cached, no AWS call). */
export async function getCostText() {
  const s = await getCostSnapshot();
  return `month-to-date $${s.total != null ? s.total : "?"}`;
}
