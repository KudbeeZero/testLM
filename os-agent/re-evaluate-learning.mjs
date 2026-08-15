#!/usr/bin/env node
/**
 * os-agent/re-evaluate-learning.mjs — P1 closed-loop feedback.
 *
 * Re-evaluates os-agent learnings against outcome evidence and updates their
 * canonical lifecycle status (CONFIRM / STALE / SUPERSEDED). Deterministic,
 * 0 model calls. Bounded — reads an optional evidence file; without it, runs
 * in dry-run and reports what would change.
 *
 * Evidence file (optional): JSON array [{topic, insight, success, total}]
 *   node re-evaluate-learning.mjs [--apply] [--evidence path.json]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { reEvaluate } from "./src/learning.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MEMORY_FILE = join(ROOT, "agent", "memory", "learnings.json");
const apply = process.argv.includes("--apply");
const evIdx = process.argv.indexOf("--evidence");
const evPath = evIdx !== -1 ? process.argv[evIdx + 1] : null;

const mem = JSON.parse(readFileSync(MEMORY_FILE, "utf8").replace(/^\uFEFF/, ""));
const learnings = mem.learnings || [];

// Load evidence (by topic) if provided.
const evidence = {};
if (evPath && existsSync(evPath)) {
  for (const e of JSON.parse(readFileSync(evPath, "utf8"))) {
    evidence[String(e.topic).toLowerCase()] = { success: e.success ?? 0, total: e.total ?? 0 };
  }
}

let changed = 0;
for (const l of learnings) {
  const ev = evidence[String(l.topic).toLowerCase()];
  if (!ev) continue; // no evidence — no change
  const before = l.status || "DRAFT";
  reEvaluate(l, { sampleCount: ev.total, successCount: ev.success, failureCount: ev.total - ev.success });
  if ((l.status || "DRAFT") !== before) {
    changed++;
    console.log(`  ${l.topic}: ${before} → ${l.status} (conf ${l.confidence?.toFixed(2)})`);
  }
}

if (apply) {
  writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2), "utf8");
  console.log(`[re-evaluate] applied: ${changed} status change(s)`);
} else {
  console.log(`[re-evaluate] dry-run: ${changed} would change (use --apply to persist)`);
}
