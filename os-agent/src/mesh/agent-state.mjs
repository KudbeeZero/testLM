/**
 * agent-state.mjs — single authoritative local-agent state.
 *
 * One state store (local-agent-state.json) with explicit allowed transitions.
 * Persisted so the Control Room and overnight runner share the same truth and
 * crash recovery can detect an interrupted session.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_DIR } from "../config.js";

const FILE = path.join(AGENT_DIR, "memory", "local-agent-state.json");

export const AGENT_STATES = [
  "idle", "planning", "executing", "observing", "evaluating",
  "verifying", "learning", "complete", "failed", "stopped",
];
export const OVERNIGHT_MODES = ["OFF", "ARMED", "RUNNING", "STOPPED"];

function defaultState() {
  return {
    agentId: "local-engineer",
    model: "Phi-4 Mini",
    provider: "LM Studio",
    state: "idle",
    currentTaskId: null,
    currentTask: null,
    iteration: 0,
    maxIterations: 3,
    currentTool: null,
    lastResult: null,
    lastEvaluation: null,
    lastLearning: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    overnightMode: "OFF",
    error: null,
  };
}

let cached = null;

export async function getState() {
  if (cached) return cached;
  try {
    cached = JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    cached = defaultState();
  }
  return cached;
}

export async function setState(patch) {
  const s = { ...(await getState()), ...patch, updatedAt: new Date().toISOString() };
  cached = s;
  try {
    await writeFile(FILE, JSON.stringify(s, null, 2));
  } catch {
    // non-fatal: keep in-memory truth
  }
  return s;
}

export async function transition(newState, patch = {}) {
  if (!AGENT_STATES.includes(newState)) throw new Error("invalid agent state: " + newState);
  return setState({ ...patch, state: newState });
}

export async function setOvernightMode(mode) {
  if (!OVERNIGHT_MODES.includes(mode)) throw new Error("invalid overnight mode: " + mode);
  return setState({ overnightMode: mode });
}
