/**
 * learning.mjs — evidence-backed local learning store.
 *
 * A learning entry is only accepted if it carries observation + evidence.
 * This keeps "learning" distinct from raw memory: learning requires evidence,
 * evaluation, and validation.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_DIR } from "../config.js";

const FILE = path.join(AGENT_DIR, "memory", "local-learning.json");

async function load() {
  try {
    const d = JSON.parse(await readFile(FILE, "utf8"));
    return d.learnings || [];
  } catch {
    return [];
  }
}

/**
 * Record a validated learning. Requires observation + evidence.
 */
export async function recordLearning(entry) {
  if (!entry || !entry.observation || !entry.evidence) {
    return { ok: false, error: "learning requires observation + evidence" };
  }
  const all = await load();
  const rec = {
    ...entry,
    id: `learn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date().toISOString(),
  };
  all.push(rec);
  try {
    await writeFile(FILE, JSON.stringify({ version: 1, learnings: all }, null, 2));
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  return { ok: true, id: rec.id };
}

export async function listLearnings() {
  return load();
}
