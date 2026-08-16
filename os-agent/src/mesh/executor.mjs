/**
 * executor.mjs — MESH tool dispatcher.
 *
 * This is NOT a general shell executor. Each `tool` maps to a specific
 * handler that validates structured arguments and runs an explicitly
 * allowlisted command via execFile (exe + args array) — never a concatenated
 * shell string. The model proposes a tool; MESH authorizes it; the dispatcher
 * executes it; the result is returned as structured evidence for RDTHINK.
 */
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath, workspaceRoot } from "./workspace.mjs";

function run(exe, args, { cwd, timeoutMs } = {}) {
  return new Promise((resolve) => {
    execFile(exe, args, {
      cwd,
      timeout: timeoutMs || 30000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({
        exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout || ""),
        stderr: String(err ? (err.stderr || "") : (stderr || "")),
      });
    });
  });
}

// --- Tool handlers (structured, allowlisted) ------------------------------

const handlers = {
  "file.read": async (args) => {
    const p = resolveWorkspacePath(args.path);
    const content = await readFile(p, "utf8");
    return { evidence: { path: p, bytes: Buffer.byteLength(content) }, output: content.slice(0, 200000) };
  },

  "filesystem.list": async (args) => {
    const p = resolveWorkspacePath(args.path || ".");
    const entries = await readdir(p, { withFileTypes: true });
    return {
      evidence: { path: p, count: entries.length },
      output: entries.map((e) => (e.isDirectory() ? "[d] " : "[f] ") + e.name).join("\n"),
    };
  },

  "filesystem.search": async (args) => {
    const term = String(args.term || "");
    if (!term) throw new Error("search term required");
    const cwd = workspaceRoot();
    const r = await run("rg", ["--no-heading", "-l", term, cwd], { cwd, timeoutMs: args.timeoutMs });
    return { evidence: { term, cwd }, output: r.stdout, exitCode: r.exitCode, stderr: r.stderr };
  },

  "git.status": async (args) => {
    const cwd = resolveWorkspacePath(args.path || ".");
    const r = await run("git", ["status", "--short"], { cwd, timeoutMs: args.timeoutMs });
    return { evidence: { cwd }, output: r.stdout, exitCode: r.exitCode, stderr: r.stderr };
  },

  "git.diff": async (args) => {
    const cwd = resolveWorkspacePath(args.path || ".");
    const r = await run("git", ["diff", "--stat"], { cwd, timeoutMs: args.timeoutMs });
    return { evidence: { cwd }, output: r.stdout, exitCode: r.exitCode, stderr: r.stderr };
  },

  "project.check": async (args) => {
    const file = String(args.file || "");
    if (!file) throw new Error("file required for node --check");
    const target = resolveWorkspacePath(file);
    const cwd = resolveWorkspacePath(args.path || ".");
    const r = await run("node", ["--check", target], { cwd, timeoutMs: args.timeoutMs });
    return { evidence: { file: target }, output: r.stdout, exitCode: r.exitCode, stderr: r.stderr };
  },

  "project.test": async (args) => {
    // ALLOWLISTED test command only — structural, no arbitrary command string.
    const cwd = resolveWorkspacePath(args.path || ".");
    const suite = String(args.suite || "");
    const allowed = {
      // Hermetic local engineering tests (no external DB/network) for the
      // bounded overnight loop. Only bun:test works in os-agent.
      "bun:test": ["bun", "test", "src/mesh/"],
    };
    if (!allowed[suite]) throw new Error("test suite not allowed: " + suite);
    const [exe, ...rest] = allowed[suite];
    const r = await run(exe, rest, { cwd, timeoutMs: args.timeoutMs || 60000 });
    return { evidence: { suite, cwd }, output: r.stdout, exitCode: r.exitCode, stderr: r.stderr };
  },
};

/**
 * Execute a MESH-authorized tool request. Returns a structured ToolResult.
 * Never throws out of the boundary — failures are captured in the result.
 */
export async function executeTool(request) {
  const handler = handlers[request.tool];
  if (!handler) return { success: false, error: "unknown tool: " + request.tool, exitCode: 1, evidence: {} };
  const t0 = Date.now();
  try {
    const result = await handler(request.arguments || {});
    return {
      ...result,
      success: result.exitCode == null ? true : result.exitCode === 0,
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      success: false,
      error: String((e && e.message) || e),
      exitCode: 1,
      durationMs: Date.now() - t0,
      evidence: {},
    };
  }
}
