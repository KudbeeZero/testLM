#!/usr/bin/env node
/**
 * os-agent/kudbee-status.mjs — one-command operational view.
 *
 * Runs the system health checks (operator-verify) plus an AWS cost summary,
 * so you can monitor the whole box from the terminal/SSH in one command.
 * Read-only, credential-free (presence/status only).
 *
 * Usage: node kudbee-status.mjs
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function run(cmd, args, opts = {}) {
  try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 60000, ...opts }); }
  catch (e) { return null; }
}

async function awsCost() {
  // Read-only AWS cost summary for the current month + last 24h.
  const month = new Date().toISOString().slice(0, 7) + "-01";
  const end = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const m = run("aws", ["ce", "get-cost-and-usage",
    "--time-period", `Start=${month},End=${end}`,
    "--granularity", "MONTHLY", "--metrics", "UnblendedCost"]);
  if (!m) return "AWS session unavailable (run 'aws login')";
  try {
    const d = JSON.parse(m);
    const amt = d.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount;
    return `month-to-date $${amt ? parseFloat(amt).toFixed(2) : "?"}`;
  } catch { return "AWS cost parse error"; }
}

async function main() {
  console.log("════════ KUDBEE STATUS ════════");
  console.log("── System health ──");
  try {
    const out = execFileSync("node", [join(__dirname, "operator-verify.mjs")], { encoding: "utf8", timeout: 60000 });
    console.log(out);
  } catch (e) { console.log("operator-verify failed:", e.message); }
  console.log("── AWS cost ──");
  console.log("  " + (await awsCost()));
  console.log("════════════════════════════════");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
