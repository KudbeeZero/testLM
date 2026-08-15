#!/usr/bin/env node
/**
 * os-agent/register-knowledge.mjs — bridge os-agent learnings into the
 * canonical knowledge lifecycle index (Fuel Gauge monorepo).
 *
 * Deterministic, 0 model calls, 0 Redis calls. Registers each os-agent
 * learning as a canonical `learning` object via the lifecycle CLI. Carries
 * provenance IDs (learningId/traceId/evidenceId/thinkTokenId) in `references`
 * when present. Confidence is only set when the source record provides it
 * (never fabricated). Skips already-registered IDs.
 *
 * Usage: node register-knowledge.mjs [--dry-run]
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, ".."); // workspace root (testLM/)
const MEMORY_FILE = join(ROOT, "agent", "memory", "learnings.json");
const FG = join(ROOT, "Kudbee-fuel-gage");
const dryRun = process.argv.includes("--dry-run");

function readLearnings() {
  if (!existsSync(MEMORY_FILE)) { console.error("learnings.json not found:", MEMORY_FILE); process.exit(1); }
  const raw = readFileSync(MEMORY_FILE, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw).learnings || [];
}

// Stable ID: prefer the learning's own learningId, else derive from topic+insight.
function learningId(l) {
  if (l.learningId) return l.learningId;
  const s = `${l.topic}|${l.insight}`;
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `LRN-${h.toString(36).toUpperCase()}`;
}

// Provenance IDs are carried in the evidence text (not `references`, which the
// audit validates against canonical index objects — os-agent IDs are not
// canonical objects and would trigger broken-reference findings).
function provenance(l) {
  return [l.learningId, l.traceId, l.evidenceId, l.outcomeId, l.thinkTokenId]
    .filter(Boolean)
    .map((id) => id.startsWith("lrn:") ? id : `${id}`)
    .join(",");
}

const learnings = readLearnings();
console.log(`[register-knowledge] ${learnings.length} os-agent learnings`);

// Already-registered IDs in the canonical index.
let existing = new Set();
try {
  const idx = JSON.parse(readFileSync(join(FG, ".kilo", "knowledge-index.json"), "utf8"));
  existing = new Set((idx.objects || []).map((o) => o.id));
} catch {}

let registered = 0;
for (const l of learnings) {
  const id = learningId(l);
  if (existing.has(id)) continue;
  const prov = provenance(l);
  const evidence = `${l.insight}${l.recommendation ? " — " + l.recommendation : ""}${prov ? " [provenance: " + prov + "]" : ""}`;
  const args = ["scripts/knowledge-lifecycle.mjs", "register", "learning", id,
    "--owner", "os-agent", "--evidence", evidence];
  // Confidence only when the source provides it — never fabricated.
  if (l.confidence != null) args.push("--confidence", String(l.confidence));
  if (dryRun) { console.log(`  [dry] would register ${id} (${l.topic})`); continue; }
  try {
    execFileSync("node", args, { cwd: FG, encoding: "utf8" });
    registered++;
    console.log(`  registered ${id} (${l.topic})`);
  } catch (e) {
    console.error(`  failed ${id}: ${e.message}`);
  }
}
console.log(`[register-knowledge] done: ${registered} registered (${dryRun ? "dry-run" : "live"})`);
