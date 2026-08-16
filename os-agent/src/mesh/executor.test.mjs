import { test, expect, beforeAll } from "bun:test";
import { meshGate } from "./index.mjs";
import { resolveWorkspacePath, isDeniedPath, isPathInsideWorkspace } from "./workspace.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AUDIT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dashboard", "mesh-audit.log");

// A helper to build a minimal ToolRequest.
const req = (tool, args = {}, agentId = "local-operator") => ({
  id: "t-" + Math.random().toString(36).slice(2, 8),
  agentId,
  tool,
  arguments: args,
});

beforeAll(async () => {
  // Ensure the audit file exists so we can assert on it.
  try { await readFile(AUDIT_FILE, "utf8"); } catch { /* will be created on first audit */ }
});

// ── ALLOWED ────────────────────────────────────────────────────────────────
test("file.read reads an approved file inside the workspace", async () => {
  const r = await meshGate(req("file.read", { path: "os-agent/package.json" }));
  expect(r.decision).toBe("allow");
  expect(r.success).toBe(true);
  expect(r.result.output).toContain('"name": "os-agent"');
});

test("filesystem.list lists an approved directory", async () => {
  const r = await meshGate(req("filesystem.list", { path: "os-agent" }));
  expect(r.decision).toBe("allow");
  expect(r.success).toBe(true);
  expect(r.result.output).toContain("package.json");
});

test("git.status runs", async () => {
  const r = await meshGate(req("git.status", { path: "." }));
  expect(r.decision).toBe("allow");
  expect(r.success).toBe(true);
});

test("git.diff runs", async () => {
  const r = await meshGate(req("git.diff", { path: "." }));
  expect(r.decision).toBe("allow");
  expect(r.success).toBe(true);
});

test("project.check runs node --check on an approved file", async () => {
  const r = await meshGate(req("project.check", { file: "os-agent/cost-cache.mjs", path: "." }));
  expect(r.decision).toBe("allow");
  expect(r.success).toBe(true);
});

// ── DENIED ────────────────────────────────────────────────────────────────
test("../ escape is denied", async () => {
  const r = await meshGate(req("file.read", { path: "../../../.env" }));
  expect(r.success).toBe(false);
  expect(r.reason).toMatch(/outside workspace|denied/);
});

test("absolute path outside workspace is denied", async () => {
  const r = await meshGate(req("file.read", { path: "C:/Windows/win.ini" }));
  expect(r.success).toBe(false);
  expect(r.reason).toMatch(/outside workspace/);
});

test(".env read is denied (secret material)", async () => {
  const r = await meshGate(req("file.read", { path: ".env" }));
  expect(r.success).toBe(false);
  expect(r.reason).toMatch(/denied/);
});

test("credential file read is denied", async () => {
  const r = await meshGate(req("file.read", { path: "think-coonnect.pem" }));
  expect(r.success).toBe(false);
  expect(r.reason).toMatch(/denied/);
});

test("unknown tool is denied", async () => {
  const r = await meshGate(req("shell.exec", { command: "rm -rf /" }));
  expect(r.success).toBe(false);
  expect(r.reason).toMatch(/unknown tool/);
});

test("sudo is not a tool (denied)", async () => {
  const r = await meshGate(req("sudo.exec", { command: "whoami" }));
  expect(r.success).toBe(false);
});

test("project.test with a non-allowlisted suite is denied", async () => {
  const r = await meshGate(req("project.test", { suite: "rm:all" }));
  expect(r.success).toBe(false);
  expect(r.reason).toMatch(/test suite not allowed/);
});

// ── MALFORMED / FAILURE ──────────────────────────────────────────────────
test("malformed request (missing tool) fails safely", async () => {
  const r = await meshGate(req(undefined, {}));
  expect(r.success).toBe(false);
  expect(r.reason).toMatch(/unknown tool/);
});

test("executor failure does not crash the gate", async () => {
  // file.read of a nonexistent file inside the workspace → handled error, not throw.
  const r = await meshGate(req("file.read", { path: "os-agent/does-not-exist-xyz.mjs" }));
  expect(r.decision).toBe("allow"); // capability/risk passed
  expect(r.success).toBe(false);    // execution failed but gate survived
});

// ── WORKSPACE / AUDIT UNIT CHECKS ─────────────────────────────────────────
test("workspace boundary helpers behave", () => {
  expect(isPathInsideWorkspace("os-agent/package.json")).toBe(true);
  expect(isPathInsideWorkspace("../.env")).toBe(false);
  expect(isPathInsideWorkspace("C:/Windows/win.ini")).toBe(false);
  expect(isDeniedPath(".env")).toBe(true);
  expect(isDeniedPath("think-coonnect.pem")).toBe(true);
  expect(() => resolveWorkspacePath("../.env")).toThrow();
});

test("every gate call writes an audit entry", async () => {
  const before = (await readFile(AUDIT_FILE, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  await meshGate(req("git.status", { path: "." }));
  await meshGate(req("file.read", { path: ".env" })); // denied — still audited
  const after = (await readFile(AUDIT_FILE, "utf8")).split("\n").filter(Boolean).length;
  expect(after).toBeGreaterThanOrEqual(before + 2);
});
