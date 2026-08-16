/**
 * escalation.mjs — escalation evidence store (RDTHINK).
 *
 * Records every escalation decision so we can later answer: "was escalation
 * actually worth it?" Persisted locally (no new database). Never fabricated.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "../config.js";

const FILE = path.join(MEMORY_DIR, "local-escalations.json");

async function load() {
  try {
    const d = JSON.parse(await readFile(FILE, "utf8"));
    return d.escalations || [];
  } catch {
    return [];
  }
}

/** Persist an escalation record. Non-fatal on storage error. */
export async function recordEscalation(rec) {
  if (!rec || !rec.taskId) return null;
  const all = await load();
  all.push(rec);
  try {
    await writeFile(FILE, JSON.stringify({ version: 1, escalations: all.slice(-500) }, null, 2));
  } catch {
    // non-fatal
  }
  return rec;
}

export async function listEscalations() {
  return load();
}
