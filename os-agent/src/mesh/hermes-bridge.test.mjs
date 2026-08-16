import { test, expect } from "bun:test";
import { runHermesToolTask } from "./hermes-bridge.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AUDIT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dashboard", "mesh-audit.log");

const hermesTask = (tool, args = {}, taskId = "hermes-task-1") => ({
  id: "h-" + Math.random().toString(36).slice(2, 8),
  agentId: "hermes",
  taskId,
  tool,
  arguments: args,
  risk: "L0",
});

test("HERMES can run git.status through MESH (allowed)", async () => {
  const r = await runHermesToolTask(hermesTask("git.status", {}, "hermes-git-status"));
  expect(r.decision).toBe("allow");
  expect(r.success).toBe(true);
  expect(r.evidence).toBeDefined();
  expect(r.evidence.tool).toBe("git.status");
  expect(r.evidence.verification).toBe("ok");
  expect(r.evidence.auditId).toBeTruthy();
});

test("HERMES can run project.check through MESH (allowed)", async () => {
  const r = await runHermesToolTask(hermesTask("project.check", { file: "os-agent/cost-cache.mjs", path: "." }, "hermes-check"));
  expect(r.decision).toBe("allow");
  expect(r.success).toBe(true);
});

test("HERMES cannot bypass MESH with a raw shell tool", async () => {
  const r = await runHermesToolTask(hermesTask("shell.exec", { command: "rm -rf /" }));
  expect(r.success).toBe(false);
  expect(r.decision).toBe("deny");
  expect(r.reason).toMatch(/unknown tool/);
});

test("HERMES cannot read .env (secret boundary enforced)", async () => {
  const r = await runHermesToolTask(hermesTask("file.read", { path: ".env" }));
  expect(r.success).toBe(false);
  expect(r.reason).toMatch(/denied/);
});

test("HERMES cannot escape the workspace", async () => {
  const r = await runHermesToolTask(hermesTask("file.read", { path: "../../../.env" }));
  expect(r.success).toBe(false);
  expect(r.reason).toMatch(/outside workspace|denied/);
});

test("HERMES cannot request a non-enabled capability", async () => {
  // filesystem.write is not in the enabled set for hermes → denied.
  const r = await runHermesToolTask(hermesTask("filesystem.write", { path: "x", content: "y" }));
  expect(r.success).toBe(false);
  expect(r.reason).toMatch(/missing capability|unknown tool/);
});

test("HERMES evidence is recorded for allowed and denied actions", async () => {
  const before = (await readFile(AUDIT_FILE, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  await runHermesToolTask(hermesTask("git.status", {}, "hermes-evidence-ok"));
  await runHermesToolTask(hermesTask("shell.exec", { command: "whoami" }, "hermes-evidence-deny"));
  const after = (await readFile(AUDIT_FILE, "utf8")).split("\n").filter(Boolean).length;
  expect(after).toBeGreaterThanOrEqual(before + 2);
});

test("HERMES survives executor failure (no crash)", async () => {
  const r = await runHermesToolTask(hermesTask("file.read", { path: "os-agent/nope-xyz.mjs" }));
  expect(r.decision).toBe("allow"); // capability/risk passed
  expect(r.success).toBe(false);    // execution failed, bridge survived
  expect(r.evidence.verification).toBe("failed");
});
