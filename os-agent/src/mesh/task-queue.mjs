/**
 * task-queue.mjs — local bounded task queue.
 *
 * A simple isolated JSON-backed queue for local overnight tasks. This is NOT
 * the production HERMES Redis queue (kudbee:governance:tasks) and does not
 * touch it. Tasks describe a GOAL; the agent decides which approved tools may
 * help; MESH decides whether those tools are allowed.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_DIR } from "../config.js";

const FILE = path.join(AGENT_DIR, "memory", "local-task-queue.json");

async function load() {
  try {
    const d = JSON.parse(await readFile(FILE, "utf8"));
    return d.tasks || [];
  } catch {
    return [];
  }
}

async function save(tasks) {
  await writeFile(FILE, JSON.stringify({ version: 1, tasks }, null, 2));
}

/** Enqueue a task. Task carries a goal (never a raw command). */
export async function enqueue(task) {
  const t = {
    id: task.id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    description: String(task.description || ""),
    skill: task.skill || null,
    priority: task.priority || 0,
    maxIterations: task.maxIterations || 3,
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  const all = await load();
  all.push(t);
  await save(all);
  return t;
}

export async function listTasks() {
  return load();
}

export async function updateTask(id, patch) {
  const all = await load();
  const i = all.findIndex((t) => t.id === id);
  if (i < 0) return null;
  all[i] = { ...all[i], ...patch };
  await save(all);
  return all[i];
}

/** Claim the next queued task (marks it running). Returns null if none. */
export async function nextQueued() {
  const all = await load();
  const i = all.findIndex((t) => t.status === "queued");
  if (i < 0) return null;
  all[i].status = "running";
  await save(all);
  return all[i];
}

export async function clearQueue() {
  await save([]);
}
