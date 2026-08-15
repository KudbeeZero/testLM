#!/usr/bin/env node
/**
 * os-agent/record-regression.mjs — PR-7 regression knowledge.
 *
 * Records a verified failure as a regression record so the system never has
 * to relearn the same failure. Deterministic, 0 model calls, 0 Redis calls.
 * History is preserved (append-only) — never deleted.
 *
 * Usage:
 *   node record-regression.mjs --failure "..." [--learningId lrn-...]
 *        [--traceId ...] [--failureId ...] [--agentId os-agent]
 *        [--provider ...] [--model ...] [--apply]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { recordRegression } from "./src/learning.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REGRESSIONS_FILE = join(ROOT, "agent", "memory", "regressions.json");
const apply = process.argv.includes("--apply");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}

const failure = arg("--failure");
if (!failure) {
  console.error("Missing --failure (the verified failure description).");
  process.exit(1);
}

const reg = recordRegression({
  learningId: arg("--learningId"),
  traceId: arg("--traceId"),
  failureId: arg("--failureId"),
  agentId: arg("--agentId") || "os-agent",
  provider: arg("--provider"),
  model: arg("--model"),
  failure,
});

// Append-only regression log (history preserved).
let all = { version: 1, regressions: [] };
if (existsSync(REGRESSIONS_FILE)) {
  try {
    all = JSON.parse(readFileSync(REGRESSIONS_FILE, "utf8").replace(/^\uFEFF/, ""));
  } catch {}
}
all.regressions = all.regressions || [];
all.regressions.push(reg);

console.log(`[record-regression] ${reg.regressionId} (${reg.learningId || "no learning"})`);
console.log(`  failure: ${reg.failure}`);

if (apply) {
  writeFileSync(REGRESSIONS_FILE, JSON.stringify(all, null, 2), "utf8");
  console.log(`[record-regression] applied: ${all.regressions.length} total (${REGRESSIONS_FILE})`);
} else {
  console.log(`[record-regression] dry-run: use --apply to persist`);
}
