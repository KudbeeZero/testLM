/**
 * benchmark.mjs — bounded Phi-4 vs Gemini benchmark mode.
 *
 * Runs the SAME task set through both models under the identical MESH-gated
 * local loop, records deterministic scores per task, captures real provider
 * usage when available (cost is marked UNKNOWN otherwise — never fabricated),
 * and persists a comparison for the Control Room.
 *
 * Gemini is a benchmark/escalation CANDIDATE only. It is NOT the default
 * worker and does not change production routing. MESH remains the authority.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MEMORY_DIR } from "../config.js";
import { generate } from "../providers.js";
import { localWorker } from "./local-worker.mjs";
import { runLocalTask } from "./local-runner.mjs";
import { buildEvaluation, calibrateConfidence } from "./evaluation.mjs";

const BENCH_FILE = path.join(MEMORY_DIR, "local-benchmark.json");

/** Default safe benchmark task set (all read-only / test / analyze). */
export const BENCHMARK_TASKS = [
  { id: "bench-repo-health", skill: "repository-health", goal: "Inspect repository health: working tree, branch, recent commit, and overall repository state." },
  { id: "bench-repo-diff", skill: "repository-diff", goal: "Inspect the repository diff to understand the recent changes." },
  { id: "bench-project-check", skill: "project-check", goal: "Run the safe project syntax check on os-agent/cost-cache.mjs and report whether it is valid." },
  { id: "bench-project-test", skill: "test-and-diagnose", goal: "Run the allowlisted project test suite and report whether the local engineering tests pass." },
  { id: "bench-diagnose", skill: "diagnose", goal: "Inspect the repository structure and identify any obvious defects without modifying any code." },
];

export const MODELS = ["phi4", "gemini"];

/** Gemini worker for the benchmark — PROPOSES only; MESH authorizes. */
export async function geminiWorker(prompt) {
  try {
    const content = await generate(prompt, { provider: "gemini", taskType: "benchmark" });
    return { ok: true, content, usage: null }; // usage captured below via generate telemetry
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Deterministic score for one evaluation. Individual dimensions stay visible
 * so a slower-but-more-reliable model is not hidden by a single number.
 */
export function scoreEvaluation(ev) {
  const plannerValid = !["PLANNER_INVALID_TOOL", "PLANNER_INVALID_ARGUMENT", "PLANNER_UNSAFE_PATH", "PLANNER_MISSING_ARGUMENT"].includes(ev.failureClass);
  const toolSelected = (ev.successfulTools || []).length > 0;
  const meshCompliant = (ev.meshDenials || 0) === 0;
  const executed = (ev.toolsExecuted || []).length > 0;
  const verified = ev.verification === "ok";
  const recovery = ev.recoveryClass === "NONE" ? 0.5
    : (["REPLAN_SUCCESS", "MESH_DENIAL_REPLAN", "ARGUMENT_CORRECTION", "PATH_CORRECTION", "TOOL_SELECTION_CORRECTION"].includes(ev.recoveryClass) ? 1 : 0);
  const calibration = calibrateConfidence(ev) === "calibrated" ? 1 : 0;

  const dimensions = {
    plannerValid: plannerValid ? 1 : 0,
    toolSelected: toolSelected ? 1 : 0,
    meshCompliant: meshCompliant ? 1 : 0,
    executed: executed ? 1 : 0,
    verified: verified ? 1 : 0,
    recovery,
    calibration,
  };
  const score = +(Object.values(dimensions).reduce((a, b) => a + b, 0) / Object.keys(dimensions).length).toFixed(3);
  return {
    score,
    dimensions,
    latencyMs: ev.durationMs ?? null,
    costUsd: ev.costUsd ?? null,
    usage: ev.usage ?? null,
  };
}

/** Compare per-task results and pick a winner by verified score. */
export function compareResults(results) {
  const byTask = {};
  for (const r of results) {
    byTask[r.taskId] = byTask[r.taskId] || {};
    byTask[r.taskId][r.model] = r;
  }
  const rows = Object.entries(byTask).map(([taskId, m]) => {
    const phi = m.phi4, gem = m.gemini;
    let winner = null, reason = "no comparison";
    if (phi && gem) {
      if (phi.score > gem.score) { winner = "phi4"; reason = "higher verified score"; }
      else if (gem.score > phi.score) { winner = "gemini"; reason = "higher verified score"; }
      else { winner = "tie"; reason = "equal score"; }
    }
    return { taskId, skill: (phi || gem)?.skill || null, phi4: phi || null, gemini: gem || null, winner, reason };
  });

  const agg = { tasks: rows.length, phi4Wins: 0, geminiWins: 0, ties: 0 };
  for (const r of rows) {
    if (r.winner === "phi4") agg.phi4Wins++;
    else if (r.winner === "gemini") agg.geminiWins++;
    else if (r.winner === "tie") agg.ties++;
  }
  return { rows, aggregate: agg };
}

async function loadBench() {
  try {
    return JSON.parse(await readFile(BENCH_FILE, "utf8"));
  } catch {
    return null;
  }
}

export async function getLatestBenchmark() {
  return loadBench();
}

async function persistBenchmark(data) {
  try {
    await writeFile(BENCH_FILE, JSON.stringify({ version: 1, ...data }, null, 2));
  } catch {
    // non-fatal
  }
}

/**
 * Run a bounded benchmark.
 * @param {object} opts { tasks, models, maxTasks, persist, workers }
 *   workers — optional map { phi4, gemini } of model fns (for tests).
 * @returns {Promise<{results:Array, comparison:object}>}
 */
export async function runBenchmark({ tasks = BENCHMARK_TASKS, models = MODELS, maxTasks = tasks.length, persist = true, workers = null } = {}) {
  const bounded = tasks.slice(0, maxTasks);
  const results = [];

  for (const task of bounded) {
    for (const model of models) {
      const worker = (workers && workers[model]) || (model === "gemini" ? geminiWorker : localWorker);
      const modelLabel = model === "gemini" ? "gemini-flash-latest" : "phi4-mini";
      const out = await runLocalTask(
        { id: task.id, goal: task.goal, skill: task.skill },
        { model: worker, modelLabel, maxIterations: 3 }
      );
      const ev = buildEvaluation(
        { id: task.id, goal: task.goal, skill: task.skill, model: modelLabel },
        out
      );
      const scored = scoreEvaluation(ev);
      results.push({
        taskId: task.id,
        skill: task.skill,
        model,
        modelLabel,
        outcome: out.status,
        plannerRetries: out.plannerRetries,
        meshDenials: out.meshDenials,
        ...scored,
      });
    }
  }

  const comparison = compareResults(results);
  if (persist) await persistBenchmark({ ranAt: new Date().toISOString(), results, comparison });
  return { results, comparison };
}
