#!/usr/bin/env node
/**
 * os-agent/generate-tests.mjs — PR-6 learning → test generation.
 *
 * Reads os-agent learnings and produces bounded, deduplicated test specs for
 * VALIDATED/ACTIVE learnings only. Test specs are artifacts — they never
 * modify production code. Deterministic, 0 model calls, 0 Redis calls.
 *
 * Usage:
 *   node generate-tests.mjs [--apply] [--max N] [--max-total M]
 *     --apply      persist new test specs to agent/memory/test-specs.json
 *     --max N      max test specs per learning (default 1)
 *     --max-total M  global cap on new specs (default 200)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateTestSpec } from "./src/learning.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MEMORY_FILE = join(ROOT, "agent", "memory", "learnings.json");
const SPECS_FILE = join(ROOT, "agent", "memory", "test-specs.json");
const apply = process.argv.includes("--apply");
const maxIdx = process.argv.indexOf("--max");
const maxPerLearning = maxIdx !== -1 ? parseInt(process.argv[maxIdx + 1], 10) : 1;
const maxTotalIdx = process.argv.indexOf("--max-total");
const maxTotal = maxTotalIdx !== -1 ? parseInt(process.argv[maxTotalIdx + 1], 10) : 200;

const mem = JSON.parse(readFileSync(MEMORY_FILE, "utf8").replace(/^\uFEFF/, ""));
const learnings = mem.learnings || [];

// Already-generated specs — dedup by learningId so we never emit a duplicate.
let existing = [];
if (existsSync(SPECS_FILE)) {
  try {
    existing = JSON.parse(readFileSync(SPECS_FILE, "utf8").replace(/^\uFEFF/, "")).specs || [];
  } catch {}
}
const seenLearning = new Set(existing.map((s) => s.learningId));

const newSpecs = [];
for (const l of learnings) {
  const status = l.status || "DRAFT";
  if (status !== "VERIFIED" && status !== "ACTIVE") continue; // only validated learnings
  if (seenLearning.has(l.learningId)) continue; // dedup — already generated
  const spec = generateTestSpec({ ...l, status });
  if (!spec) continue;
  newSpecs.push(spec);
  seenLearning.add(l.learningId);
  if (newSpecs.length >= maxTotal) break; // global bound
}

console.log(`[generate-tests] ${learnings.length} learnings; ${newSpecs.length} new test spec(s) (max ${maxPerLearning}/learning, cap ${maxTotal})`);
for (const s of newSpecs) {
  console.log(`  ${s.testId} <- ${s.learningId} (${s.taskType || "?"})`);
}

if (apply) {
  const all = { version: 1, specs: [...existing, ...newSpecs] };
  writeFileSync(SPECS_FILE, JSON.stringify(all, null, 2), "utf8");
  console.log(`[generate-tests] applied: ${newSpecs.length} spec(s) written to ${SPECS_FILE}`);
} else {
  console.log(`[generate-tests] dry-run: use --apply to persist`);
}
