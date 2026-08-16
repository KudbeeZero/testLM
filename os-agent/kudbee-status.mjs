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
import { getCostText } from "./cost-cache.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function run(cmd, args, opts = {}) {
  try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 60000, ...opts }); }
  catch (e) { return null; }
}

// Cost comes from the server-side cache (24h TTL / manual cooldown) — this
// never calls Cost Explorer directly, so /api/ops no longer costs money.
async function awsCost() {
  return await getCostText();
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
