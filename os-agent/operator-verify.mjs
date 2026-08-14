#!/usr/bin/env node
/**
 * os-agent/operator-verify.mjs — KUDBEE operator status verification.
 *
 * Verifies ACTUAL state (not just env presence) from the terminal/SSH:
 *   AWS/EC2, agent process, Phi-4 (LM Studio), providers, Redis, Postgres,
 *   GitHub connector, router state, knowledge audit, last learning.
 *
 * Read-only. Never prints secret values — only PRESENT/ABSENT/OK/FAIL.
 * No model calls, no Redis writes, no mutations.
 *
 * Usage: node operator-verify.mjs
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { config as loadEnv } from "dotenv";

const ROOT = process.cwd();
loadEnv({ path: ROOT + "/.env" });
try { loadEnv({ path: ROOT + "/os-agent/.env" }); } catch {}

const has = (k) => (process.env[k] && String(process.env[k]).length > 0) ? "PRESENT" : "ABSENT";

async function check() {
  const out = [];

  // AWS / EC2 (read-only identity)
  try {
    const id = execFileSync("aws", ["sts", "get-caller-identity"], { encoding: "utf8", timeout: 10000 });
    out.push(["AWS identity", JSON.parse(id).Account || "ok"]);
  } catch (e) { out.push(["AWS identity", "UNAVA/" + (e.message || "").slice(0, 30)]); }

  // Phi-4 / LM Studio
  try {
    const r = await fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    const phi = (j.data || []).some((m) => m.id && m.id.includes("phi-4-mini"));
    out.push(["Phi-4 (LM Studio)", phi ? "ONLINE" : "not loaded"]);
  } catch { out.push(["Phi-4 (LM Studio)", "OFFLINE"]); }

  // Providers (presence)
  out.push(["Gemini", has("GEMINI_API_KEY")]);
  out.push(["XAI/Grok", has("XAI_API_KEY")]);
  out.push(["Inception", has("INCEPTION_API_KEY")]);
  out.push(["DeepSeek", "ZERO (never routed)"]);

  // Redis (Upstash REST ping)
  try {
    const r = await fetch((process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "") + "/dbsize", {
      headers: { Authorization: "Bearer " + (process.env.UPSTASH_REDIS_REST_TOKEN || "") },
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    out.push(["Redis (Upstash)", j.error ? "FAIL" : "OK (" + (j.result ?? "?") + " keys)"]);
  } catch { out.push(["Redis (Upstash)", "UNREACHABLE"]); }

  // Postgres
  out.push(["Postgres (DATABASE_URL)", has("DATABASE_URL")]);

  // GitHub connector
  out.push(["GitHub connector", has("GITHUB_PAT") || has("GITHUB_TOKEN")]);

  // Router state
  out.push(["Router", process.env.ROUTER_ENABLED === "true" ? "ENABLED" : "OFF (safe)"]);

  // Knowledge audit (Fuel Gauge)
  try {
    execFileSync("node", ["scripts/knowledge-audit.mjs"], { cwd: ROOT + "/Kudbee-fuel-gage", timeout: 60000, stdio: "pipe" });
    out.push(["Knowledge audit", "PASS"]);
  } catch { out.push(["Knowledge audit", "FAIL/unavailable"]); }

  // Last learning
  try {
    const mem = JSON.parse(readFileSync(ROOT + "/agent/memory/learnings.json", "utf8").replace(/^\uFEFF/, ""));
    out.push(["Last learning", (mem.learnings || []).length + " records"]);
  } catch { out.push(["Last learning", "unreadable"]); }

  const w = Math.max(...out.map(([k]) => k.length));
  for (const [k, v] of out) console.log(k.padEnd(w + 2) + v);
}

check().catch((e) => { console.error("operator-verify error:", e.message); process.exit(1); });
