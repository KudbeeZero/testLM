/**
 * tool-contracts.mjs — machine-readable tool contracts for the planner.
 *
 * The planner receives the EXACT tool contract (not vague prose), so it can
 * select tools that already exist and are already authorized. Validation
 * rejects unknown tools, raw command fields, and malformed arguments before
 * anything reaches MESH. MESH remains the final authority.
 */
import { isPathInsideWorkspace } from "./workspace.mjs";

export const TOOL_CONTRACTS = {
  "git.status": {
    purpose: "Inspect repository status.",
    arguments: {},
    risk: "L0",
    capability: "git.read",
  },
  "git.diff": {
    purpose: "Inspect repository diff (stat).",
    arguments: {},
    risk: "L0",
    capability: "git.read",
  },
  "project.check": {
    purpose: "Run safe JavaScript syntax validation.",
    arguments: { file: "workspace-relative path to a .js or .mjs file (e.g. os-agent/cost-cache.mjs)" },
    risk: "L0",
    capability: "project.check",
  },
  "project.test": {
    purpose: "Run an allowlisted test suite.",
    arguments: { suite: "EXACTLY the string 'bun:test' (the only allowlisted suite)" },
    risk: "L1",
    capability: "project.test",
  },
  "file.read": {
    purpose: "Read an approved file inside the workspace.",
    arguments: { path: "workspace-relative path" },
    risk: "L0",
    capability: "filesystem.read",
  },
  "filesystem.list": {
    purpose: "List an approved directory.",
    arguments: { path: "workspace-relative path (default .)" },
    risk: "L0",
    capability: "filesystem.list",
  },
  "filesystem.search": {
    purpose: "Search files in the workspace for a term.",
    arguments: { term: "search term" },
    risk: "L0",
    capability: "filesystem.search",
  },
};

// os-agent uses bun; npm:test has no script and would fail. Only bun:test works.
export const ALLOWED_TEST_SUITES = ["bun:test"];

/** Format the tool contracts as a compact text block for the planner prompt. */
export function toolSchemaText() {
  return Object.entries(TOOL_CONTRACTS)
    .map(([name, c]) => {
      const args = Object.entries(c.arguments).map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  (none)";
      return `${name}\n  purpose: ${c.purpose}\n  arguments:\n${args}\n  risk: ${c.risk}\n  capability: ${c.capability}`;
    })
    .join("\n\n");
}

/**
 * Validate a planner proposal BEFORE MESH.
 * @returns {{ok:boolean, reason?:string, tool?:string}}
 */
export function validateProposal(proposal) {
  if (!proposal || typeof proposal !== "object") return { ok: false, reason: "malformed proposal" };
  const tool = proposal.tool;
  if (!tool || typeof tool !== "string") return { ok: false, reason: "no tool" };
  if (!TOOL_CONTRACTS[tool]) return { ok: false, reason: "unknown tool: " + tool };
  // Reject any raw-command / executable fields.
  const args = proposal.arguments || {};
  if (typeof args !== "object") return { ok: false, reason: "arguments must be an object" };
  for (const bad of ["command", "exec", "shell", "cmd", "script"]) {
    if (bad in proposal || bad in args) return { ok: false, reason: "raw command field present: " + bad };
  }
  // project.test suite must be allowlisted.
  if (tool === "project.test") {
    const suite = args.suite;
    if (!ALLOWED_TEST_SUITES.includes(suite)) return { ok: false, reason: "test suite not allowlisted: " + suite };
  }
  // project.check requires a file argument.
  if (tool === "project.check") {
    if (typeof args.file !== "string" || !args.file.trim()) return { ok: false, reason: "project.check requires a file argument" };
  }
  // Path/file arguments must be workspace-relative and inside the workspace.
  for (const key of ["path", "file"]) {
    if (args[key] !== undefined) {
      if (typeof args[key] !== "string" || !args[key].trim()) return { ok: false, reason: key + " argument required" };
      if (!isPathInsideWorkspace(args[key])) return { ok: false, reason: key + " outside workspace: " + args[key] };
    }
  }
  // filesystem.search requires a non-empty term.
  if (tool === "filesystem.search") {
    if (typeof args.term !== "string" || !args.term.trim()) return { ok: false, reason: "search term required" };
  }
  return { ok: true, tool };
}
