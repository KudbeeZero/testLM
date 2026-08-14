// os-agent/start-ingestion.mjs
// ---------------------------------------------------------------------------
// Local launcher for the monorepo ingestion server (port 3000).
//
// Loads testLM/.env (same source the Gas Town dashboard uses) directly into
// this Node process, then spawns `npx tsx services/ingestion/server.js`.
//
// Why: the monorepo reads process.env directly (no dotenv in server.js), so we
// load the shared .env here and pass it through as real environment variables.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // testLM/
const MONOREPO = path.join(ROOT, "Kudbee-fuel-gage");
const ENV_FILE = path.join(ROOT, ".env");

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      let value = t.slice(eq + 1).trim();
      // Strip wrapping quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (e) {
    console.error(`[start-ingestion] failed to load ${file}:`, e?.message || e);
  }
}

loadEnvFile(ENV_FILE);
loadEnvFile(path.join(ROOT, "os-agent", ".env"));

const PORT = process.env.PORT || "3000";
console.log(`[start-ingestion] loading ${MONOREPO} server on port ${PORT}`);

// Ensure `node` (and npm/npx) resolve in child processes: server.js shells out to
// `exec('node scripts/...')`, which needs node on PATH.
const nodeDir = path.dirname(process.execPath);
const nodeIsOnPath = (process.env.PATH || "").split(";").some((p) => p.trim() && path.resolve(p.toLowerCase()) === nodeDir.toLowerCase());
if (!nodeIsOnPath) {
  process.env.PATH = `${nodeDir};${process.env.PATH || ""}`;
  console.log(`[start-ingestion] prepended ${nodeDir} to PATH for child processes`);
}

// Ensure we launch from the monorepo root so workspace packages resolve.
// Use `node <tsx>/dist/cli.mjs <server>` to avoid Windows .cmd shim issues.
const nodeBin = process.env.NODE_BIN || (process.platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "node");
const tsxCli = path.join(MONOREPO, "node_modules", "tsx", "dist", "cli.mjs");
const child = spawn(
  nodeBin,
  [tsxCli, "services/ingestion/server.js"],
  {
    cwd: MONOREPO,
    env: { ...process.env, PORT },
    windowsHide: true,
    stdio: "inherit",
  }
);

child.on("error", (e) => {
  console.error("[start-ingestion] spawn error:", e?.message || e);
  process.exit(1);
});

child.on("exit", (code) => {
  console.log(`[start-ingestion] server exited with code ${code}`);
  process.exit(code ?? 0);
});
