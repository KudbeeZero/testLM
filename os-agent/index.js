#!/usr/bin/env node
/**
 * Engineering OS Agent — keeps the machine optimized and always learning.
 *
 * Providers: local (LM Studio / Qwen3-8B), Gemini, or Grok (xAI).
 * Switch with MODEL_PROVIDER=local|gemini|grok in the workspace .env.
 *
 * Usage:
 *   node index.js              # maintenance + learning
 *   node index.js --learn-only # only run the learning step
 *   node index.js --maintain-only
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { AGENT_DIR, MEMORY_FILE, PROVIDER, providerLabel, LOCAL_MODEL } from "./src/config.js";
import { generate } from "./src/providers.js";
import { saveLearnings, closeDb } from "./src/db.js";
import { setState } from "./src/upstash.js";

const args = process.argv.slice(2);
const learnOnly = args.includes("--learn-only");
const maintainOnly = args.includes("--maintain-only");

function banner() {
  console.log("======================================");
  console.log("  Engineering OS Agent");
  console.log("  Provider: " + providerLabel());
  console.log("======================================");
}

function runMaintenance() {
  console.log("\n>> Step 1: Maintenance");
  const script = `${AGENT_DIR}\\maintain.ps1`;
  const out = execFileSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
  ], { encoding: "utf8" });
  console.log(out.trim());
}

function readMemory() {
  // Strip UTF-8 BOM (PowerShell writes one) before parsing.
  const raw = readFileSync(MEMORY_FILE, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function writeMemory(mem) {
  writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2), "utf8");
}

async function runLearning() {
  console.log("\n>> Step 2: Learning (using " + providerLabel() + ")");
  const mem = readMemory();
  const context = JSON.stringify(mem, null, 2);

  const prompt = `You are the learning engine for an engineering OS Agent on a local machine.
Analyze the following system memory (health, optimizations, and prior learnings)
and produce concrete learnings about how to keep THIS machine optimized.

System memory (JSON):
${context}

Return a JSON array of 2 to 4 new learning objects. Each object must have:
- "topic": short topic (e.g. "memory", "disk", "startup", "temp", "gpu")
- "insight": a concrete, actionable insight specific to this machine's data
- "recommendation": a specific action to take or monitor

Base your learnings on the actual health numbers. Do not repeat learnings that
already exist. Return ONLY the JSON array, no extra text.`;

  const text = await generate(prompt);

  // Extract JSON array (strip markdown fences / trailing text first).
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  let newLearnings = [];
  if (start >= 0 && end > start) {
    try {
      newLearnings = JSON.parse(cleaned.slice(start, end + 1));
    } catch (e) {
      console.warn("Could not parse JSON from model output.");
      console.warn(cleaned.slice(0, 500));
      return;
    }
  } else {
    console.warn("Could not extract JSON from model output.");
    console.warn(cleaned.slice(0, 500));
    return;
  }

  // Normalize array fields into individual learnings
  const existing = new Set(mem.learnings.map((l) => `${l.topic}|${l.insight}`));
  let added = 0;
  for (const l of newLearnings) {
    const topics = [].concat(l.topic);
    const insights = [].concat(l.insight);
    const recs = [].concat(l.recommendation || []);
    const count = Math.max(topics.length, insights.length);
    for (let i = 0; i < count; i++) {
      const topic = topics[Math.min(i, topics.length - 1)];
      const insight = insights[Math.min(i, insights.length - 1)];
      const rec = recs[Math.min(i, recs.length - 1)];
      if (!topic || !insight) continue;
      const key = `${topic}|${insight}`;
      if (!existing.has(key)) {
        mem.learnings.push({
          date: new Date().toISOString(),
          topic, insight, recommendation: rec ?? null,
        });
        existing.add(key);
        added++;
      }
    }
  }

  writeMemory(mem);
  console.log(`\nAdded ${added} new learning(s). Total learnings: ${mem.learnings.length}`);

  // Persist new learnings to the per-agent Neon database.
  const newRows = mem.learnings.slice(mem.learnings.length - added);
  if (added > 0 && newRows.length > 0) {
    try {
      await saveLearnings(newRows);
    } catch (e) {
      console.warn("[db] Failed to save learnings: " + e.message);
    }
  }

  // Mirror the full learning memory into Upstash Redis for fast access.
  try {
    await setState("learnings", mem.learnings);
    await setState("last_run", { date: new Date().toISOString(), provider: PROVIDER });
  } catch (e) {
    console.warn("[upstash] Failed to mirror memory: " + e.message);
  }
}

banner();
if (!learnOnly) runMaintenance();
if (!maintainOnly) await runLearning();
await closeDb();
console.log("\nOS Agent run complete.");
